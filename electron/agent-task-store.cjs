/**
 * B3a · DX OS 任务域持久层（移植自 DX OS 0.5.1 server/taskStore.ts，1069 行）。
 *
 * ## 来源
 *   server/taskStore.ts（逐函数移植，函数名与语义逐字对应；行号见各函数处注释）。
 *
 * ## 表名映射（其余表名不变）
 *   tasks       -> dx_tasks
 *   task_steps  -> dx_task_steps
 *   task_events -> dx_task_events
 *   threads / thread_messages / task_plans / task_checkpoints / deliverables /
 *   tool_operations / task_observations / worker_instances / project_memories /
 *   agent_turns / agent_checkpoints / agent_runs / task_attempts 等沿用 v22 既有表。
 *
 * ## projects / project_members 语义映射（Lead 既定，硬约束禁止改既有表结构）
 *   · DX projects.created_by  -> OpenArc projects.owner_user_id
 *   · DX projects.root_node_id -> **新桥接表 dx_project_roots**（OpenArc projects 没有该列，
 *     且禁止改列；根节点 id 是 fs.ts 虚拟文件树（B6）的坐标，必须持久化，否则 createProject /
 *     projectForRoot / projectSnapshot 无法落位，只能伪造成功 —— 故选新增一张映射表）。
 *   · DX projects.name/created_at/updated_at 同名直用；organization_id 默认 'local'，
 *     scope 默认 'PERSONAL'，status 固定 'active'，description 默认 ''。
 *   · DX project_members.role 'owner'  -> OpenArc 'manager'
 *     DX project_members.role 'member' -> OpenArc 'editor'
 *     反向读取时 'manager' -> 'owner'，其余 -> 'member'。
 *   · DX project_members.can_create_tasks（没有对应列）-> 由 OpenArc role 推导：
 *     role IN ('editor','manager') 视为 1，'viewer' 视为 0。
 *
 * ## 数据库句柄与依赖注入
 *   configureAgentTaskStore({ db, fsAdapter, clock, idFactory })
 *     · db        —— node:sqlite DatabaseSync（prepare/run/get/all，run() 返回 {lastInsertRowid,changes}）；
 *     · fsAdapter —— 可选；fs.ts 虚拟文件树属 B6，注入 { createNode, findByPath, getNode, setContent,
 *                    isWithinRoot }。未注入时依赖它的函数（verifyTask / 项目快照）返回/抛出结构化
 *                    AGENT_DEPENDENCY_UNAVAILABLE，绝不假装成功；
 *     · clock / idFactory —— 可选，默认 Date.now / randomUUID。
 *   resetAgentTaskStoreForTests() —— 清空注入，供测试隔离。
 *
 * ## 与源不同的点（有意为之，其余逐字）
 *   · better-sqlite3 的 ccsDb.transaction(fn) / .inTransaction 换成模块内 writeTransaction()：
 *     已在事务内则直接执行，否则 BEGIN IMMEDIATE / COMMIT / ROLLBACK；
 *   · 源里所有 apiQuota / 云计费调用：本文件不存在（任务域本就不含计费）。
 */
"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { AGENT_CHECKPOINT_SCHEMA } = require("./agent-checkpoint-contract.cjs");

/** 依赖后续批次时的结构化错误码。 */
const AGENT_DEPENDENCY_UNAVAILABLE = "AGENT_DEPENDENCY_UNAVAILABLE";

/** OpenArc projects 的默认值（映射规则见文件头）。 */
const DEFAULT_ORGANIZATION_ID = "local";
const DEFAULT_PROJECT_SCOPE = "PERSONAL";

/** taskStore.ts:6 —— TaskStatus 11 态。 */
const TASK_STATUSES = Object.freeze([
  "queued",
  "planning",
  "running",
  "verifying",
  "completed",
  "waiting_user",
  "waiting_children",
  "paused",
  "interrupted",
  "failed",
  "cancelled",
]);

/** taskStore.ts:26 —— AssistantMode 3 态。 */
const ASSISTANT_MODES = Object.freeze(["assistant", "thinking", "agent"]);

/** taskStore.ts:360 */
const DEFAULT_BUDGET = Object.freeze({ maxModelCalls: null, maxToolCalls: null });
/** taskStore.ts:361 */
const DEFAULT_TREE_BUDGET = Object.freeze({ maxModelCalls: 40, maxToolCalls: 120 });
/** taskStore.ts:929 */
const WRITE_TOOLS = new Set(["file.create", "file.write", "fs_create", "fs_write", "fs_append", "fs_edit"]);

// ---------------------------------------------------------------------------
// 模块级注入（taskStore.ts 用模块级 ccsDb / now / randomUUID，这里改成可注入）
// ---------------------------------------------------------------------------

let agentDb = null;
let agentFs = null;
let agentClock = () => Date.now();
let agentIdFactory = () => randomUUID();

/** 注入数据库句柄 / fs 适配器 / 时钟 / id 工厂。返回当前 db。 */
function configureAgentTaskStore(options) {
  const opts = options || {};
  if (opts.db) agentDb = opts.db;
  if (Object.prototype.hasOwnProperty.call(opts, "fsAdapter")) agentFs = opts.fsAdapter || null;
  if (typeof opts.clock === "function") agentClock = opts.clock;
  if (typeof opts.idFactory === "function") agentIdFactory = opts.idFactory;
  return agentDb;
}

/** 测试隔离：清空全部注入。 */
function resetAgentTaskStoreForTests() {
  agentDb = null;
  agentFs = null;
  agentClock = () => Date.now();
  agentIdFactory = () => randomUUID();
}

/** 供 agent-project-snapshot.cjs 取同一份 fs 适配器。 */
function getAgentFsAdapter() {
  return agentFs;
}

function getAgentTaskDb() {
  if (!agentDb) {
    const error = new Error("agent-task-store 未注入数据库句柄（configureAgentTaskStore({ db })）");
    error.code = AGENT_DEPENDENCY_UNAVAILABLE;
    error.dependency = "db";
    throw error;
  }
  return agentDb;
}

function now() {
  return agentClock();
}

function json(value) {
  return JSON.stringify(value === null || value === undefined ? null : value);
}

function hashInput(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 源 writeTransaction(): taskStore.ts:39-41。
 * better-sqlite3 的 ccsDb.inTransaction / ccsDb.transaction(fn).immediate() 在这里等价实现：
 * 已在事务里就直接跑（让 CREATE/追加事件与调用方同属一个事务），否则开一个 BEGIN IMMEDIATE。
 */
function writeTransaction(work) {
  const db = getAgentTaskDb();
  if (db.isTransaction || db.inTransaction) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = work();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 已回滚 */
    }
    throw error;
  }
}

/** 源 ccsDb.transaction(fn)()：返回一个可调用包装。 */
function transaction(work) {
  return function runTransaction() {
    return writeTransaction(() => work.apply(null, arguments));
  };
}

/** 依赖 B6 的结构化错误结果（verifyTask 这类返回 bool/对象的函数用）。 */
function dependencyUnavailableResult(fnName, dependency) {
  return {
    ok: false,
    code: AGENT_DEPENDENCY_UNAVAILABLE,
    dependency,
    message: fnName + " 依赖 " + dependency + "（后续批次），当前未注入适配器，不能假装成功",
  };
}

/** fsAdapter 缺哪几个方法就视为不可用。 */
function fsAdapterMissing(fs, methods) {
  if (!fs) return true;
  return methods.some((name) => typeof fs[name] !== "function");
}

// ---------------------------------------------------------------------------
// projects / project_members 映射（见文件头）
// ---------------------------------------------------------------------------

function dxRoleToOpenArc(role) {
  return role === "owner" ? "manager" : "editor";
}

function openArcRoleToDxCanCreate(role) {
  return role === "editor" || role === "manager" ? 1 : 0;
}

/** 统一的 ProjectRow 投影：把 OpenArc projects + dx_project_roots 还原成 DX 的 ProjectRow 形态。 */
const PROJECT_SELECT =
  "SELECT p.id AS id, p.name AS name, COALESCE(r.root_node_id, '') AS root_node_id, " +
  "p.owner_user_id AS created_by, p.created_at AS created_at, p.updated_at AS updated_at " +
  "FROM projects p LEFT JOIN dx_project_roots r ON r.project_id = p.id ";

/** taskStore.ts:43 */
function projectForRoot(rootNodeId) {
  const db = getAgentTaskDb();
  return db.prepare(PROJECT_SELECT + "WHERE r.root_node_id = ?").get(rootNodeId);
}

/** taskStore.ts:47 */
function createProject(input) {
  const db = getAgentTaskDb();
  const existing = projectForRoot(input.rootNodeId);
  if (existing) {
    requireProjectAccess(existing.id, input.createdBy);
    return existing;
  }
  const id = agentIdFactory();
  const ts = now();
  writeTransaction(() => {
    db.prepare(
      "INSERT INTO projects(id,organization_id,department_id,owner_user_id,name,description,status,scope,created_at,updated_at) " +
        "VALUES (?,?,?,?,?,?,'active','PERSONAL',?,?)",
    ).run(id, DEFAULT_ORGANIZATION_ID, null, input.createdBy, input.name.trim() || "未命名项目", "", ts, ts);
    db.prepare("INSERT INTO dx_project_roots(project_id,root_node_id,created_at) VALUES (?,?,?)").run(id, input.rootNodeId, ts);
    db.prepare("INSERT INTO project_members(project_id,user_id,role,created_at) VALUES (?,?,?,?)").run(id, input.createdBy, dxRoleToOpenArc("owner"), ts);
  });
  return getProject(id);
}

/** taskStore.ts:64 */
function getProject(id) {
  const db = getAgentTaskDb();
  return db.prepare(PROJECT_SELECT + "WHERE p.id = ?").get(id);
}

/** taskStore.ts:68 */
function listProjects(userId) {
  const db = getAgentTaskDb();
  return db
    .prepare(
      "SELECT p.id AS id, p.name AS name, COALESCE(r.root_node_id, '') AS root_node_id, p.owner_user_id AS created_by, p.created_at AS created_at, p.updated_at AS updated_at " +
        "FROM projects p JOIN project_members m ON m.project_id=p.id LEFT JOIN dx_project_roots r ON r.project_id = p.id " +
        "WHERE m.user_id=? ORDER BY p.updated_at DESC",
    )
    .all(userId);
}

/** taskStore.ts:73 —— 返回 DX 形态 role + 由 OpenArc role 推导的 can_create_tasks。 */
function projectPermission(projectId, userId) {
  const db = getAgentTaskDb();
  const row = db.prepare("SELECT role FROM project_members WHERE project_id=? AND user_id=?").get(projectId, userId);
  if (!row) return undefined;
  const role = String(row.role);
  return {
    role: role === "manager" ? "owner" : "member",
    can_create_tasks: openArcRoleToDxCanCreate(role),
  };
}

/** taskStore.ts:79 */
function ensureProjectMember(projectId, userId, role) {
  const db = getAgentTaskDb();
  const dxRole = role || "member";
  db.prepare("INSERT OR IGNORE INTO project_members(project_id,user_id,role,created_at) VALUES (?,?,?,?)").run(
    projectId,
    userId,
    dxRoleToOpenArc(dxRole),
    now(),
  );
}

/** taskStore.ts:84 */
function requireProjectAccess(projectId, userId, createTask) {
  const permission = projectPermission(projectId, userId);
  if (!permission || (createTask && !permission.can_create_tasks)) throw new Error("没有该项目的任务权限");
  return permission;
}

/** taskStore.ts:90 */
function createThread(projectId, title, createdBy, visibility) {
  const db = getAgentTaskDb();
  const id = agentIdFactory();
  const ts = now();
  db.prepare("INSERT INTO threads(id,project_id,title,visibility,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
    id,
    projectId,
    title === undefined ? "新对话" : title,
    visibility === undefined ? "project" : visibility,
    createdBy || null,
    ts,
    ts,
  );
  return db.prepare("SELECT * FROM threads WHERE id = ?").get(id);
}

/** taskStore.ts:98 */
function titleFor(instruction) {
  return instruction.trim().replace(/\s+/g, " ").slice(0, 40) || "未命名任务";
}

/** taskStore.ts:102 */
function normalizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const raw = item;
    const tool = String(raw.tool || "");
    const path = String(raw.path || "").trim();
    if (!["file.read", "file.create", "file.write"].includes(tool) || !path) return [];
    const action = { tool: tool, path: path };
    if (raw.content !== undefined) action.content = String(raw.content);
    return [action];
  });
}

/** taskStore.ts:115（M2 基础 Harness 只执行确定的文件动作）。 */
function actionsFromRequest(instruction, rawActions) {
  const explicit = normalizeActions(rawActions);
  if (explicit.length) return explicit;
  if (/(创建|新建|建立一个?)?\s*(文件夹|目录|子文件夹|目录结构)/.test(instruction)) return [];
  const quoted = instruction.match(/[「“\"]([^」”\"]+)[」”\"]/);
  const path = quoted && quoted[1] ? quoted[1].trim() : undefined;
  const contentMatch = instruction.match(/(?:内容[为是：:]|写入[：:]|内容：)\s*([\s\S]+)$/);
  const content = contentMatch && contentMatch[1] ? contentMatch[1].trim() : undefined;
  if (!path) return [];
  if (/读取|查看|读(?:取)?文件/.test(instruction)) return [{ tool: "file.read", path: path }];
  if (/创建|新建/.test(instruction)) return [{ tool: "file.create", path: path, content: content || "" }];
  if (/写入|覆盖|更新|修改/.test(instruction)) return [{ tool: "file.write", path: path, content: content || "" }];
  return [];
}

/** taskStore.ts:131 */
function createTask(input) {
  const db = getAgentTaskDb();
  const project = getProject(input.projectId);
  if (!project) throw new Error("项目不存在");
  requireProjectAccess(project.id, input.createdBy, true);
  const thread = input.threadId
    ? db.prepare("SELECT id, project_id FROM threads WHERE id = ?").get(input.threadId)
    : createThread(project.id, titleFor(input.instruction), input.createdBy);
  if (!thread || thread.project_id !== project.id) throw new Error("对话不属于该项目");
  const actions = input.executionProfile === "agent" ? [] : actionsFromRequest(input.instruction, input.actions);
  const id = agentIdFactory();
  const ts = now();
  const planId = agentIdFactory();
  const parent = input.parentTaskId
    ? db.prepare("SELECT id,project_id,root_task_id,delegation_depth FROM dx_tasks WHERE id=?").get(input.parentTaskId)
    : undefined;
  if (input.parentTaskId && (!parent || parent.project_id !== project.id)) throw new Error("父任务不存在或不属于当前项目");
  const rootTaskId = input.rootTaskId || (parent && parent.root_task_id) || (parent && parent.id) || id;
  const delegationDepth = input.delegationDepth === undefined || input.delegationDepth === null ? (parent ? parent.delegation_depth + 1 : 0) : input.delegationDepth;
  const mode = actions.length ? "actions" : "react";
  transaction(() => {
    db.prepare("UPDATE threads SET title=CASE WHEN title='新对话' THEN ? ELSE title END, updated_at=? WHERE id=?").run(
      titleFor(input.instruction),
      ts,
      thread.id,
    );
    db.prepare(
      "INSERT INTO dx_tasks(id,project_id,thread_id,title,instruction,status,mode,execution_profile,preferred_provider_id,preferred_llm_model,preferred_image_provider_id,preferred_image_model,created_by,created_at,updated_at,parent_task_id,root_task_id,agent_profile_id,delegated_by_run_id,depends_on_json,expected_output_schema,permission_grant_json,delegation_depth) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      project.id,
      thread.id,
      (input.title && input.title.trim()) || titleFor(input.instruction),
      input.instruction,
      "queued",
      mode,
      input.executionProfile || "thinking",
      (input.preferences && input.preferences.providerId) || null,
      (input.preferences && input.preferences.llmModel) || null,
      (input.preferences && input.preferences.imageProviderId) || null,
      (input.preferences && input.preferences.imageModel) || null,
      input.createdBy,
      ts,
      ts,
      input.parentTaskId || null,
      rootTaskId,
      input.agentProfileId || null,
      input.delegatedByRunId || null,
      json(input.dependsOn || []),
      input.expectedOutputSchema === undefined ? null : json(input.expectedOutputSchema),
      json(input.permissionGrant || []),
      delegationDepth,
    );
    if (input.recordUserMessage !== false) {
      db.prepare("INSERT INTO thread_messages(id,thread_id,task_id,role,content,created_at) VALUES (?,?,?,?,?,?)").run(
        agentIdFactory(),
        thread.id,
        id,
        "user",
        (input.userMessage && input.userMessage.trim()) || input.instruction,
        ts,
      );
    }
    db.prepare("INSERT INTO task_plans(id,task_id,goal,assumptions,acceptance,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
      planId,
      id,
      input.instruction,
      "[]",
      json(actions.map((action) => "完成 " + action.tool + " " + action.path)),
      ts,
      ts,
    );
    const step = db.prepare(
      "INSERT INTO dx_task_steps(id,task_id,ordinal,title,tool_name,input_json,status,operation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    actions.forEach((action, ordinal) => {
      step.run(agentIdFactory(), id, ordinal + 1, action.tool + " " + action.path, action.tool, json(action), "queued", id + ":" + (ordinal + 1), ts);
    });
    appendTaskEvent(
      id,
      "task.created",
      input.executionProfile === "agent" ? "Agent 已进入后台队列" : mode === "actions" ? "任务已进入队列" : "思考模式已开始处理",
      { mode: mode, executionProfile: input.executionProfile || "thinking", actions: actions.length },
    );
  })();
  return getTask(id);
}

/** taskStore.ts:177 —— 记录一轮对话式问答（不产生后台任务）。 */
function recordConversation(input) {
  const db = getAgentTaskDb();
  const project = getProject(input.projectId);
  if (!project) throw new Error("项目不存在");
  requireProjectAccess(project.id, input.createdBy, true);
  const thread = input.threadId
    ? db.prepare("SELECT id, project_id FROM threads WHERE id = ?").get(input.threadId)
    : createThread(project.id, titleFor(input.userText), input.createdBy);
  if (!thread || thread.project_id !== project.id) throw new Error("对话不属于该项目");
  const ts = now();
  const insert = db.prepare("INSERT INTO thread_messages(id,thread_id,task_id,role,content,created_at) VALUES (?,?,?,?,?,?)");
  writeTransaction(() => {
    insert.run(agentIdFactory(), thread.id, null, "user", input.userText, ts);
    insert.run(agentIdFactory(), thread.id, null, "assistant", input.assistantText, ts + 1);
    db.prepare("UPDATE threads SET title=CASE WHEN title='新对话' THEN ? ELSE title END, updated_at=? WHERE id=?").run(titleFor(input.userText), ts + 1, thread.id);
  });
  return { threadId: thread.id };
}

/** taskStore.ts:196 */
const ASSISTANT_CHAT_PREFIX = "__DX_CHAT_V1__:";

/** taskStore.ts:198 */
function syncAssistantConversation(input) {
  const db = getAgentTaskDb();
  requireProjectAccess(input.projectId, input.createdBy, true);
  if (!/^[a-zA-Z0-9_-]{3,80}$/.test(input.threadId)) throw new Error("对话 ID 无效");
  const existing = db.prepare("SELECT id,project_id,created_by,visibility,created_at FROM threads WHERE id=?").get(input.threadId);
  if (existing && (existing.project_id !== input.projectId || existing.created_by !== input.createdBy || existing.visibility !== "private")) {
    throw new Error("对话不存在或无权修改");
  }
  const nowTs = now();
  const createdAt = Number(input.createdAt) > 0 ? Number(input.createdAt) : nowTs;
  const title = String(input.title || "").trim().slice(0, 80) || "新对话";
  const messages = Array.isArray(input.messages) ? input.messages : [];
  writeTransaction(() => {
    if (!existing) {
      db.prepare("INSERT INTO threads(id,project_id,title,visibility,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
        input.threadId,
        input.projectId,
        title,
        "private",
        input.createdBy,
        createdAt,
        nowTs,
      );
    } else {
      db.prepare("UPDATE threads SET title=?,updated_at=? WHERE id=?").run(title, nowTs, input.threadId);
    }
    db.prepare("DELETE FROM thread_messages WHERE thread_id=? AND substr(content,1,?)=?").run(input.threadId, ASSISTANT_CHAT_PREFIX.length, ASSISTANT_CHAT_PREFIX);
    const insert = db.prepare("INSERT INTO thread_messages(id,thread_id,task_id,role,content,created_at) VALUES (?,?,?,?,?,?)");
    insert.run(agentIdFactory(), input.threadId, null, "system", ASSISTANT_CHAT_PREFIX + JSON.stringify({ type: "thread" }), createdAt);
    messages.forEach((message, index) => {
      const role = message.role === "user" || message.role === "tool" ? message.role : "assistant";
      const payload = { type: "message", id: String(message.id || agentIdFactory()), role: role, text: String(message.text || "") };
      if (Array.isArray(message.images) && message.images.length) payload.images = message.images.slice(0, 20);
      insert.run(agentIdFactory(), input.threadId, null, role, ASSISTANT_CHAT_PREFIX + JSON.stringify(payload), createdAt + index + 1);
    });
  });
  return db.prepare("SELECT * FROM threads WHERE id=?").get(input.threadId);
}

/** taskStore.ts:241 */
function deleteAssistantConversation(projectId, userId, threadId) {
  const db = getAgentTaskDb();
  requireProjectAccess(projectId, userId, true);
  const thread = db.prepare("SELECT id FROM threads WHERE id=? AND project_id=? AND created_by=? AND visibility=?").get(threadId, projectId, userId, "private");
  if (!thread) return false;
  db.prepare("DELETE FROM threads WHERE id=?").run(threadId);
  return true;
}

/** taskStore.ts:250 —— 旧浏览器任务仅作为不可执行历史导入。 */
function importLegacyTask(projectId, createdBy, input) {
  const db = getAgentTaskDb();
  requireProjectAccess(projectId, createdBy, true);
  const sourceId = String(input.sourceId || "").trim();
  if (!sourceId) throw new Error("旧任务缺少来源 ID");
  const existing = db.prepare("SELECT * FROM dx_tasks WHERE created_by=? AND legacy_source_id=?").get(createdBy, sourceId);
  if (existing) return hydrateTask(existing);
  const messages = Array.isArray(input.messages) ? input.messages.filter((item) => item && item.text) : [];
  const firstUser = messages.find((item) => item.role === "user");
  const instruction = String(input.instruction || (firstUser && firstUser.text) || input.title || "历史任务");
  const title = String(input.title || titleFor(instruction)).slice(0, 80);
  const sourceStatus = String(input.status || "");
  const status = sourceStatus === "done" ? "completed" : sourceStatus === "error" ? "failed" : "interrupted";
  const ts = Number(input.createdAt) > 0 ? Number(input.createdAt) : now();
  const id = agentIdFactory();
  const thread = createThread(projectId, title, createdBy);
  writeTransaction(() => {
    const lastAssistant = messages.filter((item) => item.role === "assistant").at(-1);
    const lastAny = messages.at(-1);
    db.prepare(
      "INSERT INTO dx_tasks(id,project_id,thread_id,title,instruction,status,result,error_code,error_message,resume_safe,created_by,created_at,updated_at,completed_at,legacy_source_id) " +
        "VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)",
    ).run(
      id,
      projectId,
      thread.id,
      title,
      instruction,
      status,
      status === "completed" ? (lastAssistant && lastAssistant.text) || "历史任务已完成" : null,
      status === "failed" ? "legacy_error" : status === "interrupted" ? "legacy_interrupted" : null,
      status === "failed" ? (lastAny && lastAny.text) || "历史任务失败" : status === "interrupted" ? "页面刷新前任务已中断，仅作为历史导入" : null,
      createdBy,
      ts,
      ts,
      status === "completed" || status === "failed" ? ts : null,
      sourceId,
    );
    db.prepare("INSERT INTO task_plans(id,task_id,goal,assumptions,acceptance,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(
      agentIdFactory(),
      id,
      instruction,
      "[]",
      "[]",
      ts,
      ts,
    );
    const insertMessage = db.prepare("INSERT INTO thread_messages(id,thread_id,task_id,role,content,created_at) VALUES (?,?,?,?,?,?)");
    messages.forEach((message, index) => insertMessage.run(agentIdFactory(), thread.id, id, message.role || "assistant", String(message.text), ts + index));
    appendTaskEvent(id, "task.imported", "已从浏览器历史只读导入", { sourceStatus: sourceStatus });
  });
  return getTask(id);
}

/** taskStore.ts:281 */
function appendTaskEvent(taskId, type, message, data) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const result = db
      .prepare(
        "INSERT INTO dx_task_events(task_id,sequence,type,message,data_json,created_at) " +
          "SELECT ?,COALESCE(MAX(sequence),0)+1,?,?,?,? FROM dx_task_events WHERE task_id=?",
      )
      .run(taskId, type, message, data === undefined ? null : json(data), now(), taskId);
    return Number(result.lastInsertRowid);
  });
}

/** taskStore.ts:290 */
function addCheckpoint(taskId, stepId, state) {
  const db = getAgentTaskDb();
  const iteration = db.prepare("SELECT COALESCE(MAX(iteration),0)+1 AS value FROM task_checkpoints WHERE task_id=?").get(taskId).value;
  db.prepare(
    "INSERT INTO task_checkpoints(id,task_id,step_id,iteration,plan_version,state_json,context_summary,created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(agentIdFactory(), taskId, stepId, iteration, 1, json(state), JSON.stringify(state).slice(0, 500), now());
}

/** taskStore.ts:296 */
function getTask(id) {
  const db = getAgentTaskDb();
  const task = db.prepare("SELECT * FROM dx_tasks WHERE id = ?").get(id);
  return task ? hydrateTask(task) : undefined;
}

/** taskStore.ts:301（源为模块内私有函数） */
function hydrateTask(task) {
  const db = getAgentTaskDb();
  const plan = db.prepare("SELECT * FROM task_plans WHERE task_id = ?").get(task.id);
  const steps = db.prepare("SELECT * FROM dx_task_steps WHERE task_id = ? ORDER BY ordinal").all(task.id);
  const events = db.prepare("SELECT * FROM dx_task_events WHERE task_id = ? ORDER BY sequence").all(task.id);
  const checkpoints = db.prepare("SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY iteration DESC").all(task.id);
  const deliverables = db.prepare("SELECT * FROM deliverables WHERE task_id = ? ORDER BY created_at").all(task.id);
  const observations = db.prepare("SELECT * FROM task_observations WHERE task_id = ? ORDER BY created_at").all(task.id);
  const agentRun = db.prepare("SELECT id FROM agent_runs WHERE task_id=? ORDER BY created_at DESC LIMIT 1").get(task.id);
  return Object.assign({}, task, {
    agent_run_id: agentRun ? agentRun.id : null,
    plan: plan || null,
    steps: steps,
    events: events,
    checkpoints: checkpoints,
    deliverables: deliverables,
    observations: observations,
  });
}

/** taskStore.ts:312 */
function listTaskEvents(taskId, afterSequence) {
  const db = getAgentTaskDb();
  const after = afterSequence === undefined ? 0 : afterSequence;
  return db.prepare("SELECT * FROM dx_task_events WHERE task_id=? AND sequence>? ORDER BY sequence").all(taskId, Math.max(0, after));
}

/** taskStore.ts:317 */
function listTasks(userId, projectId) {
  const db = getAgentTaskDb();
  const rows = projectId
    ? db
        .prepare("SELECT t.* FROM dx_tasks t JOIN project_members m ON m.project_id=t.project_id WHERE t.project_id=? AND m.user_id=? ORDER BY t.created_at DESC")
        .all(projectId, userId)
    : db
        .prepare("SELECT t.* FROM dx_tasks t JOIN project_members m ON m.project_id=t.project_id WHERE m.user_id=? ORDER BY t.created_at DESC")
        .all(userId);
  return rows.map(hydrateTask);
}

/** taskStore.ts:326 */
function projectHistory(projectId, userId) {
  const db = getAgentTaskDb();
  requireProjectAccess(projectId, userId);
  const threads = db
    .prepare("SELECT * FROM threads WHERE project_id=? AND (visibility!='private' OR created_by IS NULL OR created_by=?) ORDER BY updated_at DESC")
    .all(projectId, userId);
  const visibleThreadIds = new Set(threads.map((t) => t.id));
  const messages = db
    .prepare("SELECT m.* FROM thread_messages m JOIN threads t ON t.id=m.thread_id WHERE t.project_id=? ORDER BY m.created_at")
    .all(projectId)
    .filter((m) => visibleThreadIds.has(m.thread_id));
  const tasks = listTasks(userId, projectId).filter((t) => visibleThreadIds.has(t.thread_id));
  return { project: getProject(projectId), threads: threads, messages: messages, tasks: tasks };
}

/** taskStore.ts:340 */
function threadMessages(projectId, userId, threadId) {
  const db = getAgentTaskDb();
  requireProjectAccess(projectId, userId);
  const thread = db
    .prepare("SELECT id FROM threads WHERE id=? AND project_id=? AND (visibility!='private' OR created_by IS NULL OR created_by=?)")
    .get(threadId, projectId, userId);
  if (!thread) throw new Error("对话不存在或无权访问");
  return db.prepare("SELECT role,content FROM thread_messages WHERE thread_id=? ORDER BY created_at DESC LIMIT 30").all(threadId).reverse();
}

/** taskStore.ts:349 */
function updateTaskStatus(id, status, extras) {
  const db = getAgentTaskDb();
  const allowed = new Set([
    "worker_id",
    "lease_token",
    "lease_until",
    "heartbeat_at",
    "current_step_id",
    "result",
    "error_code",
    "error_message",
    "started_at",
    "completed_at",
    "waiting_question",
  ]);
  const pairs = Object.entries(extras || {}).filter(([key]) => allowed.has(key));
  const sets = ["status = @status", "updated_at = @updated_at"].concat(pairs.map(([key]) => key + " = @" + key));
  db.prepare("UPDATE dx_tasks SET " + sets.join(", ") + " WHERE id = @id").run(
    Object.assign({ id: id, status: status, updated_at: now() }, Object.fromEntries(pairs)),
  );
}

/** taskStore.ts:364 */
function consumeBudget(taskId, kind, budget) {
  const db = getAgentTaskDb();
  const effective = budget || DEFAULT_BUDGET;
  const column = kind === "model" ? "model_calls" : "tool_calls";
  const limit = kind === "model" ? effective.maxModelCalls : effective.maxToolCalls;
  const treeLimit = kind === "model" ? DEFAULT_TREE_BUDGET.maxModelCalls : DEFAULT_TREE_BUDGET.maxToolCalls;
  return writeTransaction(() => {
    const task = db.prepare("SELECT COALESCE(root_task_id,id) AS rootId FROM dx_tasks WHERE id=?").get(taskId);
    if (!task) return false;
    const used = Number(db.prepare("SELECT COALESCE(SUM(" + column + "),0) AS value FROM dx_tasks WHERE COALESCE(root_task_id,id)=?").get(task.rootId).value);
    if (used >= treeLimit) return false;
    if (limit === null) {
      return db.prepare("UPDATE dx_tasks SET " + column + "=" + column + "+1, updated_at=? WHERE id=?").run(now(), taskId).changes > 0;
    }
    return Boolean(
      db.prepare("UPDATE dx_tasks SET " + column + "=" + column + "+1, updated_at=? WHERE id=? AND " + column + "<? RETURNING " + column + " AS n").get(now(), taskId, limit),
    );
  });
}

/** taskStore.ts:379 */
function appendDynamicStep(taskId, title, toolName, args, stableOperationId) {
  const db = getAgentTaskDb();
  if (stableOperationId) {
    const existing = db.prepare("SELECT id,ordinal,operation_id,status FROM dx_task_steps WHERE task_id=? AND operation_id=?").get(taskId, stableOperationId);
    if (existing) return existing;
  }
  const ordinal = db.prepare("SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM dx_task_steps WHERE task_id=?").get(taskId).n;
  const id = agentIdFactory();
  const operationId = stableOperationId || taskId + ":" + ordinal;
  db.prepare("INSERT INTO dx_task_steps(id,task_id,ordinal,title,tool_name,input_json,status,operation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
    id,
    taskId,
    ordinal,
    title.slice(0, 120),
    toolName,
    json(args),
    "queued",
    operationId,
    now(),
  );
  return { id: id, ordinal: ordinal, operation_id: operationId, status: "queued" };
}

/** taskStore.ts:398 */
function latestResumableAgentTurn(taskId) {
  const db = getAgentTaskDb();
  return db.prepare("SELECT * FROM agent_turns WHERE task_id=? AND status IN ('responded','processing') ORDER BY iteration DESC LIMIT 1").get(taskId);
}

/** taskStore.ts:403 */
function persistAgentTurn(input) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const active = db.prepare("SELECT 1 FROM dx_tasks WHERE id=? AND worker_id=? AND lease_token=? AND lease_until>=? AND status='running'").get(
      input.taskId,
      input.workerId,
      input.leaseToken,
      now(),
    );
    if (!active) throw new Error("模型返回时任务租约已失效");
    const iteration = db.prepare("SELECT COALESCE(MAX(iteration),0)+1 AS value FROM agent_turns WHERE task_id=?").get(input.taskId).value;
    const id = agentIdFactory();
    const ts = now();
    db.prepare(
      "INSERT INTO agent_turns(id,run_id,task_id,attempt_no,iteration,request_hash,status,response_json,next_tool_index,created_at,updated_at) " +
        "VALUES (?,?,?,?,?,?,'responded',?,0,?,?)",
    ).run(id, input.runId, input.taskId, input.attemptNo, iteration, input.requestHash, json({ content: input.content, toolCalls: input.toolCalls }), ts, ts);
    appendAgentCheckpoint({
      runId: input.runId,
      taskId: input.taskId,
      attemptNo: input.attemptNo,
      phase: "model_response_persisted",
      state: { schema: AGENT_CHECKPOINT_SCHEMA, turnId: id, iteration: iteration, nextToolIndex: 0, pendingToolCalls: input.toolCalls },
    });
    return db.prepare("SELECT * FROM agent_turns WHERE id=?").get(id);
  });
}

/** taskStore.ts:420 */
function advanceAgentTurn(turnId, nextToolIndex, checkpoint) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const ts = now();
    const changed =
      db
        .prepare(
          "UPDATE agent_turns SET status='processing',next_tool_index=?,updated_at=? WHERE id=? AND status IN ('responded','processing') AND next_tool_index<=? " +
            "AND EXISTS (SELECT 1 FROM dx_tasks WHERE id=agent_turns.task_id AND worker_id=? AND lease_token=? AND lease_until>=? AND status='running')",
        )
        .run(nextToolIndex, ts, turnId, nextToolIndex, checkpoint.workerId, checkpoint.leaseToken, ts).changes > 0;
    if (changed) {
      const partial = checkpoint.state || {};
      appendAgentCheckpoint(
        Object.assign({}, checkpoint, {
          phase: "tool_progress",
          state: Object.assign({ schema: AGENT_CHECKPOINT_SCHEMA, iteration: partial.iteration || 0, nextToolIndex: nextToolIndex, turnId: turnId }, partial),
        }),
      );
    }
    return changed;
  });
}

/** taskStore.ts:433 */
function completeAgentTurn(turnId, workerId, leaseToken) {
  const db = getAgentTaskDb();
  const ts = now();
  return (
    db
      .prepare(
        "UPDATE agent_turns SET status='completed',completed_at=?,updated_at=? WHERE id=? AND status IN ('responded','processing') " +
          "AND EXISTS (SELECT 1 FROM dx_tasks WHERE id=agent_turns.task_id AND worker_id=? AND lease_token=? AND lease_until>=? AND status='running')",
      )
      .run(ts, ts, turnId, workerId, leaseToken, ts).changes > 0
  );
}

/** taskStore.ts:440 */
function appendAgentCheckpoint(input) {
  const db = getAgentTaskDb();
  const sequence = db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS value FROM agent_checkpoints WHERE task_id=?").get(input.taskId).value;
  db.prepare("INSERT INTO agent_checkpoints(id,run_id,task_id,attempt_no,sequence,schema_version,phase,state_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
    agentIdFactory(),
    input.runId,
    input.taskId,
    input.attemptNo,
    sequence,
    AGENT_CHECKPOINT_SCHEMA,
    input.phase,
    json(input.state),
    now(),
  );
  return sequence;
}

/** taskStore.ts:448（react 任务开跑前清理中断遗留步骤） */
function sealStaleReactSteps(taskId) {
  const db = getAgentTaskDb();
  db.prepare("UPDATE dx_task_steps SET status='failed',result_summary='任务中断，该步骤未完成',completed_at=? WHERE task_id=? AND status IN ('queued','running')").run(
    now(),
    taskId,
  );
}

/** taskStore.ts:454 */
function savePlan(taskId, plan) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    db.prepare("UPDATE task_plans SET goal=?,assumptions=?,acceptance=?,updated_at=? WHERE task_id=?").run(
      plan.goal.slice(0, 2000),
      json(plan.assumptions),
      json(plan.acceptance),
      now(),
      taskId,
    );
    appendTaskEvent(taskId, "task.planned", plan.goal.slice(0, 200), { assumptions: plan.assumptions, acceptance: plan.acceptance });
  });
}

/** taskStore.ts:463 */
function waitForUser(taskId, workerId, question, leaseToken) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const changed =
      db
        .prepare(
          "UPDATE dx_tasks SET status='waiting_user',waiting_question=?,worker_id=NULL,lease_token=NULL,lease_until=NULL,heartbeat_at=NULL,updated_at=? " +
            "WHERE id=? AND worker_id=? AND (? IS NULL OR (lease_token=? AND lease_until>=?)) AND status IN ('running','verifying')",
        )
        .run(question.slice(0, 1000), now(), taskId, workerId, leaseToken || null, leaseToken || null, now()).changes > 0;
    if (changed) {
      if (leaseToken) db.prepare("UPDATE task_attempts SET status='waiting',ended_at=? WHERE lease_token=? AND status='running'").run(now(), leaseToken);
      appendTaskEvent(taskId, "task.waiting_user", question.slice(0, 500));
    }
    return changed;
  });
}

/** taskStore.ts:476 */
function waitForChildren(taskId, workerId, childCount, leaseToken) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const changed =
      db
        .prepare(
          "UPDATE dx_tasks SET status='waiting_children',worker_id=NULL,lease_token=NULL,lease_until=NULL,heartbeat_at=NULL,updated_at=? " +
            "WHERE id=? AND worker_id=? AND (? IS NULL OR (lease_token=? AND lease_until>=?)) AND status IN ('running','planning')",
        )
        .run(now(), taskId, workerId, leaseToken || null, leaseToken || null, now()).changes > 0;
    if (changed) {
      if (leaseToken) db.prepare("UPDATE task_attempts SET status='waiting',ended_at=? WHERE lease_token=? AND status='running'").run(now(), leaseToken);
      appendTaskEvent(taskId, "supervisor.waiting_children", "等待 " + childCount + " 个子 Agent 完成", { childCount: childCount });
    }
    return changed;
  });
}

/** taskStore.ts:490（围栏化任务失败；no_llm_provider 转 waiting_user） */
function failTaskFenced(taskId, workerId, code, message, leaseToken) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const ts = now();
    const toWaiting = code === "no_llm_provider";
    const changed = (
      toWaiting
        ? db
            .prepare(
              "UPDATE dx_tasks SET status='waiting_user',waiting_question=?,error_code=?,error_message=?,worker_id=NULL,lease_token=NULL,lease_until=NULL,heartbeat_at=NULL,updated_at=? " +
                "WHERE id=? AND worker_id=? AND (? IS NULL OR (lease_token=? AND lease_until>=?)) AND status IN ('running','verifying','planning')",
            )
            .run(message.slice(0, 1000), code, message.slice(0, 1000), ts, taskId, workerId, leaseToken || null, leaseToken || null, ts)
        : db
            .prepare(
              "UPDATE dx_tasks SET status='failed',error_code=?,error_message=?,completed_at=?,worker_id=NULL,lease_token=NULL,lease_until=NULL,heartbeat_at=NULL,updated_at=? " +
                "WHERE id=? AND worker_id=? AND (? IS NULL OR (lease_token=? AND lease_until>=?)) AND status IN ('running','verifying','planning')",
            )
            .run(code, message.slice(0, 1000), ts, ts, taskId, workerId, leaseToken || null, leaseToken || null, ts)
    ).changes > 0;
    if (changed) {
      if (leaseToken) {
        db.prepare("UPDATE task_attempts SET status=?,ended_at=?,error_message=? WHERE lease_token=? AND status='running'").run(
          toWaiting ? "waiting" : "failed",
          ts,
          message.slice(0, 1000),
          leaseToken,
        );
      }
      appendTaskEvent(taskId, toWaiting ? "task.waiting_user" : "task.failed", message.slice(0, 500));
    }
    return changed;
  });
}

/** taskStore.ts:511 */
function pauseTaskFenced(taskId, workerId, code, message, leaseToken) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const ts = now();
    const changed =
      db
        .prepare(
          "UPDATE dx_tasks SET status='paused',error_code=?,error_message=?,worker_id=NULL,lease_token=NULL,lease_until=NULL,heartbeat_at=NULL,updated_at=? " +
            "WHERE id=? AND worker_id=? AND (? IS NULL OR (lease_token=? AND lease_until>=?)) AND status IN ('planning','running','verifying')",
        )
        .run(code, message.slice(0, 1000), ts, taskId, workerId, leaseToken || null, leaseToken || null, ts).changes > 0;
    if (changed) {
      if (leaseToken) db.prepare("UPDATE task_attempts SET status='waiting',ended_at=?,error_message=? WHERE lease_token=? AND status='running'").run(ts, message.slice(0, 1000), leaseToken);
      appendTaskEvent(taskId, "task.paused", message.slice(0, 500));
    }
    return changed;
  });
}

/** taskStore.ts:527 */
function answerTask(taskId, userId, answer) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const task = db.prepare("SELECT status,thread_id,project_id FROM dx_tasks WHERE id=?").get(taskId);
    if (!task) throw new Error("任务不存在");
    requireProjectAccess(task.project_id, userId, true);
    if (task.status !== "waiting_user") throw new Error("该任务当前不在等待回答");
    db.prepare("INSERT INTO thread_messages(id,thread_id,task_id,role,content,created_at) VALUES (?,?,?,?,?,?)").run(
      agentIdFactory(),
      task.thread_id,
      taskId,
      "user",
      answer,
      now(),
    );
    updateTaskStatus(taskId, "queued", { waiting_question: null, worker_id: null, lease_until: null });
    appendTaskEvent(taskId, "task.answered", answer.slice(0, 500));
  });
}

/** taskStore.ts:541 */
function continueTask(taskId, userId, message) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const task = db.prepare("SELECT status,mode,thread_id,project_id FROM dx_tasks WHERE id=?").get(taskId);
    if (!task) throw new Error("任务不存在");
    requireProjectAccess(task.project_id, userId, true);
    if (task.mode !== "react") throw new Error("此任务使用固定步骤，不能追加要求");
    if (["queued", "planning", "running", "verifying"].includes(task.status)) throw new Error("任务正在执行，请完成或暂停后再追加要求");
    db.prepare("INSERT INTO thread_messages(id,thread_id,task_id,role,content,created_at) VALUES (?,?,?,?,?,?)").run(
      agentIdFactory(),
      task.thread_id,
      taskId,
      "user",
      message,
      now(),
    );
    db.prepare(
      "UPDATE dx_tasks SET status='queued',waiting_question=NULL,error_code=NULL,error_message=NULL,result=NULL," +
        "completed_at=NULL,worker_id=NULL,lease_until=NULL,heartbeat_at=NULL,updated_at=? WHERE id=?",
    ).run(now(), taskId);
    appendTaskEvent(taskId, "task.answered", message.slice(0, 500));
    appendTaskEvent(taskId, "task.continued", "用户追加要求，任务重新进入队列");
    return getTask(taskId);
  });
}

/** taskStore.ts:561 */
function refreshTaskInstruction(taskId, userId, instruction) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const task = db.prepare("SELECT project_id FROM dx_tasks WHERE id=?").get(taskId);
    if (!task) throw new Error("任务不存在");
    requireProjectAccess(task.project_id, userId, true);
    const value = String(instruction || "").trim();
    if (!value) throw new Error("任务指令不能为空");
    const ts = now();
    db.prepare("UPDATE dx_tasks SET instruction=?,updated_at=? WHERE id=?").run(value, ts, taskId);
    db.prepare("UPDATE task_plans SET goal=?,updated_at=? WHERE task_id=?").run(value, ts, taskId);
    appendTaskEvent(taskId, "task.instruction_refreshed", "任务规范与验收目标已刷新");
    return getTask(taskId);
  });
}

/** taskStore.ts:578 */
function taskTrace(taskId, userId) {
  const task = getTask(taskId);
  if (!task) throw new Error("任务不存在");
  requireProjectAccess(task.project_id, userId);
  const durationMs = task.completed_at && task.started_at ? task.completed_at - task.started_at : null;
  const stepDurations = task.steps
    .filter((s) => s.status === "completed")
    .map((s) => ({ title: s.title, tool: s.tool_name, ms: s.completed_at && s.started_at ? s.completed_at - s.started_at : null }));
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    mode: task.mode,
    modelCalls: task.model_calls,
    toolCalls: task.tool_calls,
    durationMs: durationMs,
    errorCode: task.error_code,
    errorMessage: task.error_message,
    steps: stepDurations,
    stepCounts: {
      completed: task.steps.filter((s) => s.status === "completed").length,
      failed: task.steps.filter((s) => s.status === "failed").length,
      total: task.steps.length,
    },
    checkpoints: task.checkpoints.length,
    deliverables: task.deliverables.length,
    eventCount: task.events.length,
  };
}

/** taskStore.ts:606（跨任务统计：本人可见项目范围） */
function taskStats(userId, sinceMs) {
  const db = getAgentTaskDb();
  const since = sinceMs === undefined ? 0 : sinceMs;
  const scope = "FROM dx_tasks t JOIN project_members m ON m.project_id=t.project_id AND m.user_id=? WHERE t.created_at>=?";
  const byStatus = db.prepare("SELECT t.status AS key, COUNT(*) AS n " + scope + " GROUP BY t.status").all(userId, since);
  const byError = db
    .prepare("SELECT t.error_code AS key, COUNT(*) AS n " + scope + " AND t.error_code IS NOT NULL GROUP BY t.error_code ORDER BY n DESC LIMIT 10")
    .all(userId, since);
  const byMode = db.prepare("SELECT t.mode AS key, COUNT(*) AS n " + scope + " GROUP BY t.mode").all(userId, since);
  const usage = db
    .prepare(
      "SELECT COALESCE(SUM(t.model_calls),0) AS modelCalls, COALESCE(SUM(t.tool_calls),0) AS toolCalls, COUNT(*) AS tasks, " +
        "COALESCE(AVG(CASE WHEN t.completed_at IS NOT NULL AND t.started_at IS NOT NULL THEN t.completed_at-t.started_at END),0) AS avgDurationMs " +
        scope,
    )
    .get(userId, since);
  const recentFailed = db
    .prepare("SELECT t.id,t.title,t.error_code,t.error_message,t.updated_at " + scope + " AND t.status='failed' ORDER BY t.updated_at DESC LIMIT 8")
    .all(userId, since);
  return { byStatus: byStatus, byError: byError, byMode: byMode, usage: usage, recentFailed: recentFailed };
}

/** taskStore.ts:621 */
function findResumableTasks(userId, options) {
  const db = getAgentTaskDb();
  const base =
    "SELECT t.* FROM dx_tasks t JOIN project_members m ON m.project_id=t.project_id AND m.user_id=? " +
    "WHERE t.resume_safe=1 AND t.status IN ('interrupted','paused','waiting_user','failed')";
  const rows = options.threadId
    ? db.prepare(base + " AND t.thread_id=? ORDER BY t.updated_at DESC").all(userId, options.threadId)
    : options.projectId
      ? db.prepare(base + " AND t.project_id=? ORDER BY t.updated_at DESC").all(userId, options.projectId)
      : db.prepare(base + " ORDER BY t.updated_at DESC").all(userId);
  return rows.map(hydrateTask);
}

/** taskStore.ts:632（私有） */
function requeueRunningStep(id) {
  const db = getAgentTaskDb();
  db.prepare("UPDATE dx_task_steps SET status='queued', started_at=NULL WHERE task_id=? AND status='running'").run(id);
}

/** taskStore.ts:635 */
function pauseTask(id) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const task = db.prepare("SELECT status,lease_token FROM dx_tasks WHERE id=?").get(id);
    if (!task) throw new Error("任务不存在");
    if (!["queued", "planning", "running", "verifying"].includes(task.status)) throw new Error("该任务当前不能暂停");
    requeueRunningStep(id);
    updateTaskStatus(id, "paused", { worker_id: null, lease_token: null, lease_until: null, heartbeat_at: null });
    if (task.lease_token) {
      db.prepare("UPDATE task_attempts SET status='waiting',ended_at=?,error_message='用户暂停任务' WHERE lease_token=? AND status='running'").run(now(), task.lease_token);
    }
    appendTaskEvent(id, "task.paused", "任务已暂停");
  });
}

/** taskStore.ts:646 */
function cancelTask(id) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const task = db.prepare("SELECT status,lease_token FROM dx_tasks WHERE id=?").get(id);
    if (!task) throw new Error("任务不存在");
    if (["completed", "cancelled"].includes(task.status)) throw new Error("该任务当前不能取消");
    requeueRunningStep(id);
    updateTaskStatus(id, "cancelled", { worker_id: null, lease_token: null, completed_at: now(), lease_until: null, heartbeat_at: null });
    if (task.lease_token) {
      db.prepare("UPDATE task_attempts SET status='cancelled',ended_at=?,error_message='用户取消任务' WHERE lease_token=? AND status='running'").run(now(), task.lease_token);
    }
    appendTaskEvent(id, "task.cancelled", "任务已取消");
  });
}

/** taskStore.ts:657 */
function deleteTask(id) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const task = db.prepare("SELECT id,status FROM dx_tasks WHERE id=?").get(id);
    if (!task) throw new Error("任务不存在");
    requeueRunningStep(id);
    db.prepare("DELETE FROM task_observations WHERE task_id=?").run(id);
    db.prepare("DELETE FROM task_checkpoints WHERE task_id=?").run(id);
    db.prepare("DELETE FROM dx_task_events WHERE task_id=?").run(id);
    db.prepare("DELETE FROM dx_task_steps WHERE task_id=?").run(id);
    db.prepare("DELETE FROM task_plans WHERE task_id=?").run(id);
    db.prepare("DELETE FROM deliverables WHERE task_id=?").run(id);
    db.prepare("DELETE FROM thread_messages WHERE task_id=?").run(id);
    db.prepare("DELETE FROM dx_tasks WHERE id=?").run(id);
  });
}

/** taskStore.ts:672 */
function resumeTask(id) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const task = db.prepare("SELECT status,error_code,resume_safe,mode FROM dx_tasks WHERE id = ?").get(id);
    if (!task) throw new Error("任务不存在");
    if (!task.resume_safe) throw new Error("该历史任务不可恢复，请创建新任务继续");
    if (!["paused", "interrupted", "failed"].includes(task.status)) throw new Error("该任务当前不能恢复");
    if (task.mode === "actions") {
      if (task.status === "failed" && task.error_code !== "verification_failed") {
        db.prepare("UPDATE dx_task_steps SET status='queued',output_json=NULL,started_at=NULL,completed_at=NULL WHERE task_id=? AND status='failed'").run(id);
      }
      const steps = db.prepare("SELECT COUNT(*) AS count FROM dx_task_steps WHERE task_id=? AND status='queued'").get(id);
      if (!steps.count && task.error_code !== "verification_failed") throw new Error("任务没有可恢复的步骤");
    } else {
      sealStaleReactSteps(id);
    }
    updateTaskStatus(id, "queued", { worker_id: null, lease_until: null, heartbeat_at: null, completed_at: null, error_code: null, error_message: null });
    appendTaskEvent(id, "task.resumed", "任务已重新进入队列");
  });
}

/** taskStore.ts:694 */
function canWorkerRunTask(taskId) {
  const db = getAgentTaskDb();
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM dx_tasks t JOIN project_members m ON m.project_id=t.project_id AND m.user_id=t.created_by " +
          "WHERE t.id=? AND m.role IN ('editor','manager')",
      )
      .get(taskId),
  );
}

/** taskStore.ts:699 */
function registerWorker(id, pid, staleAfterMs) {
  const db = getAgentTaskDb();
  const stale = staleAfterMs === undefined ? 30000 : staleAfterMs;
  const ts = now();
  writeTransaction(() => {
    db.prepare("UPDATE worker_instances SET status='stopped',stopped_at=? WHERE status='running' AND id<>? AND heartbeat_at<?").run(ts, id, ts - stale);
    db.prepare(
      "INSERT INTO worker_instances(id,pid,status,started_at,heartbeat_at,stopped_at) VALUES (?,?,'running',?,?,NULL) " +
        "ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,status='running',started_at=excluded.started_at,heartbeat_at=excluded.heartbeat_at,stopped_at=NULL",
    ).run(id, pid, ts, ts);
  });
}

/** taskStore.ts:710 */
function heartbeatWorker(id) {
  const db = getAgentTaskDb();
  return db.prepare("UPDATE worker_instances SET heartbeat_at=? WHERE id=? AND status='running'").run(now(), id).changes > 0;
}

/** taskStore.ts:713 */
function stopWorker(id) {
  const db = getAgentTaskDb();
  const ts = now();
  db.prepare("UPDATE worker_instances SET status='stopped',heartbeat_at=?,stopped_at=? WHERE id=?").run(ts, ts, id);
}

/** taskStore.ts:717 */
function workerHealth(staleAfterMs) {
  const db = getAgentTaskDb();
  const stale = staleAfterMs === undefined ? 5000 : staleAfterMs;
  const worker = db.prepare("SELECT * FROM worker_instances ORDER BY heartbeat_at DESC LIMIT 1").get();
  return { available: Boolean(worker && worker.status === "running" && worker.heartbeat_at >= now() - stale), worker: worker || null };
}

/** taskStore.ts:723 */
function recoverExpiredTasks() {
  const db = getAgentTaskDb();
  const ts = now();
  const rows = db
    .prepare("SELECT id,worker_id,lease_token,lease_until FROM dx_tasks WHERE status IN ('planning','running','verifying') AND lease_until IS NOT NULL AND lease_until < ?")
    .all(ts);
  let recovered = 0;
  for (const row of rows) {
    writeTransaction(() => {
      const changed =
        db
          .prepare(
            "UPDATE dx_tasks SET status='interrupted',worker_id=NULL,lease_token=NULL,lease_until=NULL,heartbeat_at=NULL,updated_at=? " +
              "WHERE id=? AND status IN ('planning','running','verifying') AND worker_id IS ? AND lease_token IS ? AND lease_until=? AND lease_until<?",
          )
          .run(ts, row.id, row.worker_id, row.lease_token, row.lease_until, ts).changes > 0;
      if (!changed) return;
      db.prepare("UPDATE dx_task_steps SET status='queued', started_at=NULL WHERE task_id=? AND status='running'").run(row.id);
      if (row.lease_token) {
        db.prepare("UPDATE task_attempts SET status='interrupted',ended_at=?,error_message=? WHERE lease_token=? AND status='running'").run(ts, "Worker 租约已过期", row.lease_token);
      }
      db.prepare("UPDATE agent_usage_events SET status='cancelled',error_message='Worker 租约过期，调用结果未知',updated_at=?,completed_at=? WHERE task_id=? AND status='started'").run(
        ts,
        ts,
        row.id,
      );
      appendTaskEvent(row.id, "task.interrupted", "Worker 租约已过期，任务可从检查点恢复");
      recovered += 1;
    });
  }
  return recovered;
}

/** taskStore.ts:746 */
function claimNextTask(workerId, leaseMs) {
  const db = getAgentTaskDb();
  return transaction(() => {
    recoverExpiredTasks();
    const waitingParents = db.prepare("SELECT id FROM dx_tasks WHERE status='waiting_children'").all();
    for (const parent of waitingParents) {
      const activeChildren = Number(db.prepare("SELECT COUNT(*) AS value FROM dx_tasks WHERE parent_task_id=? AND status NOT IN ('completed','failed','cancelled')").get(parent.id).value);
      if (!activeChildren) {
        updateTaskStatus(parent.id, "queued", { worker_id: null, lease_until: null, heartbeat_at: null });
        const children = db.prepare("SELECT id,title,status FROM dx_tasks WHERE parent_task_id=? ORDER BY created_at").all(parent.id);
        appendTaskEvent(parent.id, "supervisor.children_completed", "全部子 Agent 已返回，父任务继续汇总", { children: children });
      }
    }
    const task = db
      .prepare(
        "SELECT * FROM dx_tasks candidate WHERE (status='queued' OR (status='interrupted' AND resume_safe=1)) " +
          "AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(candidate.depends_on_json,'[]')) dependency LEFT JOIN dx_tasks required ON required.id=dependency.value WHERE required.id IS NULL OR required.status!='completed') " +
          "AND (SELECT COUNT(*) FROM dx_tasks active WHERE COALESCE(active.root_task_id,active.id)=COALESCE(candidate.root_task_id,candidate.id) AND active.status IN ('planning','running','verifying')) < 3 " +
          "ORDER BY created_at LIMIT 1",
      )
      .get();
    if (!task) return undefined;
    const ts = now();
    const leaseToken = agentIdFactory();
    const attemptNo = task.attempt_no + 1;
    const change =
      db
        .prepare(
          "UPDATE dx_tasks SET status='running',worker_id=?,lease_token=?,attempt_no=?,lease_until=?,heartbeat_at=?,started_at=COALESCE(started_at,?),updated_at=? " +
            "WHERE id=? AND attempt_no=? AND (status='queued' OR (status='interrupted' AND resume_safe=1))",
        )
        .run(workerId, leaseToken, attemptNo, ts + leaseMs, ts, ts, ts, task.id, task.attempt_no);
    if (!change.changes) return undefined;
    db.prepare("INSERT INTO task_attempts(id,task_id,attempt_no,worker_id,lease_token,status,claimed_at,heartbeat_at,lease_until) VALUES (?,?,?,?,?,'running',?,?,?)").run(
      agentIdFactory(),
      task.id,
      attemptNo,
      workerId,
      leaseToken,
      ts,
      ts,
      ts + leaseMs,
    );
    appendTaskEvent(task.id, "task.claimed", "Worker " + workerId + " 已领取任务", { attemptNo: attemptNo, leaseToken: leaseToken });
    return getTask(task.id);
  })();
}

/** taskStore.ts:784 */
function heartbeatTask(taskId, workerId, leaseMs, leaseToken) {
  const db = getAgentTaskDb();
  const ts = now();
  return writeTransaction(() => {
    const changed =
      db
        .prepare(
          "UPDATE dx_tasks SET heartbeat_at=?, lease_until=?, updated_at=? WHERE id=? AND worker_id=? " +
            "AND (? IS NULL OR lease_token=?) AND status IN ('planning','running','verifying')",
        )
        .run(ts, ts + leaseMs, ts, taskId, workerId, leaseToken || null, leaseToken || null).changes > 0;
    if (changed && leaseToken) {
      db.prepare("UPDATE task_attempts SET heartbeat_at=?,lease_until=? WHERE lease_token=? AND status='running'").run(ts, ts + leaseMs, leaseToken);
    }
    return changed;
  });
}

/** taskStore.ts:796 */
function taskIsRunning(taskId, workerId, leaseToken) {
  const db = getAgentTaskDb();
  return Boolean(
    db
      .prepare("SELECT 1 FROM dx_tasks WHERE id=? AND worker_id=? AND (? IS NULL OR (lease_token=? AND lease_until>=?)) AND status='running'")
      .get(taskId, workerId, leaseToken || null, leaseToken || null, now()),
  );
}

/** taskStore.ts:801 */
function enterVerification(taskId, workerId, leaseToken) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const ts = now();
    const changed =
      db
        .prepare("UPDATE dx_tasks SET status='verifying',updated_at=? WHERE id=? AND worker_id=? AND (? IS NULL OR (lease_token=? AND lease_until>=?)) AND status='running'")
        .run(ts, taskId, workerId, leaseToken || null, leaseToken || null, ts).changes > 0;
    if (changed) appendTaskEvent(taskId, "task.verifying", "正在验证步骤和交付物");
    return changed;
  });
}

/** taskStore.ts:811 */
function completeVerifiedTask(taskId, workerId, result, leaseToken) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const ts = now();
    const changed =
      db
        .prepare(
          "UPDATE dx_tasks SET status='completed',result=?,completed_at=?,current_step_id=NULL,worker_id=NULL,lease_token=NULL,lease_until=NULL,heartbeat_at=NULL,updated_at=? " +
            "WHERE id=? AND worker_id=? AND (? IS NULL OR (lease_token=? AND lease_until>=?)) AND status='verifying'",
        )
        .run(result, ts, ts, taskId, workerId, leaseToken || null, leaseToken || null, ts).changes > 0;
    if (changed) {
      if (leaseToken) db.prepare("UPDATE task_attempts SET status='completed',ended_at=? WHERE lease_token=? AND status='running'").run(ts, leaseToken);
      db.prepare("UPDATE deliverables SET verification_status='verified',updated_at=? WHERE task_id=?").run(ts, taskId);
      appendTaskEvent(taskId, "task.completed", result);
    }
    return changed;
  });
}

/** taskStore.ts:825 */
function failVerification(taskId, workerId, message, leaseToken) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const ts = now();
    const changed =
      db
        .prepare(
          "UPDATE dx_tasks SET status='failed',error_code='verification_failed',error_message=?,completed_at=?,worker_id=NULL,lease_token=NULL,lease_until=NULL,heartbeat_at=NULL,updated_at=? " +
            "WHERE id=? AND worker_id=? AND (? IS NULL OR (lease_token=? AND lease_until>=?)) AND status='verifying'",
        )
        .run(message, ts, ts, taskId, workerId, leaseToken || null, leaseToken || null, ts).changes > 0;
    if (changed) {
      if (leaseToken) db.prepare("UPDATE task_attempts SET status='failed',ended_at=?,error_message=? WHERE lease_token=? AND status='running'").run(ts, message, leaseToken);
      appendTaskEvent(taskId, "task.failed", message);
    }
    return changed;
  });
}

/** taskStore.ts:839 */
function nextQueuedStep(taskId) {
  const db = getAgentTaskDb();
  return db.prepare("SELECT * FROM dx_task_steps WHERE task_id=? AND status='queued' ORDER BY ordinal LIMIT 1").get(taskId);
}

/** taskStore.ts:844（双重围栏：步骤排队中 + 任务仍由本 Worker 持有） */
function startStep(taskId, stepId, workerId, leaseToken) {
  const db = getAgentTaskDb();
  const ts = now();
  const changed =
    db
      .prepare(
        "UPDATE dx_task_steps SET status='running', started_at=? WHERE id=? AND task_id=? AND status='queued' " +
          "AND EXISTS (SELECT 1 FROM dx_tasks WHERE id=? AND worker_id=? AND (? IS NULL OR (lease_token=? AND lease_until>=?)) AND status='running')",
      )
      .run(ts, stepId, taskId, taskId, workerId, leaseToken || null, leaseToken || null, ts).changes > 0;
  if (changed) db.prepare("UPDATE dx_tasks SET current_step_id=?,updated_at=? WHERE id=? AND status=?").run(stepId, ts, taskId, "running");
  return changed;
}

/** taskStore.ts:853 */
function requeueStep(taskId, stepId) {
  const db = getAgentTaskDb();
  db.prepare("UPDATE dx_task_steps SET status='queued', started_at=NULL WHERE id=? AND task_id=? AND status='running'").run(stepId, taskId);
}

/** taskStore.ts:857 */
function requeueReactStepForResume(taskId, stepId, workerId, leaseToken) {
  const db = getAgentTaskDb();
  return (
    db
      .prepare(
        "UPDATE dx_task_steps SET status='queued',started_at=NULL WHERE id=? AND task_id=? AND status IN ('running','failed') " +
          "AND EXISTS (SELECT 1 FROM dx_tasks WHERE id=? AND worker_id=? AND lease_token=? AND lease_until>=? AND status='running')",
      )
      .run(stepId, taskId, taskId, workerId, leaseToken, now()).changes > 0
  );
}

/** taskStore.ts:863 */
function completeStep(taskId, stepId, workerId, output, deliverable, leaseToken) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const ts = now();
    const step = db.prepare("SELECT operation_id,tool_name FROM dx_task_steps WHERE id=? AND task_id=?").get(stepId, taskId);
    const message = String((output && output.message) || "");
    const changed =
      db
        .prepare(
          "UPDATE dx_task_steps SET status='completed', output_json=?, result_summary=?, completed_at=? WHERE id=? AND task_id=? AND status='running' " +
            "AND EXISTS (SELECT 1 FROM dx_tasks WHERE id=? AND worker_id=? AND (? IS NULL OR (lease_token=? AND lease_until>=?)) AND status='running')",
        )
        .run(json(output), message.slice(0, 500), ts, stepId, taskId, taskId, workerId, leaseToken || null, leaseToken || null, ts).changes > 0;
    if (!changed) return false;
    if (step) upsertObservation(taskId, stepId, step.operation_id, step.tool_name, "completed", message || "步骤已完成", output);
    if (deliverable) addDeliverable(taskId, deliverable.projectId, deliverable.nodeId, deliverable.name);
    addCheckpoint(taskId, stepId, { completedStepId: stepId, output: output });
    appendTaskEvent(taskId, "step.completed", message || "步骤已完成", output);
    return true;
  });
}

/** taskStore.ts:879 */
function failStep(taskId, stepId, workerId, message, leaseToken) {
  const db = getAgentTaskDb();
  return writeTransaction(() => {
    const step = db.prepare("SELECT operation_id,tool_name FROM dx_task_steps WHERE id=? AND task_id=?").get(stepId, taskId);
    const changed =
      db
        .prepare(
          "UPDATE dx_task_steps SET status='failed', output_json=?,result_summary=?, completed_at=? WHERE id=? AND task_id=? AND status='running' " +
            "AND EXISTS (SELECT 1 FROM dx_tasks WHERE id=? AND worker_id=? AND (? IS NULL OR (lease_token=? AND lease_until>=?)) AND status='running')",
        )
        .run(json({ error: message }), message.slice(0, 500), now(), stepId, taskId, taskId, workerId, leaseToken || null, leaseToken || null, now()).changes > 0;
    if (changed) {
      if (step) upsertObservation(taskId, stepId, step.operation_id, step.tool_name, "failed", message, { error: message });
      appendTaskEvent(taskId, "step.failed", message, { stepId: stepId });
    }
    return changed;
  });
}

/** taskStore.ts:893（私有） */
function upsertObservation(taskId, stepId, operationId, toolName, status, summary, data) {
  const db = getAgentTaskDb();
  db.prepare(
    "INSERT INTO task_observations(id,task_id,step_id,operation_id,tool_name,status,summary,data_json,created_at) VALUES (?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(operation_id) DO UPDATE SET status=excluded.status,summary=excluded.summary,data_json=excluded.data_json,created_at=excluded.created_at",
  ).run(agentIdFactory(), taskId, stepId, operationId, toolName, status, summary.slice(0, 500), json(data), now());
}

/** taskStore.ts:900 */
function findOperation(operationId) {
  const db = getAgentTaskDb();
  return db.prepare("SELECT * FROM tool_operations WHERE operation_id=?").get(operationId);
}

/** taskStore.ts:903 */
function beginOperation(operationId, taskId, toolName, workerId, leaseToken) {
  const db = getAgentTaskDb();
  const step = db.prepare("SELECT id,input_json FROM dx_task_steps WHERE operation_id=? AND task_id=?").get(operationId, taskId);
  if (workerId && leaseToken) {
    return (
      db
        .prepare(
          "INSERT OR IGNORE INTO tool_operations(operation_id,task_id,step_id,tool_name,status,input_hash,created_at) " +
            "SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM dx_tasks WHERE id=? AND worker_id=? AND lease_token=? AND lease_until>=? AND status='running')",
        )
        .run(operationId, taskId, step ? step.id : null, toolName, "running", step ? hashInput(step.input_json) : null, now(), taskId, workerId, leaseToken, now()).changes > 0
    );
  }
  return (
    db
      .prepare("INSERT OR IGNORE INTO tool_operations(operation_id,task_id,step_id,tool_name,status,input_hash,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(operationId, taskId, step ? step.id : null, toolName, "running", step ? hashInput(step.input_json) : null, now()).changes > 0
  );
}

/** taskStore.ts:913 */
function finishOperation(operationId, result, taskId, workerId, leaseToken) {
  const db = getAgentTaskDb();
  if (taskId && workerId && leaseToken) {
    return (
      db
        .prepare(
          "UPDATE tool_operations SET status='completed',result_json=?,completed_at=? WHERE operation_id=? AND task_id=? AND status='running' " +
            "AND EXISTS (SELECT 1 FROM dx_tasks WHERE id=? AND worker_id=? AND lease_token=? AND lease_until>=? AND status='running')",
        )
        .run(json(result), now(), operationId, taskId, taskId, workerId, leaseToken, now()).changes > 0
    );
  }
  return db.prepare("UPDATE tool_operations SET status='completed',result_json=?,completed_at=? WHERE operation_id=? AND status='running'").run(json(result), now(), operationId).changes > 0;
}

/** taskStore.ts:922 */
function addDeliverable(taskId, projectId, nodeId, name) {
  const db = getAgentTaskDb();
  const ts = now();
  db.prepare("INSERT OR IGNORE INTO deliverables(id,task_id,project_id,node_id,name,verification_status,created_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?)").run(
    agentIdFactory(),
    taskId,
    projectId,
    nodeId,
    name,
    ts,
    ts,
  );
}

/** taskStore.ts:934（M4 完成门禁：执行轨迹是否具备完成条件；不要求 nodeId 已在正式项目中） */
function verifyTaskReadiness(taskId) {
  const db = getAgentTaskDb();
  const task = getTask(taskId);
  if (!task) return { ok: false, message: "任务不存在" };
  const project = getProject(task.project_id);
  if (!project) return { ok: false, message: "项目不存在" };
  const run = db.prepare("SELECT id FROM agent_runs WHERE task_id=?").get(taskId);
  if (run) {
    const unresolvedCorrection = db
      .prepare(
        "WITH RECURSIVE run_tree(id) AS (SELECT ? UNION ALL SELECT child.id FROM agent_runs child JOIN run_tree parent ON child.parent_run_id=parent.id) " +
          "SELECT correction.status FROM agent_review_corrections correction JOIN run_tree tree ON tree.id=correction.parent_run_id " +
          "WHERE correction.status!='completed' ORDER BY correction.created_at DESC LIMIT 1",
      )
      .get(run.id);
    if (unresolvedCorrection) return { ok: false, message: "Reviewer Gate 未通过：自动纠正状态为 " + unresolvedCorrection.status };
    const rejectedWithoutCorrection = db
      .prepare(
        "WITH RECURSIVE run_tree(id) AS (SELECT ? UNION ALL SELECT child.id FROM agent_runs child JOIN run_tree parent ON child.parent_run_id=parent.id) " +
          "SELECT 1 FROM agent_artifact_reviews review " +
          "JOIN agent_delegations producer ON producer.child_run_id=review.producer_run_id " +
          "JOIN run_tree tree ON tree.id=producer.parent_run_id " +
          "LEFT JOIN agent_review_corrections correction ON correction.producer_run_id=review.producer_run_id " +
          "WHERE review.decision='rejected' AND correction.id IS NULL LIMIT 1",
      )
      .get(run.id);
    if (rejectedWithoutCorrection) return { ok: false, message: "Reviewer Gate 已拒绝产物且没有成功纠正" };
  }
  if (!task.steps.length) {
    if (task.agent_profile_id === "reviewer" && task.expected_output_schema) return { ok: true, message: "Reviewer 结构化结论已具备提交条件" };
    return { ok: false, message: "任务没有可验证的步骤" };
  }
  if (task.mode === "actions") {
    const unfinished = task.steps.find((step) => step.status !== "completed");
    if (unfinished) return { ok: false, message: "步骤未完成：" + unfinished.title };
  } else {
    const running = task.steps.find((step) => step.status === "running");
    if (running) return { ok: false, message: "步骤仍在执行：" + running.title };
    if (!task.steps.some((step) => step.status === "completed")) return { ok: false, message: "任务没有完成任何实际步骤" };
  }
  for (const step of task.steps) {
    if (!WRITE_TOOLS.has(step.tool_name)) continue;
    try {
      JSON.parse(step.output_json || "{}");
    } catch {
      return { ok: false, message: "步骤结果无效：" + step.title };
    }
  }
  return { ok: true, message: "任务执行轨迹已具备提交条件" };
}

/** taskStore.ts:978（M4 完成门禁：就绪检查 + 提交后的正式项目交付物一致性检查） */
function verifyTask(taskId) {
  const readiness = verifyTaskReadiness(taskId);
  if (!readiness.ok) return readiness;
  const fs = agentFs;
  if (fsAdapterMissing(fs, ["getNode", "isWithinRoot", "findByPath"])) {
    return dependencyUnavailableResult("verifyTask", "fs.ts 虚拟文件树（B6）");
  }
  const task = getTask(taskId);
  const project = getProject(task.project_id);
  for (const step of task.steps) {
    if (!WRITE_TOOLS.has(step.tool_name)) continue;
    try {
      const output = JSON.parse(step.output_json || "{}");
      if (!output.nodeId) continue;
      const node = fs.getNode(output.nodeId);
      if (!node || node.trashed || !fs.isWithinRoot(project.root_node_id, node.id)) {
        return { ok: false, message: "交付物缺失或已被移出项目：" + step.title };
      }
    } catch {
      return { ok: false, message: "步骤结果无效：" + step.title };
    }
  }
  if (task.mode === "actions") {
    for (let index = 0; index < task.steps.length; index += 1) {
      const step = task.steps[index];
      if (!["file.create", "file.write"].includes(step.tool_name)) continue;
      try {
        const output = JSON.parse(step.output_json || "{}");
        const action = JSON.parse(step.input_json || "{}");
        const node = output.nodeId ? fs.getNode(output.nodeId) : null;
        const resolved = action.path ? fs.findByPath(project.root_node_id, action.path) : null;
        if (!node || node.type !== "file" || node.trashed || !fs.isWithinRoot(project.root_node_id, node.id) || !resolved || resolved.id !== node.id) {
          return { ok: false, message: "交付物缺失或无效：" + step.title };
        }
        const overwrittenLater = task.steps.slice(index + 1).some((later) => {
          if (!["file.create", "file.write"].includes(later.tool_name)) return false;
          try {
            return JSON.parse(later.input_json || "{}").path === action.path;
          } catch {
            return false;
          }
        });
        if (action.content !== undefined && !overwrittenLater && node.content !== action.content) {
          return { ok: false, message: "交付物内容不匹配：" + step.title };
        }
      } catch {
        return { ok: false, message: "步骤结果无效：" + step.title };
      }
    }
  }
  return { ok: true, message: "所有步骤和交付物验证通过" };
}

/** taskStore.ts:1019 */
function postTaskMessage(taskId, role, content) {
  const db = getAgentTaskDb();
  const task = db.prepare("SELECT thread_id FROM dx_tasks WHERE id=?").get(taskId);
  if (!task) return;
  db.prepare("INSERT INTO thread_messages(id,thread_id,task_id,role,content,created_at) VALUES (?,?,?,?,?,?)").run(
    agentIdFactory(),
    task.thread_id,
    taskId,
    role,
    content.slice(0, 8000),
    now(),
  );
}

// ── M7 项目记忆：多对话共享的版本化事实（taskStore.ts:1026 起）─────────────

/** taskStore.ts:1034 */
function listMemories(projectId, includeSuperseded) {
  const db = getAgentTaskDb();
  return includeSuperseded
    ? db.prepare("SELECT * FROM project_memories WHERE project_id=? ORDER BY updated_at DESC").all(projectId)
    : db.prepare("SELECT * FROM project_memories WHERE project_id=? AND status='active' ORDER BY updated_at DESC").all(projectId);
}

/** taskStore.ts:1041 */
function addMemory(input) {
  const db = getAgentTaskDb();
  const content = input.content.trim().slice(0, 2000);
  if (!content) throw new Error("记忆内容不能为空");
  const id = agentIdFactory();
  const ts = now();
  return writeTransaction(() => {
    let version = 1;
    if (input.replacesId) {
      const old = db.prepare("SELECT project_id,version FROM project_memories WHERE id=?").get(input.replacesId);
      if (!old || old.project_id !== input.projectId) throw new Error("被取代的记忆不存在");
      version = old.version + 1;
      db.prepare("UPDATE project_memories SET status='superseded',updated_at=? WHERE id=?").run(ts, input.replacesId);
    }
    db.prepare(
      "INSERT INTO project_memories(id,project_id,content,source_type,source_id,version,replaces_id,status,created_by,created_at,updated_at) " +
        "VALUES (?,?,?,?,?,?,?,'active',?,?,?)",
    ).run(id, input.projectId, content, input.sourceType || "user", input.sourceId || null, version, input.replacesId || null, input.createdBy || null, ts, ts);
    return db.prepare("SELECT * FROM project_memories WHERE id=?").get(id);
  });
}

/** taskStore.ts:1060 */
function removeMemory(projectId, memoryId) {
  const db = getAgentTaskDb();
  const changed = db.prepare("UPDATE project_memories SET status='deleted',updated_at=? WHERE id=? AND project_id=?").run(now(), memoryId, projectId).changes > 0;
  if (!changed) throw new Error("记忆不存在");
}

/** taskStore.ts:1066 */
function threadVisibility(threadId) {
  const db = getAgentTaskDb();
  const row = db.prepare("SELECT visibility FROM threads WHERE id=?").get(threadId);
  return row && row.visibility === "private" ? "private" : "project";
}

module.exports = {
  // 注入与结构化常量
  configureAgentTaskStore,
  resetAgentTaskStoreForTests,
  getAgentFsAdapter,
  AGENT_DEPENDENCY_UNAVAILABLE,
  TASK_STATUSES,
  ASSISTANT_MODES,
  DEFAULT_BUDGET,
  DEFAULT_TREE_BUDGET,
  // projects / threads
  projectForRoot,
  createProject,
  getProject,
  listProjects,
  projectPermission,
  ensureProjectMember,
  requireProjectAccess,
  createThread,
  actionsFromRequest,
  // tasks
  createTask,
  recordConversation,
  syncAssistantConversation,
  deleteAssistantConversation,
  importLegacyTask,
  appendTaskEvent,
  addCheckpoint,
  getTask,
  listTaskEvents,
  listTasks,
  projectHistory,
  threadMessages,
  updateTaskStatus,
  consumeBudget,
  appendDynamicStep,
  // durable agent turns / checkpoints
  latestResumableAgentTurn,
  persistAgentTurn,
  advanceAgentTurn,
  completeAgentTurn,
  appendAgentCheckpoint,
  sealStaleReactSteps,
  savePlan,
  // waiting / fenced transitions
  waitForUser,
  waitForChildren,
  failTaskFenced,
  pauseTaskFenced,
  answerTask,
  continueTask,
  refreshTaskInstruction,
  // observability
  taskTrace,
  taskStats,
  findResumableTasks,
  // lifecycle
  pauseTask,
  cancelTask,
  deleteTask,
  resumeTask,
  // worker / lease
  canWorkerRunTask,
  registerWorker,
  heartbeatWorker,
  stopWorker,
  workerHealth,
  recoverExpiredTasks,
  claimNextTask,
  heartbeatTask,
  taskIsRunning,
  enterVerification,
  completeVerifiedTask,
  failVerification,
  // steps
  nextQueuedStep,
  startStep,
  requeueStep,
  requeueReactStepForResume,
  completeStep,
  failStep,
  // tool operations / deliverables
  findOperation,
  beginOperation,
  finishOperation,
  addDeliverable,
  verifyTaskReadiness,
  verifyTask,
  postTaskMessage,
  // memories
  listMemories,
  addMemory,
  removeMemory,
  threadVisibility,
};


