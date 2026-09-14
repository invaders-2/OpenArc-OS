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

const { ERROR, INIT, USER_STATUS, USER_ROLE, REVOKE_REASON, RATE_LIMIT } = domain;

/**
 * 当前 schema 版本。
 *
 * D3-01 = v1（identity）；D3-02 = v2（object authorization）；D3-03 = v3（device）；D3-04A = v4（resource store）。
 * 迁移按版本逐级前进，每一级各自是一个原子事务：任何一级失败只回滚该级，
 * 不会留下"user_version 已升级但表不完整"的半状态（§55）。
 */
const SCHEMA_VERSION = 12;

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
]);

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12h 绝对上限
const DEFAULT_IDLE_MS = 2 * 60 * 60 * 1000; //  2h 空闲上限
const BUSY_RETRY = { attempts: 5, baseDelayMs: 15 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isBusy(err) {
  const s = `${err?.errstr || ""} ${err?.message || ""}`;
  return s.includes("SQLITE_BUSY") || s.includes("database is locked");
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
   * 迁移。**第一版就把迁移框架立起来**（§29）：
   * 现在只有一个 migration，但"以后补版本号"的债从今天起就不存在了。
   */
  #migrate() {
    const current = this.schemaVersion;
    if (current > SCHEMA_VERSION)
      throw new Error("身份库 schema_version=" + current + " 高于本程序支持的 " + SCHEMA_VERSION + "，拒绝打开。");
    if (current === SCHEMA_VERSION) return;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.transactSync(() => {
        this.db.exec(migration.sql);
        // 失败注入点：测试用它制造"DDL 已执行、版本尚未 bump"的崩溃，验证整级回滚。
        if (this.hooks.onMigration) this.hooks.onMigration(migration.version, this.db);
        // user_version 不能用占位符，只能整句拼；值是本文件常量，无注入面。
        this.db.exec("PRAGMA user_version = " + migration.version);
      });
    }
  }

  /** 同步事务：只给迁移用（迁移里没有任何 await）。 */
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
  async initialize({ identifier, password, displayName, source = "local" } = {}) {
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
              `INSERT INTO users (id, installation_id, team_id, identifier, display_name, role, status,
                                  auth_version, password_algo, password_params, password_salt, password_hash,
                                  password_version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'ADMIN', 'ACTIVE', 1, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              userId,
              existing?.id || installationId,
              teamId,
              idCheck.identifier,
              nameCheck.displayName,
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
   */
  resetInstallation({ confirm } = {}) {
    if (confirm !== "DELETE-ALL-IDENTITY-DATA") {
      this.audit("reset-installation", { result: "DENY", errorCode: ERROR.INVALID_INPUT });
      return domain.fail(ERROR.INVALID_INPUT, "confirm-required");
    }
    const started = this.clock();
    this.audit("reset-installation", { result: "OK_REQUESTED" });
    this.transactSync(() => {
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
  MIGRATIONS,
  IdentityStore,
  DEFAULT_TTL_MS,
  DEFAULT_IDLE_MS,
  openDatabase,
  isBusy,
};
