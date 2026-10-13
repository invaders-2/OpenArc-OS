/**
 * D3-01 · Identity 持久层。
 *
 * 这是**第一版身份持久层**，也是唯一一份 users / sessions 的真值。
 *
 * ## 为什么是 SQLite 而不是 JSON 文件（§28）
 *
 *   JSON 文件无法提供"原子事务 + 约束"，而 §5 的 A01 与 §27 的 failure-safe
 *   恰好全靠这两件事：
 *     · 原子事务 → 初始化的 check-then-act 被压进同一个 BEGIN IMMEDIATE，
 *       两个并发请求不可能各写一半
 *     · 约束     → 唯一 installation、唯一 root team、identifier 唯一、
 *                  session → user 外键，全部由数据库强制执行，
 *                  **不是**"UI 应该不会那样做"
 *   因此不用 JSON 落盘当最终身份库（§28 明确禁止把它当作可 PASS 的方案）。
 *
 * ## 库的选择
 *
 *   `node:sqlite`（Node 22.5+ 内置，`DatabaseSync`）——
 *     · **零第三方依赖、零 native 编译**：本机与 Windows 是同一条代码路径，
 *       不会出现"mac 能装、Windows 装不上"这种把阶段卡死的情况
 *     · 真实的 SQL、真实的 ACID 事务、真实的 UNIQUE / CHECK / 外键
 *     · 与 Electron 主进程同 Node 版本一同分发，不需要重新编译
 *
 *   `better-sqlite3` —— 功能更全，但要 native 构建产物；
 *                        D1-06 冻结"不引无法双端验证的 native 依赖"，故不选。
 *
 *   本文件对二者的差异做了隔离：所有 SQL 都只走 `prepare/run/get/all` 四个方法，
 *   换库时改 `openDatabase()` 一处即可。
 *
 * ## 事务与并发（§31）
 *
 *   `transact()` = 连接内互斥队列 + `BEGIN IMMEDIATE` + COMMIT/ROLLBACK。
 *     · 连接内互斥保证"async 事务体"不会被另一个事务体插进来
 *       （KDF 是异步的，事务体里可能 await，这是真实存在的交错点）
 *     · `BEGIN IMMEDIATE` 立刻取写锁，跨连接/跨进程的竞争由 SQLite 仲裁，
 *       败者拿到 SQLITE_BUSY → **有界重试**后重读状态，绝不静默丢写
 */
"use strict";

const crypto = require("node:crypto");
const domain = require("./identity-domain.cjs");
const passwords = require("./password.cjs");
const dxosFoundationSchema = require("./dxos-foundation-schema.cjs");

const { ERROR, INIT, USER_STATUS, USER_ROLE, REVOKE_REASON, RATE_LIMIT } = domain;

/**
 * 当前 schema 版本。
 *
 * D3-01 = v1（identity）；D3-02 = v2（object authorization）；D3-03 = v3（device）；D3-04A = v4（resource store）。
 * 迁移按版本逐级前进，每一级各自是一个原子事务：任何一级失败只回滚该级，
 * 不会留下"user_version 已升级但表不完整"的半状态（§55）。
 *
 * 集成分支上两条线各自用了同一批版本号，合并后按"核心线编号不动、集成线顺延"排：
 *   v17（核心线 D5-02）：canvas_boards 文档层 + canvas_shares / canvas_commands；
 *   v18（核心线 D5-02 Closure）：canvas_runs（一次生成 = 一个 Task）；
 *   v19（UI/D3-01b 集成线）：users 增加 avatar_ref TEXT（可空），承载显示名之外的资料字段；
 *   v20（D5-03 第一批 · MCP 中心）：mcp_connections 连接记录 + mcp_credentials 凭据元数据
 *        + mcp_connection_logs 测试日志（raw secret 只进 OS 安全后端，库里只有 credential_ref）。
 *   v21（D5-03 第二批 · 授权收口）：app_policy_provisions 内置策略提供记录（"首次使用才给、
 *        撤销后永不再给"的持久依据），并把 organization_id 纳入 app_resource_grants 唯一键
 *        （SQLite 改不了约束，按既有迁移做法重建表，逐行搬运）。
 *        迁移历史：session 事件里无条件重 upsert baseline → 撤销（删行）在下次登录被复活；
 *        唯一键不含 organization_id → 两个组织对同一 (app,type,scope) 的授权互相覆盖。
 * 核心线已升到 v18 的库继续往上走 v19（avatar_ref 幂等补列）；
 *   v22（P1 · DX OS 地基）：把 DX OS 0.5.1 的表并入 identity.db（只新增，不动既有表）。
 *        为什么并进同一个库而不是另开一个：现有各域共用同一条连接与 BEGIN IMMEDIATE 互斥队列，
 *        跨域事务（任务 ↔ 画布 ↔ 技能）在 DX OS 里本来就是同库完成；另开库会让这些事务失去原子性。
 *        与 OpenArc 同名的 5 张表（projects / project_members / tasks / task_steps / task_events）
 *        刻意跳过 —— 理由与来源见 dxos-foundation-schema.cjs 顶部注释。
 * 集成线已升到 v17 的库补跑 v18/v19（画布文档层与运行归属表）。
 */
const SCHEMA_VERSION = 22;

/**
 * Schema。为了可读性写成整段 DDL。
 *
 * 三处"数据库级"硬约束，是本轮 A01 与 §30 的机器保证：
 *   ① installations.singleton  CHECK(singleton = 1) + PRIMARY KEY
 *      → **物理上不可能有第二个 installation**
 *   ② teams 上的 partial unique index (root) WHERE root = 1
 *      → 不可能有两个 root workspace
 *   ③ users.identifier UNIQUE
 *      → identifier 唯一性不靠 UI
 */
const SCHEMA_SQL = `
CREATE TABLE installations (
  singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
  id              TEXT    NOT NULL UNIQUE,
  status          TEXT    NOT NULL CHECK (status IN ('UNINITIALIZED','INITIALIZING','READY')),
  created_at      INTEGER NOT NULL,
  initialized_at  INTEGER
);

CREATE TABLE teams (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  root        INTEGER NOT NULL DEFAULT 0 CHECK (root IN (0,1)),
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_teams_single_root ON teams(root) WHERE root = 1;

CREATE TABLE users (
  id                TEXT    PRIMARY KEY,
  installation_id   TEXT    NOT NULL REFERENCES installations(id),
  team_id           TEXT    NOT NULL REFERENCES teams(id),
  identifier        TEXT    NOT NULL UNIQUE,
  display_name      TEXT    NOT NULL,
  role              TEXT    NOT NULL CHECK (role IN ('ADMIN','MEMBER')),
  status            TEXT    NOT NULL CHECK (status IN ('ACTIVE','DISABLED')),
  avatar_ref        TEXT,
  auth_version      INTEGER NOT NULL DEFAULT 1,
  password_algo     TEXT    NOT NULL,
  password_params   TEXT    NOT NULL,
  password_salt     BLOB    NOT NULL,
  password_hash     TEXT    NOT NULL,
  password_version  INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_users_status ON users(status);

CREATE TABLE sessions (
  id               TEXT    PRIMARY KEY,
  ref              TEXT    NOT NULL UNIQUE,
  user_id          TEXT    NOT NULL REFERENCES users(id),
  installation_id  TEXT    NOT NULL,
  token_hash       TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  idle_expires_at  INTEGER NOT NULL,
  revoked_at       INTEGER,
  revoked_reason   TEXT,
  locked_at        INTEGER,
  reauth_at        INTEGER,
  auth_version     INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash);

CREATE TABLE login_attempts (
  id                TEXT    PRIMARY KEY,
  identifier_hash   TEXT    NOT NULL,
  source            TEXT    NOT NULL,
  failures          INTEGER NOT NULL DEFAULT 0,
  first_failure_at  INTEGER NOT NULL,
  last_failure_at   INTEGER NOT NULL,
  cooldown_until    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE audit_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  at               INTEGER NOT NULL,
  event            TEXT    NOT NULL,
  user_ref         TEXT,
  session_ref_hash TEXT,
  result           TEXT    NOT NULL,
  error_code       TEXT,
  duration_ms      INTEGER
);
CREATE INDEX idx_audit_at ON audit_log(at);
`;

/**
 * D3-02 v2：对象授权 schema。
 *
 * 这里只保存**授权所需的身份信息**（Resource Registry），不是 Resource Library
 * 内容数据库：内容、文件路径、thumbnail、媒体 metadata 属 D3-04。
 *
 * 数据库级约束（§56）：
 *   · resource_registry.resource_id PRIMARY KEY      → 稳定 ResourceRef 唯一
 *   · departments (organization_id, name) UNIQUE      → 部门身份唯一
 *   · department_memberships (department_id, user_id) UNIQUE → 成员唯一
 *   · resource_grants / app_resource_grants 多列 UNIQUE → Grant 不产生不可解释重复
 *   · departments (id, organization_id) UNIQUE + 复合外键 → organization consistency
 *   · 目标字段一律 NOT NULL DEFAULT ''（不用 NULL）→ UNIQUE 在 SQLite 里才对 NULL 生效
 */
const SCHEMA_V2_SQL = `
CREATE TABLE departments (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL CHECK (status IN ('ACTIVE','DISABLED')) DEFAULT 'ACTIVE',
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (organization_id, name),
  UNIQUE (id, organization_id)
);

CREATE TABLE department_memberships (
  id              TEXT PRIMARY KEY,
  department_id   TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users(id),
  membership_role TEXT NOT NULL CHECK (membership_role IN ('department-admin','member')),
  status          TEXT NOT NULL CHECK (status IN ('ACTIVE','DISABLED')) DEFAULT 'ACTIVE',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (department_id, user_id),
  FOREIGN KEY (department_id, organization_id) REFERENCES departments(id, organization_id)
);
CREATE INDEX idx_dept_members_user ON department_memberships(user_id);
CREATE INDEX idx_dept_members_dept ON department_memberships(department_id);

CREATE TABLE collections (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  department_id   TEXT,
  owner_user_id   TEXT,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  scope           TEXT NOT NULL CHECK (scope IN ('PERSONAL','DEPARTMENT','ORGANIZATION')),
  status          TEXT NOT NULL CHECK (status IN ('active','disabled','deleted')) DEFAULT 'active',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_collections_org ON collections(organization_id);

CREATE TABLE resource_registry (
  resource_id        TEXT PRIMARY KEY,
  resource_type      TEXT NOT NULL,
  owner_user_id      TEXT,
  organization_id    TEXT NOT NULL,
  department_id      TEXT,
  collection_id      TEXT,
  scope              TEXT NOT NULL CHECK (scope IN ('PERSONAL','DEPARTMENT','ORGANIZATION')),
  parent_resource_id TEXT,
  name               TEXT NOT NULL DEFAULT '',
  description        TEXT NOT NULL DEFAULT '',
  tags               TEXT NOT NULL DEFAULT '[]',
  version            INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL CHECK (status IN ('active','disabled','deleted')) DEFAULT 'active',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (department_id, organization_id) REFERENCES departments(id, organization_id),
  FOREIGN KEY (collection_id) REFERENCES collections(id)
);
CREATE INDEX idx_registry_org ON resource_registry(organization_id);
CREATE INDEX idx_registry_dept ON resource_registry(department_id);
CREATE INDEX idx_registry_collection ON resource_registry(collection_id);
CREATE INDEX idx_registry_type ON resource_registry(resource_type);
CREATE INDEX idx_registry_owner ON resource_registry(owner_user_id);

CREATE TABLE resource_grants (
  id              TEXT PRIMARY KEY,
  principal_type  TEXT NOT NULL CHECK (principal_type IN ('USER','DEPARTMENT')),
  principal_id    TEXT NOT NULL,
  resource_id     TEXT NOT NULL DEFAULT '',
  collection_id   TEXT NOT NULL DEFAULT '',
  resource_type   TEXT NOT NULL DEFAULT '',
  department_id   TEXT NOT NULL DEFAULT '',
  scope           TEXT NOT NULL DEFAULT '',
  actions         TEXT NOT NULL,
  permission_set  TEXT,
  granted_by      TEXT,
  organization_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (principal_type, principal_id, resource_id, collection_id, resource_type, department_id, scope)
);
CREATE INDEX idx_rgrants_principal ON resource_grants(principal_type, principal_id);
CREATE INDEX idx_rgrants_resource ON resource_grants(resource_id);
CREATE INDEX idx_rgrants_collection ON resource_grants(collection_id);

CREATE TABLE app_principals (
  app_id     TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  publisher  TEXT NOT NULL DEFAULT 'openarc-builtin',
  status     TEXT NOT NULL CHECK (status IN ('enabled','disabled')) DEFAULT 'enabled',
  built_in   INTEGER NOT NULL DEFAULT 1 CHECK (built_in IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE app_resource_grants (
  id              TEXT PRIMARY KEY,
  app_id          TEXT NOT NULL REFERENCES app_principals(app_id),
  resource_id     TEXT NOT NULL DEFAULT '',
  collection_id   TEXT NOT NULL DEFAULT '',
  resource_type   TEXT NOT NULL DEFAULT '',
  department_id   TEXT NOT NULL DEFAULT '',
  scope           TEXT NOT NULL DEFAULT '',
  actions         TEXT NOT NULL,
  granted_by      TEXT,
  organization_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,
  UNIQUE (app_id, resource_id, collection_id, resource_type, department_id, scope)
);
CREATE INDEX idx_agrants_app ON app_resource_grants(app_id);

CREATE TABLE authorization_audit (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  at                INTEGER NOT NULL,
  actor_user_id     TEXT,
  target_user_id    TEXT,
  app_id            TEXT,
  department_id     TEXT,
  resource_ref      TEXT,
  action            TEXT NOT NULL,
  decision          TEXT NOT NULL,
  reason_code       TEXT,
  permission_source TEXT,
  request_id        TEXT,
  old_permissions   TEXT,
  new_permissions   TEXT
);
CREATE INDEX idx_authz_audit_at ON authorization_audit(at);
CREATE INDEX idx_authz_audit_actor ON authorization_audit(actor_user_id);

INSERT INTO app_principals (app_id, name, publisher, status, built_in, created_at, updated_at)
VALUES
  ('resource-library','资源库','openarc-builtin','enabled',1,0,0),
  ('canvas','无限画布','openarc-builtin','enabled',1,0,0),
  ('browser','浏览器','openarc-builtin','enabled',1,0,0),
  ('ai','全局 AI','openarc-builtin','enabled',1,0,0),
  ('image-generator','图像生成','openarc-builtin','enabled',1,0,0),
  ('video-generator','视频生成','openarc-builtin','enabled',1,0,0),
  ('photoshop','Photoshop','openarc-builtin','enabled',1,0,0),
  ('illustrator','Illustrator','openarc-builtin','enabled',1,0,0),
  ('mcp-center','MCP 中心','openarc-builtin','enabled',1,0,0),
  ('skill-runtime','技能运行时','openarc-builtin','enabled',1,0,0);
`;

/**
 * D3-03 = v3（device identity / registry / pairing / TLS）。
 *
 * 四张表 + 一张审计表，边界刻意划清：
 *   devices                      —— Registry 唯一权威（状态、组织、当前 credentialVersion）
 *   device_pairing_credentials   —— bootstrap 专用，**只存 secret 的 sha256**，不存明文（§47）
 *   device_credentials           —— 凭据历史，支撑轮换（§28）与"旧版本必须失效"（§25 §29）
 *   device_access                —— Organization / Department / Explicit User 三种主体（§11）
 *   device_audit                 —— 与 authorization_audit 同风格，字段按 §46
 *
 * 为什么 devices.certificate_identity 与 device_credentials.fingerprint 都要有唯一索引：
 * 证书身份是**运行时热路径**的查找键（TLS 握手后拿 fingerprint 反查设备），
 * 一旦出现两行同 fingerprint，"这个连接是谁"就没有唯一答案了 —— 那是安全漏洞，不是数据质量问题。
 */
const SCHEMA_V3_SQL = `
CREATE TABLE devices (
  id                   TEXT PRIMARY KEY,
  organization_id      TEXT    NOT NULL,
  display_name         TEXT    NOT NULL,
  platform             TEXT    NOT NULL DEFAULT 'unknown',
  architecture         TEXT    NOT NULL DEFAULT 'unknown',
  status               TEXT    NOT NULL CHECK (status IN ('PENDING','ACTIVE','DISABLED','REVOKED')),
  registered_at        INTEGER,
  registered_by        TEXT,
  last_seen_at         INTEGER,
  certificate_identity TEXT,
  credential_version   INTEGER NOT NULL DEFAULT 0 CHECK (credential_version >= 0),
  agent_version        TEXT,
  metadata_version     INTEGER NOT NULL DEFAULT 1,
  department_id        TEXT,
  connectivity         TEXT    NOT NULL DEFAULT 'UNKNOWN' CHECK (connectivity IN ('ONLINE','OFFLINE','UNKNOWN')),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX idx_devices_org ON devices(organization_id);
CREATE INDEX idx_devices_status ON devices(status);
CREATE UNIQUE INDEX idx_devices_cert ON devices(certificate_identity) WHERE certificate_identity IS NOT NULL;

CREATE TABLE device_pairing_credentials (
  id                   TEXT PRIMARY KEY,
  organization_id      TEXT    NOT NULL,
  secret_hash          TEXT    NOT NULL UNIQUE,
  status               TEXT    NOT NULL CHECK (status IN ('ISSUED','CONSUMED','EXPIRED','REVOKED')),
  issued_by            TEXT    NOT NULL,
  issued_at            INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  consumed_at          INTEGER,
  consumed_by_device_id TEXT,
  department_id        TEXT,
  created_at           INTEGER NOT NULL
);
CREATE INDEX idx_pairing_org ON device_pairing_credentials(organization_id);
CREATE INDEX idx_pairing_status ON device_pairing_credentials(status);

CREATE TABLE device_credentials (
  id                 TEXT PRIMARY KEY,
  device_id          TEXT    NOT NULL REFERENCES devices(id),
  organization_id    TEXT    NOT NULL,
  credential_version INTEGER NOT NULL,
  subject            TEXT    NOT NULL,
  fingerprint        TEXT    NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('ACTIVE','ROTATED','REVOKED')),
  not_before         INTEGER NOT NULL,
  not_after          INTEGER NOT NULL,
  issued_at          INTEGER NOT NULL,
  rotated_at         INTEGER,
  UNIQUE (device_id, credential_version)
);
CREATE UNIQUE INDEX idx_devcred_fingerprint ON device_credentials(fingerprint);
CREATE INDEX idx_devcred_device ON device_credentials(device_id, status);

CREATE TABLE device_access (
  id              TEXT PRIMARY KEY,
  device_id       TEXT    NOT NULL REFERENCES devices(id),
  organization_id TEXT    NOT NULL,
  principal_type  TEXT    NOT NULL CHECK (principal_type IN ('ORGANIZATION','DEPARTMENT','USER')),
  principal_id    TEXT    NOT NULL DEFAULT '',
  actions         TEXT    NOT NULL,
  granted_by      TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,
  UNIQUE (device_id, principal_type, principal_id)
);
CREATE INDEX idx_daccess_device ON device_access(device_id);

CREATE TABLE device_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              INTEGER NOT NULL,
  actor_user_id   TEXT,
  device_id       TEXT,
  organization_id TEXT,
  event           TEXT    NOT NULL,
  reason_code     TEXT,
  request_id      TEXT,
  detail          TEXT
);
CREATE INDEX idx_device_audit_at ON device_audit(at);
CREATE INDEX idx_device_audit_device ON device_audit(device_id);
`;

/**
 * D3-04A v4：本地资源对象与存储。
 *
 * 关键分层：resource_registry（D3-02）继续是**逻辑身份 / 授权权威**；
 * library_resources 只承载存储语义（mime / storageMode / contentObject / version / trash）。
 * 二者共享 resourceId，不从新建第二身份系统。
 *
 * DB 与文件系统之间**没有真正的 ACID**：import 用显式状态机 + 可重放的 recovery，
 * 不允许写成 "DB + filesystem atomic transaction"。
 */
const SCHEMA_V4_SQL = `
CREATE TABLE content_objects (
  content_id         TEXT PRIMARY KEY,
  checksum_algorithm TEXT    NOT NULL DEFAULT 'sha256',
  checksum           TEXT    NOT NULL,
  size               INTEGER NOT NULL,
  internal_key       TEXT    NOT NULL,
  ref_count          INTEGER NOT NULL DEFAULT 0,
  status             TEXT    NOT NULL CHECK (status IN ('OBJECT_READY','GC_PENDING','DELETED')) DEFAULT 'OBJECT_READY',
  organization_id    TEXT    NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (checksum_algorithm, checksum, size)
);
CREATE INDEX idx_content_objects_checksum ON content_objects(checksum);
CREATE INDEX idx_content_objects_status ON content_objects(status);

CREATE TABLE library_resources (
  resource_id            TEXT PRIMARY KEY REFERENCES resource_registry(resource_id) ON DELETE CASCADE,
  resource_type          TEXT    NOT NULL,
  mime_type              TEXT    NOT NULL DEFAULT 'application/octet-stream',
  name                   TEXT    NOT NULL DEFAULT '',
  description            TEXT    NOT NULL DEFAULT '',
  storage_mode           TEXT    NOT NULL CHECK (storage_mode IN ('MANAGED','LINKED')),
  content_object_id      TEXT REFERENCES content_objects(content_id),
  checksum               TEXT,
  size                   INTEGER,
  source                 TEXT    NOT NULL DEFAULT 'user',
  version                INTEGER NOT NULL DEFAULT 1,
  storage_device_id      TEXT,
  source_locator         TEXT,
  source_identity        TEXT,
  observed_size          INTEGER,
  observed_mtime         INTEGER,
  generated_source_task_id TEXT,
  generated_source_call_id TEXT,
  generated_source_model   TEXT,
  index_status           TEXT    NOT NULL DEFAULT 'NOT_INDEXED',
  trash_state            TEXT    NOT NULL CHECK (trash_state IN ('ACTIVE','TRASHED')) DEFAULT 'ACTIVE',
  deleted_at             INTEGER,
  deleted_by             TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX idx_library_resources_mode ON library_resources(storage_mode);
CREATE INDEX idx_library_resources_content ON library_resources(content_object_id);
CREATE INDEX idx_library_resources_device ON library_resources(storage_device_id);
CREATE INDEX idx_library_resources_trash ON library_resources(trash_state);
CREATE INDEX idx_library_resources_type ON library_resources(resource_type);

CREATE TABLE resource_versions (
  id                TEXT PRIMARY KEY,
  resource_id       TEXT    NOT NULL REFERENCES resource_registry(resource_id) ON DELETE CASCADE,
  version           INTEGER NOT NULL,
  content_object_id TEXT REFERENCES content_objects(content_id),
  checksum          TEXT,
  size              INTEGER,
  storage_mode      TEXT    NOT NULL CHECK (storage_mode IN ('MANAGED','LINKED')),
  storage_device_id TEXT,
  source_locator    TEXT,
  source            TEXT    NOT NULL DEFAULT 'user',
  created_by        TEXT,
  created_at        INTEGER NOT NULL,
  UNIQUE (resource_id, version)
);
CREATE INDEX idx_resource_versions_resource ON resource_versions(resource_id);
CREATE INDEX idx_resource_versions_content ON resource_versions(content_object_id);

CREATE TABLE resource_relations (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT    NOT NULL,
  from_resource_id TEXT    NOT NULL REFERENCES resource_registry(resource_id) ON DELETE CASCADE,
  to_resource_id   TEXT    NOT NULL REFERENCES resource_registry(resource_id) ON DELETE CASCADE,
  relation_type    TEXT    NOT NULL CHECK (relation_type IN ('references','derived-from','generated-from')),
  created_by       TEXT,
  created_at       INTEGER NOT NULL,
  UNIQUE (from_resource_id, to_resource_id, relation_type)
);
CREATE INDEX idx_resource_relations_from ON resource_relations(from_resource_id);
CREATE INDEX idx_resource_relations_to ON resource_relations(to_resource_id);

CREATE TABLE resource_import_jobs (
  id              TEXT PRIMARY KEY,
  organization_id TEXT    NOT NULL,
  actor_user_id   TEXT,
  app_id          TEXT,
  storage_mode    TEXT    NOT NULL CHECK (storage_mode IN ('MANAGED','LINKED')),
  phase           TEXT    NOT NULL CHECK (phase IN ('STAGING','HASHED','OBJECT_READY','COMMITTING','AVAILABLE','FAILED','CANCELLED','ORPHANED')),
  staging_key     TEXT,
  source_locator  TEXT,
  checksum        TEXT,
  size            INTEGER,
  bytes_total     INTEGER,
  bytes_processed INTEGER NOT NULL DEFAULT 0,
  resource_id     TEXT,
  error_code      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_resource_import_jobs_phase ON resource_import_jobs(phase);
CREATE INDEX idx_resource_import_jobs_resource ON resource_import_jobs(resource_id);
`;

/**
 * D3-04B v5：Resource Library 分类与 per-user 状态。
 *
 * 复用 D3-02 已存在的 collections 表作为 primary Collection 关系（记录在 resource_registry.collection_id），
 * 不创建第二套 Collection identity。新增 tags / resource_tags（多对多）与 resource_favorites / resource_recent（per-user）。
 * memory_subtype / language / attributes 是 Resource 级 metadata，不产生内容 version。
 */
const SCHEMA_V5_SQL = `
CREATE TABLE tags (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('user','system','agent')) DEFAULT 'user',
  created_by      TEXT,
  status          TEXT NOT NULL CHECK (status IN ('active','deleted')) DEFAULT 'active',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (organization_id, normalized_name)
);
CREATE INDEX idx_tags_org ON tags(organization_id);
CREATE INDEX idx_tags_normalized ON tags(organization_id, normalized_name);

CREATE TABLE resource_tags (
  id              TEXT PRIMARY KEY,
  resource_id     TEXT NOT NULL REFERENCES resource_registry(resource_id) ON DELETE CASCADE,
  tag_id          TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('user','system','agent')) DEFAULT 'user',
  assigned_by     TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (resource_id, tag_id)
);
CREATE INDEX idx_resource_tags_resource ON resource_tags(resource_id);
CREATE INDEX idx_resource_tags_tag ON resource_tags(tag_id);

CREATE TABLE resource_favorites (
  user_id         TEXT NOT NULL,
  resource_id     TEXT NOT NULL REFERENCES resource_registry(resource_id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, resource_id)
);
CREATE INDEX idx_favorites_user ON resource_favorites(user_id, created_at);

CREATE TABLE resource_recent (
  user_id        TEXT NOT NULL,
  resource_id    TEXT NOT NULL REFERENCES resource_registry(resource_id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  last_opened_at INTEGER NOT NULL,
  open_count     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, resource_id)
);
CREATE INDEX idx_recent_user ON resource_recent(user_id, last_opened_at);

ALTER TABLE library_resources ADD COLUMN memory_subtype TEXT;
ALTER TABLE library_resources ADD COLUMN language TEXT;
ALTER TABLE library_resources ADD COLUMN attributes TEXT NOT NULL DEFAULT '{}';
`;

/**
 * D3-04C v6：本地授权搜索 / 索引 / 预览缓存。
 *
 * resource_search_docs + resource_search_fts + resource_index_jobs + resource_preview_cache 都是**派生数据**，
 * 不是 Resource Identity 权威；它们可以随时从 resource_registry / library_resources / resource_versions 重建。
 * CJK 由 JS 控制的分词（unigram + bigram）写入 token 列，unicode61 只做分词容器。
 */
const SCHEMA_V6_SQL = `
CREATE TABLE resource_search_docs (
  resource_id       TEXT PRIMARY KEY REFERENCES resource_registry(resource_id) ON DELETE CASCADE,
  resource_version  INTEGER NOT NULL,
  content_checksum  TEXT,
  index_version     INTEGER NOT NULL DEFAULT 1,
  index_status      TEXT NOT NULL CHECK (index_status IN ('PENDING','INDEXING','READY','STALE','NO_TEXT','UNAVAILABLE','FAILED')) DEFAULT 'PENDING',
  name              TEXT NOT NULL DEFAULT '',
  description       TEXT NOT NULL DEFAULT '',
  tags_text         TEXT NOT NULL DEFAULT '',
  collection_name   TEXT NOT NULL DEFAULT '',
  content_text      TEXT NOT NULL DEFAULT '',
  content_truncated INTEGER NOT NULL DEFAULT 0,
  indexed_at        INTEGER,
  error_code        TEXT,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_search_docs_status ON resource_search_docs(index_status);
CREATE INDEX idx_search_docs_version ON resource_search_docs(resource_id, resource_version);

CREATE VIRTUAL TABLE resource_search_fts USING fts5(
  resource_id UNINDEXED,
  index_version UNINDEXED,
  name_tokens,
  description_tokens,
  tag_tokens,
  collection_tokens,
  content_tokens,
  tokenize = 'unicode61'
);

CREATE TABLE resource_index_jobs (
  id               TEXT PRIMARY KEY,
  resource_id      TEXT NOT NULL,
  resource_version INTEGER NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('QUEUED','RUNNING','DONE','FAILED','CANCELLED')) DEFAULT 'QUEUED',
  attempts         INTEGER NOT NULL DEFAULT 0,
  error_code       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (resource_id, resource_version)
);
CREATE INDEX idx_index_jobs_state ON resource_index_jobs(state);

CREATE TABLE resource_preview_cache (
  cache_key        TEXT PRIMARY KEY,
  resource_id      TEXT NOT NULL REFERENCES resource_registry(resource_id) ON DELETE CASCADE,
  resource_version INTEGER NOT NULL,
  content_checksum TEXT,
  preview_kind     TEXT NOT NULL,
  preview_version  INTEGER NOT NULL DEFAULT 1,
  storage_key      TEXT NOT NULL,
  size             INTEGER,
  mime_type        TEXT,
  status           TEXT NOT NULL CHECK (status IN ('READY','FAILED','UNSUPPORTED')) DEFAULT 'READY',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_preview_cache_resource ON resource_preview_cache(resource_id);
`;

/** 迁移阶梯。新增 version 时把新 schema 追加在末尾，不改旧条目。 */
/**
 * D3-04D v7：Projects / Canvas Resource 集成。
 *
 * 只新增真正需要的集成表；**不建第二套 ACL**：
 * - projects / project_members / project_resources 只表达"项目引用了哪个 ResourceRef"，
 *   资源访问权限仍逐资源走 D3-02 Authorization。
 * - canvas_boards / canvas_resource_nodes 保存 ResourceRef + version_mode（PIN_VERSION / FOLLOW_LATEST），
 *   绝不保存绝对路径。
 * 所有权转移 / 治理策略沿用 authorization_audit，不额外造表。
 */
const SCHEMA_V7_SQL = `
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  department_id   TEXT,
  owner_user_id   TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL CHECK (status IN ('active','archived')) DEFAULT 'active',
  scope           TEXT NOT NULL CHECK (scope IN ('PERSONAL','DEPARTMENT','ORGANIZATION')) DEFAULT 'PERSONAL',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_projects_org ON projects(organization_id, status);
CREATE INDEX idx_projects_dept ON projects(department_id);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('viewer','editor','manager')) DEFAULT 'viewer',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX idx_project_members_user ON project_members(user_id);

CREATE TABLE project_resources (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL,
  added_by    TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, resource_id)
);
CREATE INDEX idx_project_resources_resource ON project_resources(resource_id);

CREATE TABLE canvas_boards (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL,
  name            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_canvas_boards_org ON canvas_boards(organization_id);

CREATE TABLE canvas_resource_nodes (
  id               TEXT PRIMARY KEY,
  board_id         TEXT NOT NULL REFERENCES canvas_boards(id) ON DELETE CASCADE,
  resource_id      TEXT NOT NULL,
  resource_version INTEGER NOT NULL,
  version_mode     TEXT NOT NULL CHECK (version_mode IN ('PIN_VERSION','FOLLOW_LATEST')) DEFAULT 'PIN_VERSION',
  x                REAL NOT NULL DEFAULT 0,
  y                REAL NOT NULL DEFAULT 0,
  created_by       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_canvas_nodes_board ON canvas_resource_nodes(board_id);
CREATE INDEX idx_canvas_nodes_resource ON canvas_resource_nodes(resource_id);
`;

/** 迁移阶梯。新增 version 时把新 schema 追加在末尾，不改旧条目。 */
/**
 * D4-01 v8：Model Provider / Model Config / Default / Credential metadata / Call records。
 * 只存 credentialRef；raw secret 永不在库中。
 */
const SCHEMA_V8_SQL = `
CREATE TABLE model_providers (
  provider_id     TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_user_id   TEXT,
  scope           TEXT NOT NULL CHECK (scope IN ('PERSONAL','ORGANIZATION')) DEFAULT 'PERSONAL',
  display_name    TEXT NOT NULL,
  adapter_type    TEXT NOT NULL DEFAULT 'openai-compatible',
  base_url        TEXT NOT NULL,
  endpoint_scope  TEXT NOT NULL CHECK (endpoint_scope IN ('REMOTE_HTTPS','LOCALHOST','LAN_EXPLICIT')) DEFAULT 'REMOTE_HTTPS',
  status          TEXT NOT NULL CHECK (status IN ('enabled','disabled')) DEFAULT 'enabled',
  credential_ref  TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_model_providers_org ON model_providers(organization_id, scope);

CREATE TABLE model_configs (
  config_id            TEXT PRIMARY KEY,
  provider_id          TEXT NOT NULL REFERENCES model_providers(provider_id) ON DELETE CASCADE,
  organization_id      TEXT NOT NULL,
  owner_user_id        TEXT,
  scope                TEXT NOT NULL CHECK (scope IN ('PERSONAL','ORGANIZATION')) DEFAULT 'PERSONAL',
  display_name         TEXT NOT NULL DEFAULT '',
  remote_model_id      TEXT NOT NULL,
  capabilities         TEXT NOT NULL DEFAULT '[]',
  verified_capabilities TEXT NOT NULL DEFAULT '[]',
  status               TEXT NOT NULL CHECK (status IN ('enabled','disabled')) DEFAULT 'enabled',
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX idx_model_configs_provider ON model_configs(provider_id);
CREATE INDEX idx_model_configs_owner ON model_configs(owner_user_id, scope);

CREATE TABLE model_defaults (
  organization_id TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL DEFAULT '',
  capability      TEXT NOT NULL,
  config_id       TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (organization_id, owner_user_id, capability)
);

CREATE TABLE model_credentials (
  credential_ref    TEXT PRIMARY KEY,
  owner_user_id     TEXT NOT NULL,
  organization_id   TEXT NOT NULL,
  scope             TEXT NOT NULL CHECK (scope IN ('PERSONAL','ORGANIZATION')) DEFAULT 'PERSONAL',
  provider_origin   TEXT NOT NULL,
  provider_config_id TEXT,
  credential_version INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL CHECK (status IN ('CONFIGURED','MISSING','DELETED')) DEFAULT 'CONFIGURED',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_model_credentials_owner ON model_credentials(owner_user_id);

CREATE TABLE model_call_records (
  id             TEXT PRIMARY KEY,
  request_id     TEXT,
  user_id        TEXT,
  app_id         TEXT,
  provider_id    TEXT,
  model_id       TEXT,
  config_version INTEGER,
  started_at     INTEGER NOT NULL,
  duration_ms    INTEGER,
  status         TEXT NOT NULL,
  error_code     TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  total_tokens   INTEGER
);
CREATE INDEX idx_model_call_records_at ON model_call_records(started_at);
`;


/**
 * v9（D4-02A）· Task Runtime 持久权威。
 *
 * 只落 Task / TaskStep / ModelCall / TaskEvent 四张表 + 索引；
 * ToolProposal / Artifact / Verification 需要时再单独迁一级。
 * 无 task_acl / task_role / task_permissions —— 权限复用 D3 Identity / Authorization。
 */
const SCHEMA_V9_SQL = `
CREATE TABLE tasks (
  task_id                TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL,
  session_ref            TEXT,
  app_id                 TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','WAITING','SUCCEEDED','FAILED','CANCELLED','BLOCKED')),
  goal                   TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  started_at             INTEGER,
  completed_at           INTEGER,
  model_config_id        TEXT,
  model_config_version   INTEGER,
  current_step_id        TEXT,
  revision               INTEGER NOT NULL DEFAULT 1,
  cancel_requested       INTEGER NOT NULL DEFAULT 0,
  budget_snapshot        TEXT,
  permission_snapshot_ref TEXT
);
CREATE INDEX idx_tasks_user_status ON tasks(user_id, status);
CREATE INDEX idx_tasks_app ON tasks(app_id);

CREATE TABLE task_steps (
  step_id      TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  sequence     INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED','BLOCKED')),
  input        TEXT,
  output_ref   TEXT,
  started_at   INTEGER,
  completed_at INTEGER,
  attempt      INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  UNIQUE (task_id, sequence)
);
CREATE INDEX idx_task_steps_task_seq ON task_steps(task_id, sequence);

CREATE TABLE task_model_calls (
  call_id              TEXT PRIMARY KEY,
  task_id              TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  step_id              TEXT,
  model_config_id      TEXT,
  model_config_version INTEGER,
  request_id           TEXT,
  status               TEXT NOT NULL CHECK (status IN ('STARTED','SUCCEEDED','FAILED','CANCELLED')),
  started_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  usage                TEXT,
  provider_error_code  TEXT
);
CREATE INDEX idx_task_model_calls_task_step ON task_model_calls(task_id, step_id);

CREATE TABLE task_events (
  event_id     TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  sequence     INTEGER NOT NULL,
  event_type   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  safe_payload TEXT,
  UNIQUE (task_id, sequence)
);
CREATE INDEX idx_task_events_task_seq ON task_events(task_id, sequence);
`;

/**
 * v10（D4-02C）· Task ↔ Harness Orchestration 持久权威。
 *
 * 只落 HarnessRun / Artifact / Verification 三张表；**不存 proxy token /
 * provider key / 完整 ACP transcript / 完整 reasoning**。Task artifact 是
 * Task Runtime 内部产物，不等于 Resource Library。
 */
const SCHEMA_V10_SQL = `
CREATE TABLE task_harness_runs (
  run_id                TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  step_id               TEXT,
  status                TEXT NOT NULL CHECK (status IN ('STARTING','RUNNING','SUCCEEDED','BLOCKED','CANCELLED','FAILED')),
  harness_version       TEXT,
  acp_version           TEXT,
  model_config_id       TEXT,
  model_config_version  INTEGER,
  started_at            INTEGER NOT NULL,
  completed_at          INTEGER,
  stop_reason           TEXT,
  error_code            TEXT
);
CREATE INDEX idx_task_harness_runs_task ON task_harness_runs(task_id, started_at);

CREATE TABLE task_artifacts (
  artifact_id  TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  step_id      TEXT,
  run_id       TEXT,
  type         TEXT NOT NULL CHECK (type IN ('text','json')),
  safe_content TEXT,
  checksum     TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_task_artifacts_task ON task_artifacts(task_id, created_at);

CREATE TABLE task_verifications (
  verification_id TEXT PRIMARY KEY,
  artifact_id     TEXT NOT NULL REFERENCES task_artifacts(artifact_id) ON DELETE CASCADE,
  task_id         TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('PASS','FAIL')),
  safe_details    TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_task_verifications_task ON task_verifications(task_id, created_at);
`;

/**
 * v11（D4-03A）· Controlled Tool Proxy 持久化。
 *
 * task_tool_proposals 只存安全 projection + arguments_hash，**绝不存完整 raw arguments /
 * credential / absolute path**；tool_decisions 每个 proposal 至多一条（§39 幂等）。
 * 无 tool_executions —— D4-03A 不存在真实执行。
 */
const SCHEMA_V11_SQL = `
CREATE TABLE task_tool_proposals (
  proposal_id     TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  step_id         TEXT,
  run_id          TEXT,
  tool_id         TEXT NOT NULL,
  tool_version    INTEGER NOT NULL,
  arguments_safe  TEXT,
  arguments_hash  TEXT,
  status          TEXT NOT NULL CHECK (status IN ('PROPOSED','VALIDATED','DENIED','APPROVAL_REQUIRED','INVALID','BLOCKED')),
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_task_tool_proposals_task ON task_tool_proposals(task_id, created_at);

CREATE TABLE tool_decisions (
  decision_id        TEXT PRIMARY KEY,
  proposal_id        TEXT NOT NULL REFERENCES task_tool_proposals(proposal_id) ON DELETE CASCADE,
  decision           TEXT NOT NULL CHECK (decision IN ('ALLOWED','DENIED','APPROVAL_REQUIRED','INVALID','BLOCKED')),
  reason_code        TEXT,
  risk_class         TEXT,
  approval_required  INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_tool_decisions_proposal ON tool_decisions(proposal_id);
CREATE INDEX idx_tool_decisions_decision ON tool_decisions(decision, created_at);
`;

/**
 * v12（D4-03B）· Controlled Read-only Tool Execution。
 *
 * tool_executions 每 proposal 至多一条（§10 duplicate execute 幂等）。
 * 只存 status / timing / safe result ref+hash / verification / error_code；
 * **绝不存完整敏感输出 / raw credential / proxy token / absolute path**。
 */
const SCHEMA_V12_SQL = `
CREATE TABLE tool_executions (
  execution_id        TEXT PRIMARY KEY,
  proposal_id         TEXT NOT NULL REFERENCES task_tool_proposals(proposal_id) ON DELETE CASCADE,
  decision_id         TEXT,
  task_id             TEXT NOT NULL,
  step_id             TEXT,
  run_id              TEXT,
  tool_id             TEXT NOT NULL,
  tool_version        INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED','BLOCKED')),
  started_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  result_ref          TEXT,
  result_hash         TEXT,
  verification_status TEXT,
  error_code          TEXT
);
CREATE UNIQUE INDEX idx_tool_executions_proposal ON tool_executions(proposal_id);
CREATE INDEX idx_tool_executions_task ON tool_executions(task_id, started_at);
`;

/**
 * v13（D4-03C1）· Side-effect Authority / Approval / Lease Contract。
 *
 * side_effect_calls / tool_approvals / side_effect_leases。只存 safe refs + hash +
 * 状态机；**绝不存 credential / proxy capability / tool facade capability /
 * raw Authorization / full unsafe tool payload**。C1 只到 LEASED/ELIGIBLE，不真实写。
 */
const SCHEMA_V13_SQL = `
CREATE TABLE side_effect_calls (
  call_id                 TEXT PRIMARY KEY,
  proposal_id             TEXT,
  decision_id             TEXT,
  task_id                 TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  step_id                 TEXT,
  run_id                  TEXT,
  tool_id                 TEXT NOT NULL,
  tool_version            INTEGER NOT NULL,
  arguments_hash          TEXT,
  plan_hash               TEXT,
  idempotency_key         TEXT,
  effect_class            TEXT NOT NULL CHECK (effect_class IN ('REVERSIBLE_WRITE','IRREVERSIBLE_WRITE','EXTERNAL_SIDE_EFFECT','PRIVILEGED')),
  status                  TEXT NOT NULL CHECK (status IN ('PLANNED','AWAITING_APPROVAL','APPROVED','LEASED','RUNNING','SUCCEEDED','FAILED','CANCELLED','BLOCKED','UNKNOWN_EFFECT')),
  preconditions_safe      TEXT,
  expected_effects_safe   TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  authorized_at           INTEGER,
  approved_at             INTEGER,
  leased_at               INTEGER,
  started_at              INTEGER,
  completed_at            INTEGER,
  verification_status     TEXT,
  error_code              TEXT
);
CREATE UNIQUE INDEX idx_side_effect_calls_idempotency ON side_effect_calls(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_side_effect_calls_task ON side_effect_calls(task_id, created_at);
CREATE INDEX idx_side_effect_calls_status ON side_effect_calls(status, updated_at);

CREATE TABLE tool_approvals (
  approval_id               TEXT PRIMARY KEY,
  call_id                   TEXT NOT NULL REFERENCES side_effect_calls(call_id) ON DELETE CASCADE,
  actor_user_id             TEXT,
  session_ref               TEXT,
  decision                  TEXT NOT NULL CHECK (decision IN ('APPROVED','DENIED','REVOKED','EXPIRED')),
  plan_hash                 TEXT,
  approved_tool_id          TEXT,
  approved_tool_version     INTEGER,
  approved_arguments_hash   TEXT,
  approved_effect_class     TEXT,
  approved_expected_effects TEXT,
  created_at                INTEGER NOT NULL,
  expires_at                INTEGER,
  revoked_at                INTEGER
);
CREATE INDEX idx_tool_approvals_call ON tool_approvals(call_id, created_at);

CREATE TABLE side_effect_leases (
  lease_id            TEXT PRIMARY KEY,
  call_id             TEXT NOT NULL REFERENCES side_effect_calls(call_id) ON DELETE CASCADE,
  holder_id           TEXT NOT NULL,
  holder_instance_id  TEXT,
  status              TEXT NOT NULL CHECK (status IN ('ACTIVE','RELEASED','EXPIRED','REVOKED')),
  issued_at           INTEGER NOT NULL,
  expires_at          INTEGER,
  released_at         INTEGER,
  revoked_at          INTEGER
);
CREATE INDEX idx_side_effect_leases_call ON side_effect_leases(call_id, status);
CREATE INDEX idx_side_effect_leases_holder ON side_effect_leases(holder_id, status);
`;

/**
 * v14（D4-03C3）· UNKNOWN_EFFECT recovery / verification evidence。
 *
 * **non-authoritative**：只保存 safe 的 recovery/verification 证据投影；
 * 最终状态仍由 side_effect_calls.status 决定。绝不存 raw data / 绝对路径 / secret。
 */
const SCHEMA_V14_SQL = `
ALTER TABLE side_effect_calls ADD COLUMN recovery_safe TEXT;
`;

/**
 * v15（D4 收口）· 失败 Verification 持久化。
 *
 * 原表 artifact_id NOT NULL 只允许「Artifact 提交时」的 PASS 记录，验证失败（schema / adapter verify）
 * 没有任何可追溯证据。v15 重建为 artifact_id 可空，并新增 step_id/run_id/execution_id；
 * 原行原样复制（step/run/execution 置空），索引重建。绝不改 status 语义、绝不丢旧数据。
 */
const SCHEMA_V15_SQL = `
CREATE TABLE task_verifications_v15 (
  verification_id TEXT PRIMARY KEY,
  artifact_id     TEXT REFERENCES task_artifacts(artifact_id) ON DELETE CASCADE,
  task_id         TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  step_id         TEXT,
  run_id          TEXT,
  execution_id    TEXT,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('PASS','FAIL')),
  safe_details    TEXT,
  created_at      INTEGER NOT NULL
);
INSERT INTO task_verifications_v15 (verification_id, artifact_id, task_id, step_id, run_id, execution_id, type, status, safe_details, created_at)
  SELECT verification_id, artifact_id, task_id, NULL, NULL, NULL, type, status, safe_details, created_at FROM task_verifications;
DROP TABLE task_verifications;
ALTER TABLE task_verifications_v15 RENAME TO task_verifications;
CREATE INDEX idx_task_verifications_task ON task_verifications(task_id, created_at);
`;

/**
 * v16（D4-06 Closure）· 任务层跨 run 累计预算账本。
 *
 * task_budgets 以 (task_id, kind) 为唯一键保存**任务级**授权与已消耗；capability 仍按 run
 * 签发，但每 run 的额度不得超过任务剩余。行在任务首次触及时惰性建立；旧任务缺少可靠消耗
 * 证据时只写保守基线（不伪造历史精确余额），并落一条 task.budget_baseline_created safe event。
 * 只存整数额度，绝不存 capability / token / provider secret。
 */
const SCHEMA_V16_SQL = `
CREATE TABLE task_budgets (
  task_id    TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('MODEL_CALLS','TOOL_CALLS','TOOL_ROUNDS')),
  authorized INTEGER NOT NULL,
  consumed   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (task_id, kind)
);
CREATE INDEX idx_task_budgets_task ON task_budgets(task_id);
`;

/**
 * D5-02 v17：无限画布的**文档层**。
 *
 * 不建第二套画布：board 身份与资源引用沿用 D3-04D 的 canvas_boards / canvas_resource_nodes，
 * 这里只把"可编辑文档"（节点/连线/视口/日志）挂到同一个 board 上，再加共享角色与命令账本。
 *
 * 这一级必须能**重复执行**：合并前两条线各自用过 v17（集成线的 v17 是 users.avatar_ref），
 * 回滚式迁移夹具（把库倒回旧版本再重放）与"另一条线的老库"都会碰到已经存在的列/表。
 * SQLite 没有 ADD COLUMN IF NOT EXISTS，所以列先查 PRAGMA 再决定，表/索引一律 IF NOT EXISTS。
 */
const SCHEMA_V17_COLUMNS = [
  ["icon", "TEXT NOT NULL DEFAULT '🧩'"],
  ["kind", "TEXT NOT NULL DEFAULT 'classic'"],
  ["doc", "TEXT NOT NULL DEFAULT '{\"nodes\":[],\"connections\":[],\"viewport\":{\"x\":0,\"y\":0,\"scale\":1},\"logs\":[]}'"],
  ["revision", "INTEGER NOT NULL DEFAULT 1"],
  ["visibility", "TEXT NOT NULL DEFAULT 'PRIVATE'"],
  ["deleted_at", "INTEGER"],
  ["deleted_by", "TEXT"],
];
const SCHEMA_V17_SQL = `
CREATE INDEX IF NOT EXISTS idx_canvas_boards_owner ON canvas_boards(owner_user_id, deleted_at);
CREATE TABLE IF NOT EXISTS canvas_shares (
  canvas_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('VIEWER','CONTRIBUTOR','EDITOR')),
  granted_by TEXT,
  at         INTEGER NOT NULL,
  PRIMARY KEY (canvas_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_canvas_shares_user ON canvas_shares(user_id);
CREATE TABLE IF NOT EXISTS canvas_commands (
  id            TEXT PRIMARY KEY,
  canvas_id     TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('USER','AGENT')),
  command       TEXT NOT NULL,
  base_revision INTEGER,
  result_revision INTEGER,
  outcome       TEXT NOT NULL,
  before_doc    TEXT,
  at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canvas_commands ON canvas_commands(canvas_id, at DESC);
`;

/** v17 的列补齐 + 建表建索引；只在缺列时 ALTER，因此重放安全（见上）。*/
function applyCanvasDocumentLayer(db) {
  const existing = new Set(db.prepare("PRAGMA table_info(canvas_boards)").all().map((c) => c.name));
  for (const [name, decl] of SCHEMA_V17_COLUMNS) {
    if (!existing.has(name)) db.exec("ALTER TABLE canvas_boards ADD COLUMN " + name + " " + decl);
  }
  db.exec(SCHEMA_V17_SQL);
}

/** D5-02 Closure v18：一次画布生成 = 一个 Task（预算/停止/审计归属）。同样重放安全。*/
const SCHEMA_V18_SQL = `
CREATE TABLE IF NOT EXISTS canvas_runs (
  run_id        TEXT PRIMARY KEY,
  canvas_id     TEXT NOT NULL,
  node_id       TEXT,
  kind          TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  task_id       TEXT,
  base_revision INTEGER NOT NULL,
  status        TEXT NOT NULL,
  stop_reason   TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_canvas_runs ON canvas_runs(canvas_id, started_at DESC);
`;


/**
 * D5-03 第一批 v20：MCP 中心（连接管理 + 能力发现）。
 *
 * 三张表各管一件事：
 *   mcp_connections       —— 连接的**唯一权威记录**（含能力/工具快照与状态机字段）
 *   mcp_credentials       —— 凭据元数据，与 model_credentials 同形但**独立命名空间**
 *                            （MCP 的凭据不会出现在模型凭据查询里）；raw secret 只进 safeStorage
 *   mcp_connection_logs   —— 连接/测试日志（有界保留），支撑 UI 的"测试日志"面板
 *
 * 工具描述属于**能力数据**：tools_json 只在有 mcp.view 权限时被投影出去（无权时连 hash 都不给）。
 * status 的 CHECK 与 mcp-domain 的状态机一一对应，数据库层挡掉非法状态写入。
 *
 * DDL 全部 IF NOT EXISTS：与 v17/v18 同样**重放安全** —— 回归用例会"降级 user_version 再重放
 * 迁移链"（模拟旧库升级），非幂等的 CREATE TABLE 会让那类用例直接报 table already exists。
 */
const SCHEMA_V20_SQL = `
CREATE TABLE IF NOT EXISTS mcp_connections (
  connection_id     TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL,
  owner_user_id     TEXT,
  visibility        TEXT NOT NULL CHECK (visibility IN ('PERSONAL','ORGANIZATION')) DEFAULT 'PERSONAL',
  name              TEXT NOT NULL,
  transport         TEXT NOT NULL CHECK (transport IN ('stdio','http')),
  location          TEXT NOT NULL CHECK (location IN ('LOCAL_DEVICE','REMOTE_SERVICE')),
  endpoint_json     TEXT NOT NULL,
  auth_mode         TEXT NOT NULL CHECK (auth_mode IN ('NONE','BEARER')) DEFAULT 'NONE',
  credential_ref    TEXT,
  enabled           INTEGER NOT NULL CHECK (enabled IN (0,1)) DEFAULT 0,
  status            TEXT NOT NULL CHECK (status IN ('DISABLED','CONNECTING','READY','ERROR','AUTH_REQUIRED')) DEFAULT 'DISABLED',
  last_error_code   TEXT,
  protocol_version  TEXT,
  server_name       TEXT,
  server_version    TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  tools_json        TEXT NOT NULL DEFAULT '[]',
  tools_hash        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_connected_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_connections_org ON mcp_connections(organization_id, visibility);
CREATE INDEX IF NOT EXISTS idx_mcp_connections_owner ON mcp_connections(owner_user_id, visibility);

CREATE TABLE IF NOT EXISTS mcp_credentials (
  credential_ref     TEXT PRIMARY KEY,
  owner_user_id      TEXT NOT NULL,
  organization_id    TEXT NOT NULL,
  scope              TEXT NOT NULL CHECK (scope IN ('PERSONAL','ORGANIZATION')) DEFAULT 'PERSONAL',
  provider_origin    TEXT NOT NULL,
  provider_config_id TEXT,
  credential_version INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL CHECK (status IN ('CONFIGURED','MISSING','DELETED')) DEFAULT 'CONFIGURED',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_credentials_owner ON mcp_credentials(owner_user_id);

CREATE TABLE IF NOT EXISTS mcp_connection_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  at            INTEGER NOT NULL,
  level         TEXT NOT NULL,
  event         TEXT NOT NULL,
  error_code    TEXT,
  detail        TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_connection_logs ON mcp_connection_logs(connection_id, at DESC, id DESC);
`;

/**
 * D5-03 第二批 v21 · 内置策略提供记录 + app_resource_grants 跨组织唯一键。
 *
 * ## 为什么需要"提供记录"
 *
 * 内置 App baseline（resource / model / mcp）原本靠"会话事件里再 upsert 一次"保证按组织落位，
 * 但 upsert 是无条件的：治理侧 revokeAppGrant 是**删行**，于是"撤了 → 下次登录又种回来"。
 * 这里把"这个组织的这个 App 的这一族 baseline 是否已经给过"变成持久事实：
 *
 *   · 没有记录  ⇒ 首次使用：种 baseline + 记录 provisioned_at/provisioned_by
 *   · 有记录    ⇒ 无论是否撤销，**不再 upsert**（撤销后永不再给）
 *   · revoked   ⇒ 保持撤销；只有治理侧正式重授（写同一形状的 grant）才清掉撤销标记
 *
 * 键是 (organization_id, app_id, policy_key)：policy_key 是 baseline 家族名
 * （resource / model / mcp / tool），不是单条 grant —— 一族 baseline 可能写多行
 * （例如 resource-library 的全局行 + memory 行），它们同生同灭。
 *
 * provisioned_at 与 revoked_at 都可空，因为两者都可能"确实不知道"：迁移分不清
 * "从未播种"与"曾经撤销"，只能按可恢复的证据（现存 grant 行、authorization_audit
 * 里的治理撤销行）尽量补；只有撤销证据的行 provisioned_at 为 NULL。
 *
 * ## 为什么重建 app_resource_grants
 *
 * 旧唯一键 UNIQUE (app_id, resource_id, collection_id, resource_type, department_id, scope)
 * 不含 organization_id，而 upsert 的 ON CONFLICT 又固定写 organization_id = excluded.organization_id
 * —— 两个组织对同一 (app, type, scope) 的授权会互相覆盖，谁后写谁赢。SQLite 不能改约束，
 * 只能建新表 → 逐行搬运（id 与全部字段原样保留）→ 换名。与 v17/v18 同一条约定：全部幂等，
 * 重放（测试会把 user_version 降回去再重放迁移链）不会重复搬运或丢行。
 */
const APP_POLICY_KEYS = Object.freeze(["resource", "model", "mcp", "tool"]);

const SCHEMA_V21_POLICY_SQL = `
CREATE TABLE IF NOT EXISTS app_policy_provisions (
  organization_id TEXT    NOT NULL,
  app_id          TEXT    NOT NULL,
  policy_key      TEXT    NOT NULL CHECK (policy_key IN ('resource','model','mcp','tool')),
  provisioned_at  INTEGER,
  provisioned_by  TEXT,
  revoked_at      INTEGER,
  revoked_by      TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (organization_id, app_id, policy_key)
);
CREATE INDEX IF NOT EXISTS idx_app_policy_provisions_app ON app_policy_provisions(app_id);
`;

const SCHEMA_V21_APP_GRANTS_SQL = `
CREATE TABLE IF NOT EXISTS app_resource_grants_v21 (
  id              TEXT PRIMARY KEY,
  app_id          TEXT NOT NULL REFERENCES app_principals(app_id),
  resource_id     TEXT NOT NULL DEFAULT '',
  collection_id   TEXT NOT NULL DEFAULT '',
  resource_type   TEXT NOT NULL DEFAULT '',
  department_id   TEXT NOT NULL DEFAULT '',
  scope           TEXT NOT NULL DEFAULT '',
  actions         TEXT NOT NULL,
  granted_by      TEXT,
  organization_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER,
  UNIQUE (organization_id, app_id, resource_id, collection_id, resource_type, department_id, scope)
);
`;

/**
 * 授权行 → 策略家族（app 级授权）。针对具体 resource / collection / department 的授权
 * 返回 null —— 它们**不得**影响 baseline 提供记录。
 *
 * 只按动作命名空间认族：resource_type '' / 'model' / 'mcp' / 'tool' 分别对应四族；
 * 'image' / 'memory' 这类"某一种资源类型"的定向行不是 baseline。
 * 入参形状固定为数据库行的列名（snake_case）—— 调用方传 grant 行本身，或按列名转一次。
 */
function policyFamilyOfAppGrant(row) {
  if (!row) return null;
  if (String(row.resource_id || "") || String(row.collection_id || "") || String(row.department_id || "")) return null;
  const type = String(row.resource_type || "");
  if (type === "") return "resource";
  if (type === "model" || type === "mcp" || type === "tool") return type;
  return null;
}

/**
 * baseline 形状 → 策略家族；不是 baseline 形状返回 null。写墓碑与"已提供"事实只认这个形状。
 *
 * baseline = app 级（三个 id 全空）且 scope 是 baseline 字样：
 *   · scope = ''      → resource / model / mcp 族的全局基线；
 *   · scope = 'TOOL'  → tool 族（tool 授权只走 scope=TOOL 专用入口）。
 * scope = 'ORGANIZATION' 这类同族但非基线字样的正式授权**不算** baseline：
 * 它清墓碑（正式重授），但不冒充"系统播种过"。
 */
function baselinePolicyKeyOf(row) {
  const family = policyFamilyOfAppGrant(row);
  if (!family) return null;
  const scope = String((row && row.scope) || "");
  if (family === "tool") return scope === "TOOL" ? "tool" : null;
  return scope === "" ? family : null;
}

/** 审计行里的动作投影 → 策略家族（迁移补证据用；只认 namespace 前缀）。 */
function policyKeyOfAuditActions(oldPermissions) {
  let list = [];
  try {
    const parsed = JSON.parse(oldPermissions || "[]");
    if (Array.isArray(parsed)) list = parsed.map(String);
  } catch { list = []; }
  if (list.some((a) => a.startsWith("mcp."))) return "mcp";
  if (list.some((a) => a.startsWith("model."))) return "model";
  if (list.some((a) => a.startsWith("tool."))) return "tool";
  if (list.some((a) => a.startsWith("resource."))) return "resource";
  return null;
}

/**
 * 各 baseline 家族的**内置提供者**（谁会被播种这一族的 baseline）。必须与三处播种点对齐：
 *   · resource → resource-service.cjs BUILTIN_APP_BASELINE 的全部 App（memory 定向行不是 baseline）；
 *   · model    → model-bootstrap.cjs seedModelAppPolicy 的四个 App；
 *   · mcp      → mcp-bootstrap.cjs HOST_APP_ID；
 *   · tool     → 没有播种点（工具授权一律显式），因此是空表。
 *
 * 只被迁移补证据用来判断"历史审计行的 app_id 是否与该行动作命名空间自洽"。
 * 新增 baseline 提供者时要同步这里，否则新 App 的历史撤销会退回"只认审计行 app_id"的旧口径
 * （残余不确定性见 docs/decisions/D5-03B-app-policy-persistence.md §4）。
 */
const BASELINE_POLICY_PROVIDERS = Object.freeze({
  resource: Object.freeze(["resource-library", "canvas", "browser", "ai", "image-generator", "video-generator", "photoshop", "illustrator", "mcp-center", "skill-runtime"]),
  model: Object.freeze(["settings", "resource-library", "ai", "canvas"]),
  mcp: Object.freeze(["mcp-center"]),
  tool: Object.freeze([]),
});

/**
 * 历史撤销行的墓碑归属。审计行的 app_id 在 v21 之前记的是"发起治理的上下文 App"
 * （缺省 resource-library），不能直接当被撤 App 用；命名空间反推出的家族才是可信的那一半。
 *
 *   ① 记录自洽：app_id 是该族提供者，且该 App 当前没有该族 baseline 行 ⇒ 记的就是被撤的 App；
 *   ② 记录不自洽（或该 App 的 baseline 行还在，说明撤销不是针对它）：给该族**全部**现存提供者
 *      补墓碑。方向保守 —— 宁可把"从未提供"误判成"已撤销"（不复活），绝不把"已撤销"判成
 *      "未提供"。代价是同一族多提供者（model / resource）时可能连坐，需治理侧正式重授；
 *   ③ 该族没有登记提供者（tool 族）：退回审计行的 app_id，不额外扩面。
 */
function revokeTombstoneTargets({ appId, policyKey, organizationId, liveKeys, knownApps }) {
  const providers = BASELINE_POLICY_PROVIDERS[policyKey] || [];
  const recorded = String(appId || "");
  const live = (p) => liveKeys.has(organizationId + "|" + p + "|" + policyKey);
  if (recorded && providers.includes(recorded) && !live(recorded)) return [recorded];
  const candidates = providers.filter((p) => knownApps.has(p) && !live(p));
  if (candidates.length) return candidates;
  return recorded ? [recorded] : [];
}

/**
 * v21 的证据补写。两轮，都只补"能证明的"：
 *   ① 现存 baseline 形状的 grant 行 ⇒ provisioned_at = 最早一行 created_at（当前有效，未撤销）；
 *   ② authorization_audit 里的治理撤销行（action=governance.revokeAppPermission，
 *      resource_ref / department_id 为空）⇒ revoked_at = 撤销时刻。已有 ① 的记录时不覆盖
 *      （grant 行还在就说明撤销之后又正式授过）。
 *
 * 诚实边界（见交付说明）：审计表没有 organization_id，只能用 actor 所在 team 反推
 * （撤销本身被 before.organization_id === gate.user.team_id 约束，故该映射成立）；
 * 且 audit 只记 resource_ref / department_id，"collection 定向行"的撤销与 baseline 撤销
 * 同形，可能把"从未提供"误标成"已撤销"——保守方向（绝不复活已撤权限），
 * 代价是该 App 的 baseline 不再补种。
 *
 * 撤销行的 app_id 归属见 revokeTombstoneTargets：不自洽时给该族全部提供者补墓碑。
 */
function backfillPolicyProvisions(db) {
  const insert = db.prepare(
    "INSERT INTO app_policy_provisions (organization_id, app_id, policy_key, provisioned_at, provisioned_by, revoked_at, revoked_by, updated_at) " +
      "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(organization_id, app_id, policy_key) DO NOTHING",
  );
  // 逐行取回（不 GROUP BY）：provisioned_by 必须是**最早那条**的 granted_by，聚合函数给不出这个对应关系。
  const grantRows = db.prepare(
    "SELECT organization_id, app_id, resource_type, scope, created_at, granted_by FROM app_resource_grants " +
      "WHERE resource_id = '' AND collection_id = '' AND department_id = '' " +
      "  AND ((scope = '' AND resource_type IN ('', 'model', 'mcp')) OR (scope = 'TOOL' AND resource_type = 'tool')) " +
      "ORDER BY created_at, id",
  ).all();
  const firstEvidence = new Map();
  for (const row of grantRows) {
    const policyKey = baselinePolicyKeyOf(row);
    if (!policyKey) continue;
    const key = row.organization_id + "|" + row.app_id + "|" + policyKey;
    if (!firstEvidence.has(key)) firstEvidence.set(key, { row, policyKey });
  }
  for (const { row, policyKey } of firstEvidence.values()) {
    const at = Number(row.created_at == null ? 0 : row.created_at);
    insert.run(String(row.organization_id), String(row.app_id), policyKey, at, row.granted_by == null ? null : String(row.granted_by), null, null, at);
  }

  // "该族 baseline 行还在"的 App 不可能是被撤的那个：拿它当证据既排除了错误归属，
  // 也避免给已由 ① 记成"未撤销"的记录再写墓碑（ON CONFLICT DO NOTHING 本来就挡得住）。
  const liveKeys = new Set(
    db
      .prepare("SELECT organization_id, app_id, resource_type, scope FROM app_resource_grants WHERE resource_id = '' AND collection_id = '' AND department_id = ''")
      .all()
      .map((row) => ({ row, policyKey: baselinePolicyKeyOf(row) }))
      .filter((x) => x.policyKey)
      .map((x) => x.row.organization_id + "|" + x.row.app_id + "|" + x.policyKey),
  );
  const knownApps = new Set(db.prepare("SELECT app_id FROM app_principals").all().map((r) => String(r.app_id)));

  const revokes = db.prepare(
    "SELECT a.at AS at, a.app_id AS app_id, a.actor_user_id AS actor_user_id, a.old_permissions AS old_permissions, u.team_id AS team_id " +
      "FROM authorization_audit a JOIN users u ON u.id = a.actor_user_id " +
      "WHERE a.action = 'governance.revokeAppPermission' AND a.app_id IS NOT NULL " +
      "  AND a.resource_ref IS NULL AND a.department_id IS NULL ORDER BY a.at",
  ).all();
  for (const row of revokes) {
    const policyKey = policyKeyOfAuditActions(row.old_permissions);
    if (!policyKey || !row.team_id) continue;
    const at = Number(row.at == null ? 0 : row.at);
    const actor = row.actor_user_id == null ? null : String(row.actor_user_id);
    const organizationId = String(row.team_id);
    for (const appId of revokeTombstoneTargets({ appId: row.app_id, policyKey, organizationId, liveKeys, knownApps })) {
      insert.run(organizationId, appId, policyKey, null, null, at, actor, at);
    }
  }
}

/** v21 的唯一键重建：逐行搬运既有授权（id 与全部字段不变、一条不丢），再换名。可重放。 */
function rebuildAppGrantUniqueKey(db) {
  db.exec(SCHEMA_V21_APP_GRANTS_SQL);
  db.exec("DELETE FROM app_resource_grants_v21");
  db.exec(
    "INSERT INTO app_resource_grants_v21 (id, app_id, resource_id, collection_id, resource_type, department_id, scope, actions, granted_by, organization_id, created_at, expires_at) " +
      "SELECT id, app_id, resource_id, collection_id, resource_type, department_id, scope, actions, granted_by, organization_id, created_at, expires_at FROM app_resource_grants",
  );
  db.exec("DROP TABLE app_resource_grants");
  db.exec("ALTER TABLE app_resource_grants_v21 RENAME TO app_resource_grants");
  db.exec("CREATE INDEX IF NOT EXISTS idx_agrants_app ON app_resource_grants(app_id)");
}

function applyPolicyProvisionLayer(db) {
  db.exec(SCHEMA_V21_POLICY_SQL);
  backfillPolicyProvisions(db);
  rebuildAppGrantUniqueKey(db);
}

/**
 * v22 的实现：DX 表的 DDL 只有 dxos-foundation-schema.cjs 一份真值。
 * 全部语句是 IF NOT EXISTS（含索引），所以这一级可重放；失败时整级随外层事务回滚，
 * 不会留下"user_version 已升到 22、DX 表只建了一半"的半状态。
 */
function applyDxosFoundationLayer(db) {
  for (const statement of dxosFoundationSchema.dxosDdl()) db.exec(statement);
}

const MIGRATIONS = Object.freeze([
  { version: 1, sql: SCHEMA_SQL },
  { version: 2, sql: SCHEMA_V2_SQL },
  { version: 3, sql: SCHEMA_V3_SQL },
  { version: 4, sql: SCHEMA_V4_SQL },
  { version: 5, sql: SCHEMA_V5_SQL },
  { version: 6, sql: SCHEMA_V6_SQL },
  { version: 7, sql: SCHEMA_V7_SQL },
  { version: 8, sql: SCHEMA_V8_SQL },
  { version: 9, sql: SCHEMA_V9_SQL },
  { version: 10, sql: SCHEMA_V10_SQL },
  { version: 11, sql: SCHEMA_V11_SQL },
  { version: 12, sql: SCHEMA_V12_SQL },
  { version: 13, sql: SCHEMA_V13_SQL },
  { version: 14, sql: SCHEMA_V14_SQL },
  { version: 15, sql: SCHEMA_V15_SQL },
  { version: 16, sql: SCHEMA_V16_SQL },
  { version: 17, run: applyCanvasDocumentLayer },
  { version: 18, sql: SCHEMA_V18_SQL },
  {
    version: 19,
    // 合并后两条线共用一条迁移链（见文件顶部）：这一级把两条线各自在 v17 上做过的事都补齐，全部幂等。
    //   ① 集成线 D3-01b 的 users.avatar_ref —— 核心线的库从 v18 升上来时补列；
    //   ② 核心线 v17 的画布文档层 —— 集成线的库曾停在 v17（那一级是它自己的 avatar_ref），
    //      核心线编号的 v17 会被"版本已到 17"跳过，这里探一次、缺了就补，避免开画布时报未知列。
    run: (db) => {
      const userCols = db.prepare("PRAGMA table_info(users)").all();
      if (!userCols.some((c) => c.name === "avatar_ref")) db.exec("ALTER TABLE users ADD COLUMN avatar_ref TEXT");
      const boardCols = db.prepare("PRAGMA table_info(canvas_boards)").all();
      if (!boardCols.some((c) => c.name === "doc")) applyCanvasDocumentLayer(db);
      const hasRuns = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='canvas_runs'").get();
      if (!hasRuns) db.exec(SCHEMA_V18_SQL);
    },
  },
  { version: 20, sql: SCHEMA_V20_SQL },
  { version: 21, run: applyPolicyProvisionLayer },
  { version: 22, run: applyDxosFoundationLayer },
]);

/**
 * 安装重置（identity/reset-installation）要清的表 —— **授权事实四张 + 能恢复设备身份/权限的设备事实三张**。
 *
 * 判据（逐表可复核）：这张表里的行是不是"授权 / 权限事实"，**或者**它能不能在被重置后的安装里
 * 恢复设备身份或权限（旧密钥再登记设备、旧凭据再拿连接）。七张都满足；其余 20 张带
 * organization_id 的表是用户内容 / 配置 / 审计（判定与证据见
 * tests/d5-03-reset-authorization-consistency.test.mjs 与 tests/d5-03-reset-device-identity.test.mjs）。
 *
 *   · app_policy_provisions —— 策略提供记录 + 撤销墓碑。"首次使用才给、撤销后永不再给"
 *     的持久依据；组织 id 被复用时旧墓碑会**压住**新组织的首次播种（判定被误导）。
 *   · app_resource_grants  —— App 侧 ACL。第六批起取数与判定都按组织：取数
 *     appGrantsForApp(appId, organizationId) 只回本组织的行，拿不到组织直接返回空集；
 *     authorization-domain.evaluateAppAuthorization 再逐条只认 organization_id 等于
 *     当前组织的行 —— 异组织行与历史遗留的 organization_id = '' 无主行都不再放行
 *     （空组织不是通配）。
 *   · resource_grants      —— User / Department ACL（grant 事实本体）。
 *   · device_access        —— 设备 ACL（principal × actions）。同样按 device_id 取，
 *     ORGANIZATION 分支不比对行的 organization_id，孤儿行是悬空授权。
 *
 * 第七批补三张 —— 重置后**设备身份事实**仍在的三条路径，逐条可复核：
 *   · device_pairing_credentials —— 未消费的配对密钥就是一张"再登记一台设备"的门票。
 *     consumePairing 只按 secret_hash 反查（device-store.cjs:39/:43），判定里**不看组织是否仍存在**，
 *     因此重置前签发、尚未过期的密钥在重置后仍能把设备登记进那个**已删组织**（第五批 T7 实测）；
 *     组织 id 一旦被复用，它还会变成新安装里的"既有设备"。
 *   · device_credentials  —— 指纹是 TLS 握手后"这个连接是谁"的唯一查找键
 *     （device-store.cjs:51 credentialByFingerprint → device-service.cjs:514 authenticateConnection、:520 取数），
 *     而 heartbeat 的 Device Gate 用的是 role: "ADMIN" 的合成 actor（device-service.cjs:601），
 *     于是"旧凭据 + 旧 devices 行"在重置后**仍能拿到连接与心跳放行**，不需要任何 device_access 行。
 *   · devices             —— Registry 行既是上面两步的落点，又是 authorizeDevice 的组织来源。
 *     它与 device_credentials 互为父子（device_credentials.device_id REFERENCES devices(id)），
 *     所以删除顺序必须是先凭据、再 Registry —— PRAGMA foreign_keys = ON 下反了会直接抛错。
 *
 * 为什么整表删而不是按 organization_id 过滤：收紧放行口径只挡住"当下读到异组织/空组织行"，
 * 换不掉下面两个前提。其一，重置后 teams 为空，这些表里每一行的 organization_id 都指向
 * 已删组织（含历史遗留的 organization_id = '' 无主行），行本身**无所属**。其二，组织 id
 * 一旦被复用就会重新生效：按 organization_id 取的两张表（app_resource_grants /
 * resource_grants）会把旧行当成新组织的既有授权，app_policy_provisions 的旧墓碑会压制
 * 新组织的首次播种，device_access 干脆按 device_id 取、不比组织，孤儿行是悬空授权。
 * 设备三张同理 —— devices 行带着旧 organization_id 复活，凭据按 fingerprint 取数、配对密钥按
 * secret_hash 取数，**两条取数路径都不比对组织**，所以"行属于哪个组织"根本挡不住它们。
 * 审计三表（audit_log / authorization_audit / device_audit）一行都不删。
 *
 * 常量名保留 RESET_AUTHORIZATION_DELETE_SQL 不改：它是 docs / 守卫 fail-closed 定位串与既有引用
 * 的稳定锚点。它现在的语义是"重置要删的行删除集合"，含设备身份事实三张。
 *
 * 为什么必须是**字面量**：tests/app-policy-provisions-retention.test.mjs 的 R6 守卫按
 * 源码字符串字面量逐条核对组织删除路径；把表名拼进 SQL 会让守卫看不见这条删除（fail-open）。
 */
const RESET_AUTHORIZATION_DELETE_SQL = Object.freeze([
  "DELETE FROM app_policy_provisions",
  "DELETE FROM app_resource_grants",
  "DELETE FROM resource_grants",
  "DELETE FROM device_access",
  /** 设备身份/权限事实（第七批）：顺序 = 子表 → 父表，见上面 FK 那条。 */
  "DELETE FROM device_credentials",
  "DELETE FROM device_pairing_credentials",
  "DELETE FROM devices",
]);

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12h 绝对上限
const DEFAULT_IDLE_MS = 2 * 60 * 60 * 1000; //  2h 空闲上限
const BUSY_RETRY = { attempts: 5, baseDelayMs: 15 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isBusy(err) {
  const s = `${err?.errstr || ""} ${err?.message || ""}`;
  return s.includes("SQLITE_BUSY") || s.includes("database is locked");
}

/**
 * schema 高于本程序支持：**不迁移、不降级、不重置**，只把原因结构化地说清楚。
 * 主进程据此生成渲染层文案，不必去猜异常文本。
 */
class SchemaTooNewError extends Error {
  constructor(found, supported) {
    super(`身份库 schema_version=${found} 高于本程序支持的 ${supported}，拒绝打开。`);
    this.name = "SchemaTooNewError";
    this.code = "SCHEMA_TOO_NEW";
    this.found = found;
    this.supported = supported;
  }
}

/** 只包一层，把 node:sqlite 的缺失变成一句能行动的报错。 */
function openDatabase(path) {
  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    throw new Error("node:sqlite 不可用：需要 Node >= 22.5（Electron 主进程同版本）。");
  }
  if (!sqlite?.DatabaseSync) throw new Error("node:sqlite 缺少 DatabaseSync。");
  const db = new sqlite.DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  return db;
}

class IdentityStore {
  /**
   * @param opts.path       数据库文件路径
   * @param opts.clock      () => number，注入时钟（测试用可控时钟，§32）
   * @param opts.ttlMs      绝对有效期
   * @param opts.idleMs     空闲有效期
   * @param opts.busyTimeoutMs
   * @param opts.hooks      { beforeCommit?, afterInstallationInsert? } 仅测试注入用
   * @param opts.onAudit    (record) => void
   */
  constructor(opts = {}) {
    this.path = opts.path || ":memory:";
    this.clock = typeof opts.clock === "function" ? opts.clock : () => Date.now();
    this.ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
    this.idleMs = Number.isFinite(opts.idleMs) ? opts.idleMs : DEFAULT_IDLE_MS;
    this.hooks = opts.hooks || {};
    this.busyTimeoutMs = Number.isFinite(opts.busyTimeoutMs) ? opts.busyTimeoutMs : 5000;
    this.onAudit = typeof opts.onAudit === "function" ? opts.onAudit : () => {};
    this.db = null;
    this.#queue = Promise.resolve();
  }

  #queue;

  // -------------------------------------------------------------------------
  // 生命周期 / 迁移
  // -------------------------------------------------------------------------

  open() {
    if (this.db) return this;
    this.db = openDatabase(this.path);
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, this.busyTimeoutMs | 0)}`);
    this.#migrate();
    return this;
  }

  close() {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
    this.db = null;
  }

  get schemaVersion() {
    return Number(this.db.prepare("PRAGMA user_version").get().user_version ?? 0);
  }

  /**
   * 迁移。**每一步都真的执行**，不是"空库建表"冒充升级（§29）：
   * 每一级是一个独立的原子事务，失败只回滚该级，不会留下"user_version 升了、表没补"的半状态。
   * 迁移条目可以是 sql（整段 DDL）或 run(db)（需要条件判断时用，例如 v17 的 avatar_ref）。
   */
  #migrate() {
    const current = this.schemaVersion;
    if (current > SCHEMA_VERSION) throw new SchemaTooNewError(current, SCHEMA_VERSION);
    if (current === SCHEMA_VERSION) return;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.transactSync(() => {
        if (typeof migration.run === "function") migration.run(this.db);
        else this.db.exec(migration.sql);
        // 失败注入点：测试用它制造"DDL 已执行、版本尚未 bump"的崩溃，验证整级回滚。
        if (this.hooks.onMigration) this.hooks.onMigration(migration.version, this.db);
        // user_version 不能用占位符，只能整句拼；值是本文件常量，无注入面。
        this.db.exec("PRAGMA user_version = " + migration.version);
      });
    }
  }

  /**
   * 连接级同步事务：BEGIN IMMEDIATE 在 try 之外，且**没有连接内互斥** ——
   * 因此事务体内绝不能有 await（一旦让出事件循环，另一条写路径会插进同一连接）。
   * 全仓 electron/ 各 store 的主要写路径都走这里；迁移只是其中一个调用方。
   */
  transactSync(fn) {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 已回滚 */
      }
      throw e;
    }
  }

  /**
   * 异步事务。
   *
   * 连接内互斥 + BEGIN IMMEDIATE。事务体可以 await（KDF 是异步的），
   * 互斥队列保证**不会有第二个事务体插进来**——这是"事务体里有 await"时
   * 唯一能保住原子性的做法。
   */
  async transact(fn) {
    const run = async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // 关键：同步事务体绝不在 BEGIN 与 COMMIT 之间 yield。
        // 否则另一条连接执行 BEGIN IMMEDIATE 会同步阻塞在 busy_timeout 上，
        // 事件循环被占住，第一条连接永远无法 COMMIT —— 两连接互等 5s 后 SQLITE_BUSY。
        // 只有真正返回 Promise 的体（或 hook）才 await。
        let out = fn();
        if (out && typeof out.then === "function") out = await out;
        // 测试注入点：在 COMMIT 之前 yield，用来制造真实的交错窗口（§5）
        if (this.hooks.beforeCommit) {
          const gate = this.hooks.beforeCommit(this);
          if (gate && typeof gate.then === "function") await gate;
        }
        this.db.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* 已回滚 */
        }
        throw e;
      }
    };
    const prev = this.#queue;
    this.#queue = prev.then(run, run);
    return this.#queue;
  }

  /** SQLITE_BUSY 的有界重试。跨连接/跨进程竞争时败者走这里。 */
  async #withBusyRetry(fn) {
    let lastErr;
    for (let i = 0; i < BUSY_RETRY.attempts; i += 1) {
      try {
        return await fn();
      } catch (e) {
        if (!isBusy(e)) throw e;
        lastErr = e;
        await sleep(BUSY_RETRY.baseDelayMs * 2 ** i);
      }
    }
    throw lastErr;
  }

  // -------------------------------------------------------------------------
  // 审计（§34）
  // -------------------------------------------------------------------------

  /**
   * 审计落库。**字段白名单** —— 只写这七个字段，
   * 任何"顺手多记一点"都会把 secret 带进持久化。
   * session 只记 ref 的哈希（前 16 hex），不记 sessionId、更不记 token。
   */
  audit(event, { userId = null, sessionRef = null, result = "OK", errorCode = null, durationMs = null } = {}) {
    const record = {
      at: this.clock(),
      event: String(event),
      user_ref: userId,
      session_ref_hash: sessionRef ? domain.hashRef(sessionRef) : null,
      result: String(result),
      error_code: errorCode,
      duration_ms: durationMs == null ? null : Math.round(durationMs),
    };
    try {
      this.db
        .prepare(
          `INSERT INTO audit_log (at, event, user_ref, session_ref_hash, result, error_code, duration_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(record.at, record.event, record.user_ref, record.session_ref_hash, record.result, record.error_code, record.duration_ms);
    } catch {
      /* 审计失败不该让身份操作失败；但它本身要能被探针看见 */
    }
    this.onAudit(record);
    return record;
  }

  auditLog() {
    return this.db.prepare("SELECT * FROM audit_log ORDER BY id").all();
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  installation() {
    return this.db.prepare("SELECT * FROM installations WHERE singleton = 1").get() || null;
  }

  userCount() {
    return Number(this.db.prepare("SELECT COUNT(*) AS c FROM users").get().c ?? 0);
  }

  userById(id) {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
  }

  userByIdentifier(identifier) {
    return this.db.prepare("SELECT * FROM users WHERE identifier = ?").get(domain.normalizeIdentifier(identifier)) || null;
  }

  sessionByRef(ref) {
    return this.db.prepare("SELECT * FROM sessions WHERE ref = ?").get(String(ref ?? "")) || null;
  }

  sessionByTokenHash(tokenHash) {
    return this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(String(tokenHash ?? "")) || null;
  }

  sessionsOf(userId) {
    return this.db.prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at, id").all(userId);
  }

  allSessions() {
    return this.db.prepare("SELECT * FROM sessions ORDER BY created_at, id").all();
  }

  allUsers() {
    return this.db.prepare("SELECT * FROM users ORDER BY created_at, id").all();
  }

  allTeams() {
    return this.db.prepare("SELECT * FROM teams ORDER BY created_at, id").all();
  }

  /** 安装级状态。未初始化时也必须能安全调用（UI 首帧就问它）。 */
  status() {
    const inst = this.installation();
    return {
      initialized: inst?.status === INIT.READY,
      status: inst?.status || INIT.UNINITIALIZED,
      installationId: inst?.id ?? null,
      userCount: this.userCount(),
    };
  }

  // -------------------------------------------------------------------------
  // 初始化（§4 / §5 / §6）
  // -------------------------------------------------------------------------

  /**
   * 一次性原子初始化。
   *
   * **禁止 check-then-act**：不是"先问有没有用户，没有再建"，
   * 而是把"检查 + 建 installation + 建 root team + 建 admin"压进同一个
   * `BEGIN IMMEDIATE`。两个并发请求里必然有一个在事务内看到 status=READY，
   * 拿到 ALREADY_INITIALIZED。
   *
   * KDF 在事务**之前**算完：口令派生是纯函数、不依赖库状态，
   * 提前算掉能把事务体压到最短，也就把竞争窗口压到最小。
   *
   * `INITIALIZING` **永不落盘**：它只是事务内的一个瞬时值——
   * 事务一回滚，这个状态连同半个用户一起消失（§27）。
   */
  async initialize({ identifier, password, displayName, avatarRef = null, source = "local" } = {}) {
    const started = this.clock();
    const idCheck = domain.validateIdentifier(identifier);
    if (!idCheck.ok) {
      this.audit("initialize", { result: "DENY", errorCode: idCheck.error });
      return idCheck;
    }
    const nameCheck = domain.validateDisplayName(displayName);
    if (!nameCheck.ok) {
      this.audit("initialize", { result: "DENY", errorCode: nameCheck.error });
      return nameCheck;
    }
    const pwCheck = passwords.validatePassword(password);
    if (!pwCheck.ok) {
      this.audit("initialize", { result: "DENY", errorCode: pwCheck.error });
      return domain.fail(pwCheck.code, pwCheck.reason);
    }

    let verifier;
    try {
      verifier = await passwords.createVerifier(password);
    } catch (e) {
      this.audit("initialize", { result: "ERROR", errorCode: ERROR.INTERNAL_ERROR });
      return domain.fail(ERROR.INTERNAL_ERROR, "kdf-failed");
    }

    try {
      return await this.#withBusyRetry(() =>
        this.transact(() => {
          const existing = this.installation();
          if (existing && existing.status === INIT.READY) {
            this.audit("initialize", { result: "DENY", errorCode: ERROR.ALREADY_INITIALIZED, durationMs: this.clock() - started });
            return domain.fail(ERROR.ALREADY_INITIALIZED);
          }

          const now = this.clock();
          const installationId = domain.newId("INSTALLATION");
          if (!existing) {
            this.db
              .prepare(
                `INSERT INTO installations (singleton, id, status, created_at, initialized_at)
                 VALUES (1, ?, 'INITIALIZING', ?, NULL)`,
              )
              .run(installationId, now);
          } else {
            this.db.prepare("UPDATE installations SET status = 'INITIALIZING' WHERE singleton = 1").run();
          }

          // 失败注入点：模拟"installation 已写、admin 还没写"时崩溃（§27）
          if (this.hooks.afterInstallationInsert) this.hooks.afterInstallationInsert(this);

          const teamId = domain.newId("TEAM");
          this.db
            .prepare(`INSERT INTO teams (id, name, root, created_at) VALUES (?, 'Primary Workspace', 1, ?)`)
            .run(teamId, now);

          const userId = domain.newId("USER");
          this.db
            .prepare(
              `INSERT INTO users (id, installation_id, team_id, identifier, display_name, role, status, avatar_ref,
                                  auth_version, password_algo, password_params, password_salt, password_hash,
                                  password_version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'ADMIN', 'ACTIVE', ?, 1, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              userId,
              existing?.id || installationId,
              teamId,
              idCheck.identifier,
              nameCheck.displayName,
              avatarRef ?? null,
              verifier.algo,
              JSON.stringify(verifier.params),
              verifier.salt,
              passwords.encodeVerifier(verifier),
              now,
              now,
            );

          this.db
            .prepare(`UPDATE installations SET status = 'READY', initialized_at = ? WHERE singleton = 1`)
            .run(now);

          this.audit("initialize", {
            userId,
            result: "OK",
            durationMs: this.clock() - started,
          });
          return domain.ok({
            installationId: existing?.id || installationId,
            userId,
            teamId,
            identifier: idCheck.identifier,
          });
        }),
      );
    } catch (e) {
      // 事务已 ROLLBACK：没有半个用户、没有无 team 的 admin、没有 READY 的安装。
      if (isBusy(e)) {
        // 极端情况：重试次数用尽仍拿不到写锁。重新读一次状态给出诚实的答案。
        const st = this.status();
        if (st.initialized) {
          this.audit("initialize", { result: "DENY", errorCode: ERROR.ALREADY_INITIALIZED });
          return domain.fail(ERROR.ALREADY_INITIALIZED);
        }
      }
      this.audit("initialize", { result: "ERROR", errorCode: ERROR.INTERNAL_ERROR });
      return domain.fail(ERROR.INTERNAL_ERROR, isBusy(e) ? "busy" : "transaction-failed");
    }
  }

  /**
   * D3-02：由 Super Admin governance 层调用，创建子用户。
   *
   * 与 initialize 同一原则：KDF 在事务之前算完；identifier 唯一性由 DB 约束兜底，
   * 事务内再查一次只是为了给出可读错误码。disable / enable 复用 D3-01 的 setUserStatus。
   */
  async createUser({ identifier, password, displayName, role = "MEMBER", teamId = null } = {}) {
    const started = this.clock();
    const idCheck = domain.validateIdentifier(identifier);
    if (!idCheck.ok) {
      this.audit("create-user", { result: "DENY", errorCode: idCheck.error });
      return idCheck;
    }
    const nameCheck = domain.validateDisplayName(displayName);
    if (!nameCheck.ok) {
      this.audit("create-user", { result: "DENY", errorCode: nameCheck.error });
      return nameCheck;
    }
    const pwCheck = passwords.validatePassword(password);
    if (!pwCheck.ok) {
      this.audit("create-user", { result: "DENY", errorCode: pwCheck.error });
      return domain.fail(pwCheck.code, pwCheck.reason);
    }
    const inst = this.installation();
    if (!inst || inst.status !== INIT.READY) return domain.fail(ERROR.NOT_INITIALIZED);
    const userRole = role === "ADMIN" ? "ADMIN" : "MEMBER";
    let verifier;
    try {
      verifier = await passwords.createVerifier(password);
    } catch {
      this.audit("create-user", { result: "ERROR", errorCode: ERROR.INTERNAL_ERROR });
      return domain.fail(ERROR.INTERNAL_ERROR, "kdf-failed");
    }
    try {
      return await this.#withBusyRetry(() =>
        this.transact(() => {
          if (this.userByIdentifier(idCheck.identifier)) {
            this.audit("create-user", { result: "DENY", errorCode: ERROR.INVALID_INPUT });
            return domain.fail(ERROR.INVALID_INPUT, "identifier-taken");
          }
          const targetTeam = teamId || this.db.prepare("SELECT id FROM teams WHERE root = 1").get()?.id;
          if (!targetTeam) return domain.fail(ERROR.INTERNAL_ERROR, "no-team");
          const now = this.clock();
          const userId = domain.newId("USER");
          this.db
            .prepare(
              `INSERT INTO users (id, installation_id, team_id, identifier, display_name, role, status,
                                  auth_version, password_algo, password_params, password_salt, password_hash,
                                  password_version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              userId,
              inst.id,
              targetTeam,
              idCheck.identifier,
              nameCheck.displayName,
              userRole,
              verifier.algo,
              JSON.stringify(verifier.params),
              verifier.salt,
              passwords.encodeVerifier(verifier),
              now,
              now,
            );
          this.audit("create-user", { userId, result: "OK", durationMs: this.clock() - started });
          return domain.ok({ userId, identifier: idCheck.identifier, teamId: targetTeam, role: userRole });
        }),
      );
    } catch (e) {
      this.audit("create-user", { result: "ERROR", errorCode: ERROR.INTERNAL_ERROR });
      return domain.fail(ERROR.INTERNAL_ERROR, isBusy(e) ? "busy" : "transaction-failed");
    }
  }

  /** Super Admin 调整用户角色。角色变化下一请求即刻生效（authorize 每次重读 user 行）。 */
  setUserRole(userId, role) {
    const r = String(role || "").toUpperCase();
    if (r !== USER_ROLE.ADMIN && r !== USER_ROLE.MEMBER) return domain.fail(ERROR.INVALID_INPUT, "role-unknown");
    const user = this.userById(userId);
    if (!user) return domain.fail(ERROR.INVALID_INPUT, "user-not-found");
    if (user.role === r) return domain.ok({ user, changed: false });
    this.transactSync(() => {
      this.db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(r, this.clock(), userId);
    });
    return domain.ok({ user: this.userById(userId), changed: true });
  }

  /** 暴露底层连接：AuthorizationStore 与 IdentityStore 共享**同一个**数据库权威。 */
  get connection() {
    return this.db;
  }

  // -------------------------------------------------------------------------
  // 限流（§33）
  // -------------------------------------------------------------------------

  #attemptRow(key, identifierHash, source, now) {
    let row = this.db.prepare("SELECT * FROM login_attempts WHERE id = ?").get(key);
    if (!row) {
      this.db
        .prepare(
          `INSERT INTO login_attempts (id, identifier_hash, source, failures, first_failure_at, last_failure_at, cooldown_until)
           VALUES (?, ?, ?, 0, ?, ?, 0)`,
        )
        .run(key, identifierHash, String(source ?? "local"), now, now);
      row = this.db.prepare("SELECT * FROM login_attempts WHERE id = ?").get(key);
    }
    return row;
  }

  /** 冷却中返回剩余毫秒；否则 0。 */
  throttleRemaining(identifier, source = "local") {
    const now = this.clock();
    const row = this.db.prepare("SELECT * FROM login_attempts WHERE id = ?").get(domain.rateKey(identifier, source));
    if (!row || !row.failures) return 0;
    // 距上次失败太久 → 重新计数（手滑不该累积成封锁）
    if (now - row.last_failure_at > RATE_LIMIT.FAILURE_WINDOW_MS) return 0;
    return Math.max(0, row.cooldown_until - now);
  }

  #recordFailure(identifier, source) {
    const now = this.clock();
    const idHash = crypto.createHash("sha256").update(domain.normalizeIdentifier(identifier)).digest("hex").slice(0, 32);
    const key = domain.rateKey(identifier, source);
    let row = this.#attemptRow(key, idHash, source, now);
    if (now - row.last_failure_at > RATE_LIMIT.FAILURE_WINDOW_MS) {
      this.db.prepare("UPDATE login_attempts SET failures = 0, first_failure_at = ?, cooldown_until = 0 WHERE id = ?").run(now, key);
      row = this.#attemptRow(key, idHash, source, now);
    }
    const failures = row.failures + 1;
    const cooldown = domain.cooldownFor(failures);
    this.db
      .prepare("UPDATE login_attempts SET failures = ?, last_failure_at = ?, cooldown_until = ? WHERE id = ?")
      .run(failures, now, now + cooldown, key);
    return { failures, cooldownMs: cooldown };
  }

  #clearFailures(identifier, source) {
    const key = domain.rateKey(identifier, source);
    this.db.prepare("UPDATE login_attempts SET failures = 0, cooldown_until = 0 WHERE id = ?").run(key);
  }

  // -------------------------------------------------------------------------
  // 登录（§12）
  // -------------------------------------------------------------------------

  /**
   * 建 session 的内部实现。**唯一**的 session 诞生点。
   *
   * token 只在返回值里出现一次，调用方（service）负责写进 OS 受保护存储；
   * 数据库里永远只有它的 SHA-256。
   */
  #createSession(user, now) {
    const token = domain.newSessionToken();
    const session = {
      id: domain.newId("SESSION"),
      ref: domain.newId("SESSION_REF"),
      user_id: user.id,
      installation_id: user.installation_id,
      token_hash: domain.hashToken(token),
      created_at: now,
      last_seen_at: now,
      expires_at: now + this.ttlMs,
      idle_expires_at: now + this.idleMs,
      revoked_at: null,
      revoked_reason: null,
      locked_at: null,
      reauth_at: null,
      auth_version: user.auth_version,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, ref, user_id, installation_id, token_hash, created_at, last_seen_at,
                               expires_at, idle_expires_at, revoked_at, revoked_reason, locked_at, reauth_at, auth_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(
        session.id,
        session.ref,
        session.user_id,
        session.installation_id,
        session.token_hash,
        session.created_at,
        session.last_seen_at,
        session.expires_at,
        session.idle_expires_at,
        session.auth_version,
      );
    return { session, token };
  }

  async login({ identifier, password, source = "local" } = {}) {
    const started = this.clock();
    const idCheck = domain.validateIdentifier(identifier);
    if (!idCheck.ok) {
      this.audit("login", { result: "DENY", errorCode: idCheck.error });
      return idCheck;
    }

    // 冷却检查在读用户之前：被限流的标识符不该因为"存在性"消耗一次 KDF
    const remaining = this.throttleRemaining(idCheck.identifier, source);
    if (remaining > 0) {
      this.audit("login", { result: "DENY", errorCode: ERROR.RATE_LIMITED, durationMs: this.clock() - started });
      return domain.fail(ERROR.RATE_LIMITED, { retryAfterMs: remaining });
    }

    const user = this.userByIdentifier(idCheck.identifier);
    if (!user) {
      // **照样跑一次完整 KDF**，让"用户不存在"与"口令错误"耗时同量级（§12）
      await passwords.verifyPassword(String(password ?? ""), passwords.encodeVerifier(passwords.dummyVerifier()));
      this.#recordFailure(idCheck.identifier, source);
      this.audit("login", { result: "DENY", errorCode: ERROR.INVALID_CREDENTIALS, durationMs: this.clock() - started });
      return domain.fail(ERROR.INVALID_CREDENTIALS);
    }

    let verified = false;
    try {
      verified = await passwords.verifyPassword(String(password ?? ""), user.password_hash);
    } catch {
      this.audit("login", { result: "ERROR", errorCode: ERROR.INTERNAL_ERROR });
      return domain.fail(ERROR.INTERNAL_ERROR, "kdf-failed");
    }
    if (!verified) {
      this.#recordFailure(idCheck.identifier, source);
      this.audit("login", { userId: user.id, result: "DENY", errorCode: ERROR.INVALID_CREDENTIALS, durationMs: this.clock() - started });
      return domain.fail(ERROR.INVALID_CREDENTIALS);
    }

    // 口令正确但账号被禁用：这时才报 USER_DISABLED。
    // 顺序不能反——先报禁用等于免费提供"这个账号存在"的枚举接口。
    if (user.status === USER_STATUS.DISABLED) {
      this.audit("login", { userId: user.id, result: "DENY", errorCode: ERROR.USER_DISABLED, durationMs: this.clock() - started });
      return domain.fail(ERROR.USER_DISABLED);
    }

    const notReady = this.status();
    if (!notReady.initialized) {
      this.audit("login", { userId: user.id, result: "DENY", errorCode: ERROR.NOT_INITIALIZED });
      return domain.fail(ERROR.NOT_INITIALIZED);
    }

    this.#clearFailures(idCheck.identifier, source);

    // 参数升级：登录成功后用当前默认参数透明重哈希（ADR §6）
    if (passwords.needsUpgrade(user.password_hash)) {
      try {
        const v = await passwords.createVerifier(String(password));
        this.db
          .prepare(
            `UPDATE users SET password_params = ?, password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?`,
          )
          .run(JSON.stringify(v.params), v.salt, passwords.encodeVerifier(v), this.clock(), user.id);
      } catch {
        /* 重哈希失败不影响本次登录 */
      }
    }

    const { session, token } = await this.#withBusyRetry(() => this.transact(() => this.#createSession(user, this.clock())));
    const fresh = this.userById(user.id);
    this.audit("login", {
      userId: fresh.id,
      sessionRef: session.ref,
      result: "OK",
      durationMs: this.clock() - started,
    });
    return domain.ok({
      user: fresh,
      session,
      token,
      installationId: fresh.installation_id,
    });
  }

  /**
   * 重启后恢复：用 OS 受保护存储里的 token 反查 session。
   *
   * 这是"刷新/重启恢复身份"（§39）的唯一路径，
   * 也是渲染进程**不需要**在 localStorage 里存任何身份凭据的原因。
   */
  restoreByToken(token) {
    const started = this.clock();
    if (!token) {
      this.audit("restore", { result: "DENY", errorCode: ERROR.INVALID_CREDENTIALS });
      return domain.fail(ERROR.INVALID_CREDENTIALS);
    }
    const session = this.sessionByTokenHash(domain.hashToken(token));
    if (!session) {
      this.audit("restore", { result: "DENY", errorCode: ERROR.SESSION_REVOKED });
      return domain.fail(ERROR.SESSION_REVOKED);
    }
    const user = this.userById(session.user_id);
    const verdict = domain.evaluateSession(session, user, this.clock());
    if (!verdict.ok) {
      this.audit("restore", { userId: session.user_id, sessionRef: session.ref, result: "DENY", errorCode: verdict.error });
      return verdict;
    }
    this.#touch(session, this.clock());
    this.audit("restore", {
      userId: user.id,
      sessionRef: session.ref,
      result: "OK",
      durationMs: this.clock() - started,
    });
    return domain.ok({ user, session: this.sessionByRef(session.ref), installationId: user.installation_id });
  }

  // -------------------------------------------------------------------------
  // Session（§9 / §32）
  // -------------------------------------------------------------------------

  /** 滑动续期。锁定的 session **不续期**——锁屏不是"保持活跃"的理由。 */
  #touch(session, now) {
    if (session.locked_at != null) return session;
    const idleExpiresAt = now + this.idleMs;
    this.db.prepare("UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?").run(now, idleExpiresAt, session.id);
    return { ...session, last_seen_at: now, idle_expires_at: idleExpiresAt };
  }

  /**
   * 校验 session。
   *
   * `sensitive: true`（默认）时锁定态返回 LOCKED（§47）；
   * `sensitive: false` 时锁定态仍算有效（身份可识别，只是不能做受保护的事）。
   */
  validateSession(ref, { sensitive = true } = {}) {
    const session = this.sessionByRef(ref);
    if (!session) {
      this.audit("validate", { result: "DENY", errorCode: ERROR.SESSION_REVOKED });
      return domain.fail(ERROR.SESSION_REVOKED);
    }
    const user = this.userById(session.user_id);
    const verdict = domain.guardProtected(session, user, this.clock(), { sensitive });
    if (!verdict.ok) {
      this.audit("validate", {
        userId: session.user_id,
        sessionRef: session.ref,
        result: "DENY",
        errorCode: verdict.error,
      });
      return verdict;
    }
    const touched = this.#touch(session, this.clock());
    return domain.ok({ user, session: touched, locked: touched.locked_at != null });
  }

  /** 撤销单条 session。 */
  #revokeSession(session, reason, now) {
    if (session.revoked_at != null) return;
    this.db
      .prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?")
      .run(now, reason || REVOKE_REASON.ADMIN, session.id);
  }

  #revokeAllForUser(userId, reason, now) {
    this.db
      .prepare("UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL")
      .run(now, reason, userId);
  }

  /**
   * 登出（§13）。真正撤销当前 session —— 不是"跳回登录页"就算完成。
   * 返回被撤销 session 的 token_hash 供 service 清理 OS 受保护存储。
   */
  logout(ref) {
    const started = this.clock();
    const session = this.sessionByRef(ref);
    if (!session) {
      this.audit("logout", { result: "DENY", errorCode: ERROR.SESSION_REVOKED });
      return domain.fail(ERROR.SESSION_REVOKED);
    }
    if (session.revoked_at != null) {
      this.audit("logout", { userId: session.user_id, sessionRef: session.ref, result: "DENY", errorCode: ERROR.SESSION_REVOKED });
      return domain.fail(ERROR.SESSION_REVOKED);
    }
    this.#revokeSession(session, REVOKE_REASON.LOGOUT, this.clock());
    this.audit("logout", {
      userId: session.user_id,
      sessionRef: session.ref,
      result: "OK",
      durationMs: this.clock() - started,
    });
    return domain.ok({ sessionId: session.id, tokenHash: session.token_hash, userId: session.user_id });
  }

  // -------------------------------------------------------------------------
  // 自然到期（§9 / §32）
  // -------------------------------------------------------------------------

  /**
   * 把"已到期"落成权威事实。**幂等，且只认权威行**。
   *
   * 判据来自 domain.sessionExpiry / evaluateSession —— 与懒判定同一份；
   * 写入走 transact 队列（连接内互斥），与其它事务体不会交错。
   * 只写"它是被到期收掉的"（REVOKE_REASON.EXPIRED），对外错误码仍是 SESSION_EXPIRED。
   *
   * 返回 { changed, reason }：
   *   changed=false, reason="not-expired"     → 合法活动已经续期：什么都不做（调用方按权威行重排）
   *   changed=false, reason="ended"           → 已被其它路径终结（登出/改密/撤权/已收过），各路径自有归属
   *   changed=false, reason="ended-elsewhere" → 会话还在，但判据给的是别的终止原因（用户禁用 / authVersion）
   *   changed=false, reason="missing"         → 行不存在
   *   changed=true,  reason="idle"|"absolute" → 本次真的终结了它，原因 = 当前起约束作用的那条上限
   */
  async expireSession(ref, now = this.clock()) {
    if (!this.db) return { changed: false, reason: "store-closed" };
    const outcome = await this.#withBusyRetry(() =>
      this.transact(() => {
        const session = this.sessionByRef(ref);
        if (!session) return { changed: false, reason: "missing" };
        if (session.revoked_at != null) return { changed: false, reason: "ended" };
        const verdict = domain.evaluateSession(session, this.userById(session.user_id), now);
        if (verdict.ok) return { changed: false, reason: "not-expired" };
        if (verdict.error !== ERROR.SESSION_EXPIRED) return { changed: false, reason: "ended-elsewhere", error: verdict.error };
        const expiry = domain.sessionExpiry(session, now) || { reason: domain.EXPIRY_REASON.ABSOLUTE };
        this.#revokeSession(session, REVOKE_REASON.EXPIRED, now);
        return { changed: true, reason: expiry.reason, sessionId: session.id, userId: session.user_id, sessionRef: session.ref };
      }),
    );
    if (outcome.changed) this.audit("expire", { userId: outcome.userId, sessionRef: outcome.sessionRef, result: "OK", errorCode: ERROR.SESSION_EXPIRED });
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Lock / Unlock（§14 / §15 / §16 / §47）
  // -------------------------------------------------------------------------

  /**
   * 锁定。LOCK ≠ LOGOUT（§14）：session 仍然有效、身份仍然可识别，
   * 只是受保护命令被挡住。落库是为了"锁定期间重启"仍保持锁定。
   */
  lock(ref) {
    const started = this.clock();
    const session = this.sessionByRef(ref);
    if (!session) {
      this.audit("lock", { result: "DENY", errorCode: ERROR.SESSION_REVOKED });
      return domain.fail(ERROR.SESSION_REVOKED);
    }
    const user = this.userById(session.user_id);
    const verdict = domain.evaluateSession(session, user, this.clock());
    if (!verdict.ok) {
      this.audit("lock", { userId: session.user_id, sessionRef: session.ref, result: "DENY", errorCode: verdict.error });
      return verdict;
    }
    if (session.locked_at == null) {
      this.db.prepare("UPDATE sessions SET locked_at = ? WHERE id = ?").run(this.clock(), session.id);
    }
    this.audit("lock", { userId: session.user_id, sessionRef: session.ref, result: "OK", durationMs: this.clock() - started });
    return domain.ok({ locked: true, session: this.sessionByRef(session.ref) });
  }

  /**
   * 解锁（§16）。**必须重新验证凭据** —— 不是"点一下按钮把 locked 置 false"。
   *
   * 成功后**轮换 ref 与 token**：
   *   · 换 ref  → 旧 ref 立刻失效，"解锁前偷到的 ref"不能再用
   *   · 换 token → OS 受保护存储里的旧 token 作废
   * 已经 revoked 的 session **不会被偷偷恢复**：
   * evaluateSession 在解锁路径里同样生效，revoked 一律 DENY。
   */
  async unlock(ref, password) {
    const started = this.clock();
    const session = this.sessionByRef(ref);
    if (!session) {
      this.audit("unlock", { result: "DENY", errorCode: ERROR.SESSION_REVOKED });
      return domain.fail(ERROR.SESSION_REVOKED);
    }
    const user = this.userById(session.user_id);
    // 注意：这里用 evaluateSession（不带敏感守卫）—— 锁定的 session 本身是有效的
    const verdict = domain.evaluateSession(session, user, this.clock());
    if (!verdict.ok) {
      this.audit("unlock", { userId: session.user_id, sessionRef: session.ref, result: "DENY", errorCode: verdict.error });
      return verdict;
    }
    if (session.locked_at == null) {
      // 没锁却来解锁：不是错误，但也不该白送一次凭据校验成功
      this.audit("unlock", { userId: session.user_id, sessionRef: session.ref, result: "DENY", errorCode: ERROR.INVALID_INPUT });
      return domain.fail(ERROR.INVALID_INPUT, "not-locked");
    }

    // 解锁失败也走限流：锁屏不是无限次试密码的地方
    const remaining = this.throttleRemaining(user.identifier, "lock");
    if (remaining > 0) {
      this.audit("unlock", { userId: user.id, sessionRef: session.ref, result: "DENY", errorCode: ERROR.RATE_LIMITED });
      return domain.fail(ERROR.RATE_LIMITED, { retryAfterMs: remaining });
    }

    let verified = false;
    try {
      verified = await passwords.verifyPassword(String(password ?? ""), user.password_hash);
    } catch {
      this.audit("unlock", { userId: user.id, sessionRef: session.ref, result: "ERROR", errorCode: ERROR.INTERNAL_ERROR });
      return domain.fail(ERROR.INTERNAL_ERROR, "kdf-failed");
    }
    if (!verified) {
      this.#recordFailure(user.identifier, "lock");
      this.audit("unlock", {
        userId: user.id,
        sessionRef: session.ref,
        result: "DENY",
        errorCode: ERROR.INVALID_CREDENTIALS,
        durationMs: this.clock() - started,
      });
      return domain.fail(ERROR.INVALID_CREDENTIALS);
    }
    if (user.status === USER_STATUS.DISABLED) {
      this.audit("unlock", { userId: user.id, sessionRef: session.ref, result: "DENY", errorCode: ERROR.USER_DISABLED });
      return domain.fail(ERROR.USER_DISABLED);
    }

    this.#clearFailures(user.identifier, "lock");
    const now = this.clock();
    const newToken = domain.newSessionToken();
    const newRef = domain.newId("SESSION_REF");
    await this.#withBusyRetry(() =>
      this.transact(() => {
        this.db
          .prepare(
            `UPDATE sessions SET locked_at = NULL, reauth_at = ?, ref = ?, token_hash = ?, last_seen_at = ?,
                                 idle_expires_at = ?, auth_version = ? WHERE id = ?`,
          )
          .run(now, newRef, domain.hashToken(newToken), now, now + this.idleMs, user.auth_version, session.id);
        return true;
      }),
    );
    this.audit("unlock", {
      userId: user.id,
      sessionRef: newRef,
      result: "OK",
      durationMs: this.clock() - started,
    });
    return domain.ok({ user, session: this.sessionByRef(newRef), token: newToken, previousRef: session.ref });
  }

  // -------------------------------------------------------------------------
  // 改密（§21 / §46）
  // -------------------------------------------------------------------------

  /**
   * 修改口令。
   *
   * **冻结策略：authVersion++ 且撤销该用户的全部 session（含当前这条）。**
   *
   * 为什么连当前 session 一起撤：
   *   · 语义最干净——"改密之后，除了你刚刚用新密码建立的会话之外，没有任何旧凭据还活着"
   *   · 可测：§46 的"旧 session 行为"只有一个答案，不存在"这条留着那条不留"的特例
   *   · 代价只是"改完要重新登录一次"，而这恰恰是安全上正确的行为
   * 备选方案（保留当前 session、只撤其它）被否决：它会让 §46 出现两种合法期望，
   * 并且让"改密后当前会话仍持有旧 auth proof"成为一个需要额外解释的状态。
   */
  async changePassword(ref, currentPassword, newPassword) {
    const started = this.clock();
    const session = this.sessionByRef(ref);
    if (!session) {
      this.audit("change-password", { result: "DENY", errorCode: ERROR.SESSION_REVOKED });
      return domain.fail(ERROR.SESSION_REVOKED);
    }
    const user = this.userById(session.user_id);
    const verdict = domain.guardProtected(session, user, this.clock(), { sensitive: true });
    if (!verdict.ok) {
      this.audit("change-password", {
        userId: session.user_id,
        sessionRef: session.ref,
        result: "DENY",
        errorCode: verdict.error,
      });
      return verdict;
    }

    const pwCheck = passwords.validatePassword(newPassword);
    if (!pwCheck.ok) {
      this.audit("change-password", { userId: user.id, sessionRef: session.ref, result: "DENY", errorCode: pwCheck.error });
      return domain.fail(pwCheck.code, pwCheck.reason);
    }

    let verified = false;
    try {
      verified = await passwords.verifyPassword(String(currentPassword ?? ""), user.password_hash);
    } catch {
      this.audit("change-password", { userId: user.id, sessionRef: session.ref, result: "ERROR", errorCode: ERROR.INTERNAL_ERROR });
      return domain.fail(ERROR.INTERNAL_ERROR, "kdf-failed");
    }
    if (!verified) {
      this.audit("change-password", {
        userId: user.id,
        sessionRef: session.ref,
        result: "DENY",
        errorCode: ERROR.INVALID_CREDENTIALS,
        durationMs: this.clock() - started,
      });
      return domain.fail(ERROR.INVALID_CREDENTIALS);
    }

    let verifier;
    try {
      verifier = await passwords.createVerifier(newPassword);
    } catch {
      this.audit("change-password", { userId: user.id, sessionRef: session.ref, result: "ERROR", errorCode: ERROR.INTERNAL_ERROR });
      return domain.fail(ERROR.INTERNAL_ERROR, "kdf-failed");
    }

    const now = this.clock();
    const nextVersion = user.auth_version + 1;
    await this.#withBusyRetry(() =>
      this.transact(() => {
        this.db
          .prepare(
            `UPDATE users SET password_algo = ?, password_params = ?, password_salt = ?, password_hash = ?,
                              password_version = ?, auth_version = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            verifier.algo,
            JSON.stringify(verifier.params),
            verifier.salt,
            passwords.encodeVerifier(verifier),
            verifier.version,
            nextVersion,
            now,
            user.id,
          );
        // authVersion 抬高了，所有旧 session 立刻不匹配 —— 这里只是把原因写清楚
        this.#revokeAllForUser(user.id, REVOKE_REASON.PASSWORD_CHANGED, now);
        return true;
      }),
    );

    this.audit("change-password", {
      userId: user.id,
      sessionRef: session.ref,
      result: "OK",
      durationMs: this.clock() - started,
    });
    return domain.ok({ userId: user.id, authVersion: nextVersion, revokedSessions: this.sessionsOf(user.id).length });
  }

  // -------------------------------------------------------------------------
  // 资料（displayName / avatarRef）
  // -------------------------------------------------------------------------

  /**
   * 更新资料。
   *
   * 只在字段真的提供时才更新：`undefined` 表示"这次不改这一项"，
   * `avatarRef: null` 表示"清除头像"——两者语义不同，不能混。
   * 一项都没有 → INVALID_INPUT，避免空更新把 updated_at 白推一格。
   *
   * 鉴权不在这里：service 层已确认调用方持有活跃 session，
   * store 只负责落库与审计，避免把"认证"和"存储"搅成一件事。
   */
  updateProfile({ userId, displayName, avatarRef } = {}) {
    const started = this.clock();
    const user = this.userById(userId);
    if (!user) {
      this.audit("update-profile", { result: "DENY", errorCode: ERROR.INVALID_INPUT });
      return domain.fail(ERROR.INVALID_INPUT, "user-missing");
    }
    const sets = [];
    const args = [];
    if (displayName !== undefined) {
      sets.push("display_name = ?");
      args.push(displayName);
    }
    if (avatarRef !== undefined) {
      sets.push("avatar_ref = ?");
      args.push(avatarRef);
    }
    if (sets.length === 0) {
      this.audit("update-profile", { userId: user.id, result: "DENY", errorCode: ERROR.INVALID_INPUT });
      return domain.fail(ERROR.INVALID_INPUT, "nothing-to-update");
    }
    sets.push("updated_at = ?");
    args.push(this.clock());
    args.push(user.id);
    this.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    this.audit("update-profile", { userId: user.id, result: "OK", durationMs: this.clock() - started });
    return domain.ok({ user: this.userById(user.id) });
  }

  // -------------------------------------------------------------------------
  // 用户状态（§17 / §18 / §19 / §45）
  // -------------------------------------------------------------------------

  /**
   * 设置用户状态。管理员 / 测试夹具命令（§18：本轮不建 admin UI）。
   *
   * **禁用不删 session 行**：这样校验时能返回 USER_DISABLED 而不是
   * SESSION_REVOKED —— 后者会被 UI 当成"请重新登录"，而真实含义是
   * "你的账号被停用了，重新登录也没用"。D4 需要这个区分（§19）。
   * service 层负责把 OS 受保护存储里的 token 清掉，使重启无法恢复。
   */
  setUserStatus(userId, status) {
    const started = this.clock();
    if (status !== USER_STATUS.ACTIVE && status !== USER_STATUS.DISABLED)
      return domain.fail(ERROR.INVALID_INPUT, "bad-status");
    const user = this.userById(userId);
    if (!user) {
      this.audit("set-user-status", { result: "DENY", errorCode: ERROR.INVALID_INPUT });
      return domain.fail(ERROR.INVALID_INPUT, "user-missing");
    }
    const now = this.clock();
    const reEnabling = user.status === USER_STATUS.DISABLED && status === USER_STATUS.ACTIVE;
    this.transactSync(() => {
      this.db.prepare("UPDATE users SET status = ?, updated_at = ? WHERE id = ?").run(status, now, user.id);
      if (reEnabling) {
        // D3-05 §9：Re-enable **不得静默恢复旧 session**。
        // 停用期间保留 session 行（这样错误码是 USER_DISABLED 而不是 SESSION_REVOKED）；
        // 但重新启用时抬高 authVersion 并撤销全部旧 session，用户必须重新认证。
        this.db.prepare("UPDATE users SET auth_version = auth_version + 1, updated_at = ? WHERE id = ?").run(now, user.id);
        this.#revokeAllForUser(user.id, REVOKE_REASON.ADMIN, now);
      }
    });
    this.audit("set-user-status", {
      userId: user.id,
      result: "OK",
      durationMs: this.clock() - started,
    });
    return domain.ok({ user: this.userById(user.id) });
  }

  /**
   * D3-04D：Super Admin 发起的口令重置（设置一次性临时口令）。
   *
   * 只允许**写入**新 verifier：绝不读取/返回旧口令或 verifier。
   * 与 changePassword 同一冻结语义：auth_version++ 且撤销该用户全部 session。
   */
  async adminSetPassword({ userId, newPassword } = {}) {
    const started = this.clock();
    const user = this.userById(userId);
    if (!user) {
      this.audit("admin-set-password", { result: "DENY", errorCode: ERROR.INVALID_INPUT });
      return domain.fail(ERROR.INVALID_INPUT, "user-missing");
    }
    const pwCheck = passwords.validatePassword(newPassword);
    if (!pwCheck.ok) {
      this.audit("admin-set-password", { userId: user.id, result: "DENY", errorCode: pwCheck.error });
      return domain.fail(pwCheck.code, pwCheck.reason);
    }
    let verifier;
    try {
      verifier = await passwords.createVerifier(newPassword);
    } catch {
      this.audit("admin-set-password", { userId: user.id, result: "ERROR", errorCode: ERROR.INTERNAL_ERROR });
      return domain.fail(ERROR.INTERNAL_ERROR, "kdf-failed");
    }
    const now = this.clock();
    const nextVersion = user.auth_version + 1;
    await this.#withBusyRetry(() =>
      this.transact(() => {
        this.db
          .prepare(
            `UPDATE users SET password_algo = ?, password_params = ?, password_salt = ?, password_hash = ?,
                              password_version = ?, auth_version = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(verifier.algo, JSON.stringify(verifier.params), verifier.salt, passwords.encodeVerifier(verifier), verifier.version, nextVersion, now, user.id);
        this.#revokeAllForUser(user.id, REVOKE_REASON.ADMIN, now);
        return true;
      }),
    );
    this.audit("admin-set-password", { userId: user.id, result: "OK", durationMs: this.clock() - started });
    return domain.ok({ userId: user.id, authVersion: nextVersion, revokedSessions: this.sessionsOf(user.id).length });
  }

  // -------------------------------------------------------------------------
  // Installation Reset（§20 / §22）
  // -------------------------------------------------------------------------

  /**
   * 安装重置。**高风险操作**：
   *   · 必须显式传 `confirm: "DELETE-ALL-IDENTITY-DATA"`，输错一字即拒
   *   · 不在任何产品 UI 里暴露入口（本轮只有探针与未来的恢复流程会调）
   *   · 审计留痕：audit_log **不删**，否则"谁重置了"将无据可查
   *   · 授权状态与**能恢复设备身份/权限的设备事实**同事务清干净：重置后 teams 为空，
   *     任何仍留在授权表里的行都属于"指向已删组织的授权状态"；未消费的配对密钥、devices 行、
   *     device_credentials 行则会绕过授权表直接恢复设备身份（详见 RESET_AUTHORIZATION_DELETE_SQL）
   */
  resetInstallation({ confirm } = {}) {
    if (confirm !== "DELETE-ALL-IDENTITY-DATA") {
      this.audit("reset-installation", { result: "DENY", errorCode: ERROR.INVALID_INPUT });
      return domain.fail(ERROR.INVALID_INPUT, "confirm-required");
    }
    const started = this.clock();
    this.audit("reset-installation", { result: "OK_REQUESTED" });
    this.transactSync(() => {
      // 先清授权事实与设备身份事实，再删身份：必须在**同一个事务**里，任一语句失败都整体回滚，
      // 不允许出现"身份没了、授权还在"（或旧的设备身份还能用）这类半状态。
      for (const sql of RESET_AUTHORIZATION_DELETE_SQL) this.db.exec(sql);
      this.db.exec("DELETE FROM sessions");
      this.db.exec("DELETE FROM login_attempts");
      this.db.exec("DELETE FROM users");
      this.db.exec("DELETE FROM teams");
      this.db.exec("DELETE FROM installations");
    });
    this.audit("reset-installation", { result: "OK", durationMs: this.clock() - started });
    return domain.ok({ status: this.status() });
  }

  // -------------------------------------------------------------------------
  // 数据完整性（§30）—— 依赖数据库约束，这里是**可断言的复查**
  // -------------------------------------------------------------------------

  /** 返回违规描述数组，空数组 = 健康。 */
  invariants() {
    const bad = [];
    const insts = this.db.prepare("SELECT * FROM installations").all();
    if (insts.length > 1) bad.push(`installations 有 ${insts.length} 行（必须 <= 1）`);
    const rootTeams = this.db.prepare("SELECT * FROM teams WHERE root = 1").all();
    if (rootTeams.length > 1) bad.push(`root team 有 ${rootTeams.length} 个（必须 <= 1）`);

    const users = this.allUsers();
    const userIds = new Set(users.map((u) => u.id));
    if (new Set(users.map((u) => u.identifier)).size !== users.length) bad.push("identifier 重复");
    for (const u of users) {
      if (![USER_ROLE.ADMIN, USER_ROLE.MEMBER].includes(u.role)) bad.push(`user ${u.id} role 非法`);
      if (![USER_STATUS.ACTIVE, USER_STATUS.DISABLED].includes(u.status)) bad.push(`user ${u.id} status 非法`);
      if (!this.db.prepare("SELECT 1 FROM teams WHERE id = ?").get(u.team_id)) bad.push(`user ${u.id} 指向不存在的 team`);
      if (!Number.isFinite(u.created_at) || !Number.isFinite(u.updated_at)) bad.push(`user ${u.id} 时间戳非法`);
      if (u.created_at > u.updated_at) bad.push(`user ${u.id} updated_at 早于 created_at`);
      if (!u.password_hash || !u.password_salt) bad.push(`user ${u.id} 缺 verifier`);
    }

    const inst = insts[0];
    if (inst) {
      for (const u of users) if (u.installation_id !== inst.id) bad.push(`user ${u.id} 不属于本 installation`);
      if (inst.status === INIT.INITIALIZING) bad.push("installation 停留在 INITIALIZING（事务未提交干净）");
      if (inst.status === INIT.READY && !inst.initialized_at) bad.push("READY 但没有 initialized_at");
      if (inst.status === INIT.READY && users.length === 0) bad.push("READY 但没有任何用户（无 admin 的安装）");
    }

    for (const s of this.allSessions()) {
      if (!userIds.has(s.user_id)) bad.push(`session ${s.id} 指向不存在的 user`);
      if (!Number.isFinite(s.expires_at) || !Number.isFinite(s.idle_expires_at)) bad.push(`session ${s.id} 时间戳非法`);
      if (s.expires_at <= s.created_at) bad.push(`session ${s.id} 有效期非正`);
      if (s.revoked_at != null && !s.revoked_reason) bad.push(`session ${s.id} 已撤销但无原因`);
      if (!s.token_hash || s.token_hash.length !== 64) bad.push(`session ${s.id} token_hash 缺失或长度不对`);
    }
    return bad;
  }
}

module.exports = {
  IdentityStore,
  SchemaTooNewError,
  SCHEMA_VERSION,
  SCHEMA_SQL,
  SCHEMA_V2_SQL,
  SCHEMA_V3_SQL,
  SCHEMA_V4_SQL,
  SCHEMA_V5_SQL,
  SCHEMA_V6_SQL,
  SCHEMA_V7_SQL,
  SCHEMA_V8_SQL,
  SCHEMA_V9_SQL,
  SCHEMA_V20_SQL,
  SCHEMA_V21_POLICY_SQL,
  APP_POLICY_KEYS,
  baselinePolicyKeyOf,
  policyFamilyOfAppGrant,
  MIGRATIONS,
  IdentityStore,
  DEFAULT_TTL_MS,
  DEFAULT_IDLE_MS,
  RESET_AUTHORIZATION_DELETE_SQL,
  openDatabase,
  isBusy,
};
