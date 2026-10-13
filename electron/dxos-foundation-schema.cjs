/**
 * P1 · DX OS 地基：表结构抽取（只读参照 DX OS 0.5.1 随包源码）。
 *
 * 为什么单独一个模块：v22 迁移要建的 DX 表全部来自这份抽取结果。
 * 把 SQL 与迁移框架分开，迁移只负责"执行"，DX 表结构只有这一处真值。
 *
 * ## 来源（DXSRC = <DX OS.app>/Contents/Resources/app.asar.unpacked/server）
 *   · ccsDb.ts:12                 schema_migrations（迁移运行前的建表）
 *   · ccsDb.ts:19-:990            48 级迁移里的全部 CREATE TABLE / CREATE INDEX / ALTER TABLE ADD COLUMN
 *   · ai-tasks/store.ts:56-:102   ai_protocol_tasks / ai_protocol_task_events
 *   · ai-tasks/legacyStore.ts:28-:47  legacy_ai_tasks
 *   · apiQuota.ts:71-:85          api_quota_rules / api_quota_usage / api_model_access
 *                                 （§4 模块 3 把 apiQuota.ts 归入数据层；配额原语依赖这三张表，
 *                                  故与上面四份来源一起抽取，成为 DXOS_TABLES 的一部分）
 *   · authDb.ts                   该文件没有任何 CREATE TABLE（:26-:29 只 DROP 旧表），无表可抽取
 *
 * ## 与 OpenArc 既有表重名的 5 张：跳过不建（DXOS_SKIPPED_TABLES）
 *   OpenArc identity.db 已有同名表且列定义与 DX 不同。硬约束是"迁移只新增表、不动既有表结构"，
 *   所以这 5 张保持 OpenArc 原样，dxosDdl() 不生成它们：
 *     · projects         —— OpenArc v7 已有（主键 id），DX ccsDb.ts:23 同名不同列
 *     · project_members  —— OpenArc v7 已有，DX ccsDb.ts:132 同名不同列
 *     · tasks            —— OpenArc v9 已有（主键 task_id），DX ccsDb.ts:46 同名不同列（DX 还有 21 个后续列）
 *     · task_steps       —— OpenArc v9 已有（主键 step_id），DX ccsDb.ts:75 同名不同列
 *     · task_events      —— OpenArc v9 已有，DX ccsDb.ts:90 同名不同列
 *
 * ## 跨域外键：只保留引用列，不建 FK（共 23 处）
 *   DX 原文用 REFERENCES tasks(id) / task_steps(id) 指向被复用表，但这两张表的主键列名不同
 *   （tasks 是 task_id、task_steps 是 step_id）—— 实测会在 OpenArc 删除 task 时抛
 *   "foreign key mismatch"，直接打断既有任务域。
 *   另一条路（把外键改指 tasks(task_id)）虽然语法成立，但会让 OpenArc 侧任何 DROP/重建
 *   tasks / task_steps 的动作被 DX 子表的外键检查拖住（tests/migration.test.mjs 的
 *   "手工降级再升级"就是用 DROP TABLE 模拟的，实测 7 个既有迁移用例会因此失败）。
 *   因此这里把引用这 5 张 OpenArc 表的外键整体去掉，只留普通列：跨域引用由 P4 任务域
 *   对齐列之后自行决定要不要补约束。DX 自己建的表之间的外键（threads / agent_runs /
 *   agent_profiles / canvas_invites / ai_protocol_tasks 等）原样保留。
 *
 * ## ALTER 的折叠（幂等的前提）
 *   DX 的 48 级迁移对 19 张表做过 ALTER TABLE ADD COLUMN。抽取时把这些列并入对应
 *   CREATE TABLE 的列区（放在表级约束之前），因此单条 CREATE TABLE IF NOT EXISTS
 *   就等于"DX 迁移跑完后的最终列集"，重复执行不会因为列已存在而报错。
 *   迁移里的 INSERT / UPDATE（v34 的 4 条内置 agent_profiles 种子、v47/v48 的 JSON 回填）
 *   不抽取 —— 那是数据搬运不是 DDL，对空表也无意义；需要种子数据的域在自己的批次里补。
 *
 * 本文件是机械抽取的产物：语句顺序 = DX 源码里首次出现的顺序（表在前、索引在后）。
 */
"use strict";

/** DX OS 抽取到的全部表名（57 = 52 张实际新建 + 5 张与 OpenArc 重名被跳过）。 */
const DXOS_TABLES = Object.freeze([
  "schema_migrations",
  "projects",
  "threads",
  "thread_messages",
  "tasks",
  "task_plans",
  "task_steps",
  "task_events",
  "task_checkpoints",
  "deliverables",
  "tool_operations",
  "project_members",
  "task_observations",
  "worker_instances",
  "project_memories",
  "automations",
  "automation_runs",
  "canvases",
  "canvas_members",
  "canvas_invites",
  "canvas_invite_members",
  "user_preferences",
  "user_wallpapers",
  "user_installed_apps",
  "user_app_install_state",
  "app_market_releases",
  "app_credential_bindings",
  "app_oauth_tokens",
  "app_runtime_events",
  "app_network_audit",
  "cloud_account_sessions",
  "installation_identity",
  "cloud_installation_binding",
  "cloud_installation_sessions",
  "cloud_entitlement_cache",
  "system_preferences",
  "canvas_cloud_sync_baselines",
  "agent_runs",
  "agent_run_events",
  "agent_profiles",
  "agent_delegations",
  "developer_agent_artifacts",
  "agent_workspaces",
  "agent_artifacts",
  "agent_artifact_reviews",
  "agent_review_corrections",
  "agent_usage_events",
  "agent_commit_journals",
  "task_attempts",
  "agent_turns",
  "agent_checkpoints",
  "api_quota_rules",
  "api_quota_usage",
  "api_model_access",
  "ai_protocol_tasks",
  "ai_protocol_task_events",
  "legacy_ai_tasks"
]);

/** 与 OpenArc identity.db 既有表重名、v22 刻意不建的 5 张。 */
const DXOS_SKIPPED_TABLES = Object.freeze([
  "projects",
  "project_members",
  "tasks",
  "task_steps",
  "task_events"
]);

/** dxosDdl() 实际会建的 52 张（DXOS_TABLES 去掉 DXOS_SKIPPED_TABLES）。 */
const DXOS_CREATED_TABLES = Object.freeze([
  "schema_migrations",
  "threads",
  "thread_messages",
  "task_plans",
  "task_checkpoints",
  "deliverables",
  "tool_operations",
  "task_observations",
  "worker_instances",
  "project_memories",
  "automations",
  "automation_runs",
  "canvases",
  "canvas_members",
  "canvas_invites",
  "canvas_invite_members",
  "user_preferences",
  "user_wallpapers",
  "user_installed_apps",
  "user_app_install_state",
  "app_market_releases",
  "app_credential_bindings",
  "app_oauth_tokens",
  "app_runtime_events",
  "app_network_audit",
  "cloud_account_sessions",
  "installation_identity",
  "cloud_installation_binding",
  "cloud_installation_sessions",
  "cloud_entitlement_cache",
  "system_preferences",
  "canvas_cloud_sync_baselines",
  "agent_runs",
  "agent_run_events",
  "agent_profiles",
  "agent_delegations",
  "developer_agent_artifacts",
  "agent_workspaces",
  "agent_artifacts",
  "agent_artifact_reviews",
  "agent_review_corrections",
  "agent_usage_events",
  "agent_commit_journals",
  "task_attempts",
  "agent_turns",
  "agent_checkpoints",
  "api_quota_rules",
  "api_quota_usage",
  "api_model_access",
  "ai_protocol_tasks",
  "ai_protocol_task_events",
  "legacy_ai_tasks"
]);

/** 配额原语依赖的表（apiQuota.ts）。 */
const DXOS_QUOTA_TABLES = Object.freeze([
  "api_quota_rules",
  "api_quota_usage",
  "api_model_access"
]);

/**
 * 幂等 DDL：全部 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。
 * 表先于索引，保证索引引用的列与表都已存在。
 */
const DXOS_DDL = Object.freeze([
  "CREATE TABLE IF NOT EXISTS schema_migrations (\n  version INTEGER PRIMARY KEY,\n  applied_at INTEGER NOT NULL\n)",
  "CREATE TABLE IF NOT EXISTS threads (\n        id TEXT PRIMARY KEY,\n        project_id TEXT NOT NULL,\n        title TEXT NOT NULL,\n        visibility TEXT NOT NULL DEFAULT 'private',\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n  created_by TEXT\n      )",
  "CREATE TABLE IF NOT EXISTS thread_messages (\n        id TEXT PRIMARY KEY,\n        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,\n        role TEXT NOT NULL,\n        content TEXT NOT NULL,\n        created_at INTEGER NOT NULL,\n  task_id TEXT\n      )",
  "CREATE TABLE IF NOT EXISTS task_plans (\n        id TEXT PRIMARY KEY,\n        task_id TEXT NOT NULL UNIQUE,\n        goal TEXT NOT NULL,\n        assumptions TEXT NOT NULL DEFAULT '[]',\n        acceptance TEXT NOT NULL DEFAULT '[]',\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n  version INTEGER NOT NULL DEFAULT 1\n      )",
  "CREATE TABLE IF NOT EXISTS task_checkpoints (\n        id TEXT PRIMARY KEY,\n        task_id TEXT NOT NULL,\n        step_id TEXT,\n        state_json TEXT NOT NULL,\n        created_at INTEGER NOT NULL,\n  iteration INTEGER NOT NULL DEFAULT 0,\n  plan_version INTEGER NOT NULL DEFAULT 1,\n  context_summary TEXT\n      )",
  "CREATE TABLE IF NOT EXISTS deliverables (\n        id TEXT PRIMARY KEY,\n        task_id TEXT NOT NULL,\n        project_id TEXT NOT NULL,\n        node_id TEXT NOT NULL,\n        name TEXT NOT NULL,\n        created_at INTEGER NOT NULL,\n  verification_status TEXT NOT NULL DEFAULT 'pending',\n  updated_at INTEGER,\n        UNIQUE(task_id, node_id)\n      )",
  "CREATE TABLE IF NOT EXISTS tool_operations (\n        operation_id TEXT PRIMARY KEY,\n        task_id TEXT NOT NULL,\n        tool_name TEXT NOT NULL,\n        status TEXT NOT NULL,\n        result_json TEXT,\n        created_at INTEGER NOT NULL,\n        completed_at INTEGER,\n  step_id TEXT,\n  input_hash TEXT\n      )",
  "CREATE TABLE IF NOT EXISTS task_observations (\n        id TEXT PRIMARY KEY,\n        task_id TEXT NOT NULL,\n        step_id TEXT NOT NULL,\n        operation_id TEXT NOT NULL UNIQUE,\n        tool_name TEXT NOT NULL,\n        status TEXT NOT NULL,\n        summary TEXT NOT NULL,\n        data_json TEXT,\n        created_at INTEGER NOT NULL\n      )",
  "CREATE TABLE IF NOT EXISTS worker_instances (\n        id TEXT PRIMARY KEY,\n        pid INTEGER NOT NULL,\n        status TEXT NOT NULL,\n        started_at INTEGER NOT NULL,\n        heartbeat_at INTEGER NOT NULL,\n        stopped_at INTEGER\n      )",
  "CREATE TABLE IF NOT EXISTS project_memories (\n        id TEXT PRIMARY KEY,\n        project_id TEXT NOT NULL,\n        content TEXT NOT NULL,\n        source_type TEXT NOT NULL DEFAULT 'user',\n        source_id TEXT,\n        version INTEGER NOT NULL DEFAULT 1,\n        replaces_id TEXT REFERENCES project_memories(id) ON DELETE SET NULL,\n        status TEXT NOT NULL DEFAULT 'active',\n        created_by TEXT,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL\n      )",
  "CREATE TABLE IF NOT EXISTS automations (\n        id TEXT PRIMARY KEY,\n        created_by TEXT NOT NULL,\n        title TEXT NOT NULL,\n        instruction TEXT NOT NULL,\n        action_json TEXT NOT NULL,\n        schedule_json TEXT NOT NULL,\n        enabled INTEGER NOT NULL DEFAULT 1,\n        next_run_at INTEGER,\n        last_run_at INTEGER,\n        last_status TEXT,\n        last_error TEXT,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL\n      )",
  "CREATE TABLE IF NOT EXISTS automation_runs (\n        id TEXT PRIMARY KEY,\n        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,\n        scheduled_for INTEGER NOT NULL,\n        status TEXT NOT NULL,\n        client_id TEXT,\n        result TEXT,\n        error TEXT,\n        created_at INTEGER NOT NULL,\n        started_at INTEGER,\n        completed_at INTEGER\n      )",
  "CREATE TABLE IF NOT EXISTS canvases (\n        id TEXT PRIMARY KEY,\n        project_id TEXT,\n        owner_id TEXT NOT NULL,\n        title TEXT NOT NULL,\n        document_json TEXT NOT NULL,\n        version INTEGER NOT NULL DEFAULT 1,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n  visibility TEXT NOT NULL DEFAULT 'restricted',\n  deleted_at INTEGER,\n  card_count INTEGER NOT NULL DEFAULT 0,\n  thumbnail TEXT\n      )",
  "CREATE TABLE IF NOT EXISTS canvas_members (\n        canvas_id TEXT NOT NULL,\n        user_id TEXT NOT NULL,\n        PRIMARY KEY (canvas_id, user_id)\n      )",
  "CREATE TABLE IF NOT EXISTS canvas_invites (\n        id TEXT PRIMARY KEY,\n        canvas_id TEXT NOT NULL,\n        code_hash TEXT NOT NULL UNIQUE,\n        code_hint TEXT NOT NULL,\n        permission TEXT NOT NULL CHECK (permission IN ('read','edit')),\n        created_by TEXT NOT NULL,\n        created_at INTEGER NOT NULL,\n        revoked_at INTEGER\n      )",
  "CREATE TABLE IF NOT EXISTS canvas_invite_members (\n        invite_id TEXT NOT NULL REFERENCES canvas_invites(id) ON DELETE CASCADE,\n        user_id TEXT NOT NULL,\n        joined_at INTEGER NOT NULL,\n        PRIMARY KEY (invite_id, user_id)\n      )",
  "CREATE TABLE IF NOT EXISTS user_preferences (\n        user_id TEXT PRIMARY KEY,\n        active_wallpaper_id TEXT NOT NULL DEFAULT 'system-default',\n        updated_at INTEGER NOT NULL,\n  light_wallpaper_id TEXT,\n  dark_wallpaper_id TEXT\n      )",
  "CREATE TABLE IF NOT EXISTS user_wallpapers (\n        id TEXT PRIMARY KEY,\n        user_id TEXT NOT NULL,\n        name TEXT NOT NULL,\n        mime TEXT NOT NULL,\n        size INTEGER NOT NULL,\n        created_at INTEGER NOT NULL\n      )",
  "CREATE TABLE IF NOT EXISTS user_installed_apps (\n        user_id TEXT NOT NULL,\n        app_id TEXT NOT NULL,\n        installed_at INTEGER NOT NULL,\n  installed_version TEXT NOT NULL DEFAULT '0.0.0',\n  installed_build INTEGER NOT NULL DEFAULT 0,\n  release_channel TEXT NOT NULL DEFAULT 'stable',\n  updated_at INTEGER NOT NULL DEFAULT 0,\n        PRIMARY KEY(user_id, app_id)\n      )",
  "CREATE TABLE IF NOT EXISTS user_app_install_state (\n        user_id TEXT PRIMARY KEY,\n        migrated_at INTEGER NOT NULL,\n  catalog_migrated_at INTEGER\n      )",
  "CREATE TABLE IF NOT EXISTS app_market_releases (\n        app_id TEXT NOT NULL,\n        version TEXT NOT NULL,\n        build INTEGER NOT NULL,\n        channel TEXT NOT NULL CHECK (channel IN ('stable','beta','dev')),\n        delivery TEXT NOT NULL DEFAULT 'dx-app' CHECK (delivery IN ('dx-app','system-bundle')),\n        package_path TEXT NOT NULL,\n        package_size INTEGER NOT NULL,\n        sha256 TEXT NOT NULL,\n        signature TEXT NOT NULL,\n        signing_key_id TEXT NOT NULL,\n        min_system_version TEXT NOT NULL,\n        max_system_version TEXT,\n        data_version INTEGER NOT NULL,\n        mandatory INTEGER NOT NULL DEFAULT 0,\n        rollout_percent INTEGER NOT NULL DEFAULT 100,\n        release_notes TEXT NOT NULL DEFAULT '',\n        publisher_user_id TEXT NOT NULL,\n        published_at INTEGER NOT NULL,\n        revoked_at INTEGER,\n  review_status TEXT NOT NULL DEFAULT 'approved',\n  reviewed_by TEXT,\n  reviewed_at INTEGER,\n        PRIMARY KEY(app_id, version, build, channel)\n      )",
  "CREATE TABLE IF NOT EXISTS app_credential_bindings (\n        user_id TEXT NOT NULL,\n        app_id TEXT NOT NULL,\n        binding_id TEXT NOT NULL,\n        provider_id TEXT NOT NULL,\n        auth_type TEXT NOT NULL DEFAULT 'bearer',\n        header_name TEXT,\n        bound_at INTEGER NOT NULL,\n        PRIMARY KEY(user_id, app_id, binding_id)\n      )",
  "CREATE TABLE IF NOT EXISTS app_oauth_tokens (\n        user_id TEXT NOT NULL,\n        app_id TEXT NOT NULL,\n        oauth_id TEXT NOT NULL,\n        access_token_enc TEXT NOT NULL,\n        refresh_token_enc TEXT,\n        token_type TEXT NOT NULL DEFAULT 'Bearer',\n        scope TEXT,\n        expires_at INTEGER,\n        updated_at INTEGER NOT NULL,\n        PRIMARY KEY(user_id, app_id, oauth_id)\n      )",
  "CREATE TABLE IF NOT EXISTS app_runtime_events (\n        id TEXT PRIMARY KEY,\n        app_id TEXT NOT NULL,\n        version TEXT NOT NULL,\n        build INTEGER NOT NULL,\n        user_id TEXT NOT NULL,\n        event_type TEXT NOT NULL,\n        detail TEXT,\n        created_at INTEGER NOT NULL\n      )",
  "CREATE TABLE IF NOT EXISTS app_network_audit (\n        id INTEGER PRIMARY KEY AUTOINCREMENT,\n        user_id TEXT NOT NULL,\n        app_id TEXT NOT NULL,\n        method TEXT NOT NULL,\n        origin TEXT NOT NULL,\n        pathname TEXT NOT NULL,\n        status INTEGER NOT NULL,\n        response_bytes INTEGER NOT NULL,\n        credential_ref INTEGER NOT NULL DEFAULT 0,\n        created_at INTEGER NOT NULL\n      )",
  "CREATE TABLE IF NOT EXISTS cloud_account_sessions (\n        local_user_id TEXT PRIMARY KEY,\n        cloud_user_id TEXT NOT NULL,\n        email TEXT NOT NULL,\n        display_name TEXT,\n        access_token_enc TEXT NOT NULL,\n        refresh_token_enc TEXT NOT NULL,\n        access_expires_at INTEGER NOT NULL,\n        refresh_expires_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL\n      )",
  "CREATE TABLE IF NOT EXISTS installation_identity (\n        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),\n        installation_id TEXT NOT NULL UNIQUE,\n        device_public_id TEXT NOT NULL UNIQUE,\n        created_at INTEGER NOT NULL,\n        schema_version INTEGER NOT NULL DEFAULT 1\n      )",
  "CREATE TABLE IF NOT EXISTS cloud_installation_binding (\n        id TEXT PRIMARY KEY,\n        installation_id TEXT NOT NULL UNIQUE REFERENCES installation_identity(installation_id) ON DELETE CASCADE,\n        cloud_user_id TEXT NOT NULL,\n        organization_id TEXT,\n        device_id TEXT,\n        status TEXT NOT NULL CHECK (status IN ('active','revoked','unbound')),\n        bound_by_local_user_id TEXT NOT NULL,\n        bound_at INTEGER NOT NULL,\n        last_verified_at INTEGER,\n        unbound_at INTEGER,\n        updated_at INTEGER NOT NULL\n      )",
  "CREATE TABLE IF NOT EXISTS cloud_installation_sessions (\n        installation_id TEXT PRIMARY KEY REFERENCES installation_identity(installation_id) ON DELETE CASCADE,\n        cloud_user_id TEXT NOT NULL,\n        email TEXT NOT NULL,\n        display_name TEXT,\n        access_token_enc TEXT NOT NULL,\n        refresh_token_enc TEXT NOT NULL,\n        access_expires_at INTEGER NOT NULL,\n        refresh_expires_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL\n      )",
  "CREATE TABLE IF NOT EXISTS cloud_entitlement_cache (\n        installation_id TEXT PRIMARY KEY REFERENCES installation_identity(installation_id) ON DELETE CASCADE,\n        key_id TEXT NOT NULL,\n        algorithm TEXT NOT NULL CHECK (algorithm = 'Ed25519'),\n        token TEXT NOT NULL,\n        signature TEXT NOT NULL,\n        fetched_at INTEGER NOT NULL,\n        expires_at INTEGER NOT NULL,\n        grace_until INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL\n      )",
  "CREATE TABLE IF NOT EXISTS system_preferences (\n        preference_key TEXT PRIMARY KEY,\n        preference_value TEXT NOT NULL,\n        updated_by TEXT,\n        updated_at INTEGER NOT NULL\n      )",
  "CREATE TABLE IF NOT EXISTS canvas_cloud_sync_baselines (\n        local_user_id TEXT NOT NULL,\n        cloud_user_id TEXT NOT NULL,\n        canvas_id TEXT NOT NULL,\n        remote_revision INTEGER NOT NULL DEFAULT 0,\n        manifest_json TEXT NOT NULL,\n        updated_at INTEGER NOT NULL,\n        PRIMARY KEY (local_user_id, cloud_user_id, canvas_id)\n      )",
  "CREATE TABLE IF NOT EXISTS agent_runs (\n        id TEXT PRIMARY KEY,\n        correlation_id TEXT NOT NULL,\n        causation_id TEXT,\n        session_id TEXT,\n        task_id TEXT UNIQUE,\n        project_id TEXT,\n        app_id TEXT,\n        user_id TEXT,\n        entry_point TEXT NOT NULL,\n        status TEXT NOT NULL CHECK (status IN ('created','running','waiting_user','completed','failed','cancelled')),\n        goal TEXT NOT NULL,\n        context_json TEXT,\n        capability_count INTEGER NOT NULL DEFAULT 0,\n        result_json TEXT,\n        error_message TEXT,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n        started_at INTEGER,\n        completed_at INTEGER,\n  parent_run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,\n  root_run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,\n  agent_profile_id TEXT,\n  delegated_by_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,\n  capability_ids_json TEXT NOT NULL DEFAULT '[]',\n  delegation_depth INTEGER NOT NULL DEFAULT 0\n      )",
  "CREATE TABLE IF NOT EXISTS agent_run_events (\n        id TEXT PRIMARY KEY,\n        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,\n        sequence INTEGER NOT NULL,\n        type TEXT NOT NULL,\n        correlation_id TEXT NOT NULL,\n        causation_id TEXT,\n        data_json TEXT,\n        created_at INTEGER NOT NULL,\n        UNIQUE(run_id, sequence)\n      )",
  "CREATE TABLE IF NOT EXISTS agent_profiles (\n        id TEXT PRIMARY KEY,\n        name TEXT NOT NULL,\n        description TEXT NOT NULL,\n        capability_scopes_json TEXT NOT NULL,\n        model_profile TEXT NOT NULL,\n        max_model_calls INTEGER,\n        max_tool_calls INTEGER,\n        system_prompt TEXT NOT NULL DEFAULT '',\n        builtin INTEGER NOT NULL DEFAULT 1,\n        enabled INTEGER NOT NULL DEFAULT 1,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n  allowed_risks_json TEXT NOT NULL DEFAULT '[\"read\",\"write\",\"delete\",\"external\",\"system\"]'\n      )",
  "CREATE TABLE IF NOT EXISTS agent_delegations (\n        id TEXT PRIMARY KEY,\n        parent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,\n        child_run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,\n        parent_task_id TEXT,\n        child_task_id TEXT NOT NULL UNIQUE,\n        agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),\n        ordinal INTEGER NOT NULL,\n        depends_on_json TEXT NOT NULL DEFAULT '[]',\n        expected_output_schema TEXT,\n        permission_grant_json TEXT NOT NULL DEFAULT '[]',\n        status TEXT NOT NULL,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n  request_hash TEXT,\n        UNIQUE(parent_run_id, ordinal)\n      )",
  "CREATE TABLE IF NOT EXISTS developer_agent_artifacts (\n        app_id TEXT NOT NULL,\n        user_id TEXT NOT NULL,\n        session_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,\n        project_id TEXT NOT NULL,\n        path TEXT NOT NULL,\n        created_at INTEGER NOT NULL,\n        PRIMARY KEY (app_id, user_id, session_id, path)\n      )",
  "CREATE TABLE IF NOT EXISTS agent_workspaces (\n        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,\n        project_id TEXT NOT NULL,\n        source_root_id TEXT NOT NULL,\n        workspace_root_id TEXT NOT NULL,\n        user_id TEXT NOT NULL,\n        status TEXT NOT NULL CHECK (status IN ('active','committed','conflicted','abandoned')),\n        base_manifest_json TEXT NOT NULL,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n        committed_at INTEGER\n      )",
  "CREATE TABLE IF NOT EXISTS agent_artifacts (\n        id TEXT PRIMARY KEY,\n        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,\n        path TEXT NOT NULL,\n        kind TEXT NOT NULL DEFAULT 'text',\n        bytes INTEGER NOT NULL,\n        sha256 TEXT NOT NULL,\n        base_sha256 TEXT,\n        status TEXT NOT NULL CHECK (status IN ('produced','validated','rejected','committed','conflicted')),\n        validation_json TEXT,\n        committed_node_id TEXT,\n        error_message TEXT,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n  mime TEXT,\n        UNIQUE(run_id,path)\n      )",
  "CREATE TABLE IF NOT EXISTS agent_artifact_reviews (\n        id TEXT PRIMARY KEY,\n        producer_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,\n        reviewer_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,\n        decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),\n        artifact_hashes_json TEXT NOT NULL,\n        feedback TEXT,\n        reviewed_by TEXT NOT NULL,\n        created_at INTEGER NOT NULL,\n        UNIQUE(producer_run_id,reviewer_run_id)\n      )",
  "CREATE TABLE IF NOT EXISTS agent_review_corrections (\n        id TEXT PRIMARY KEY,\n        parent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,\n        producer_run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,\n        reviewer_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,\n        correction_producer_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,\n        correction_reviewer_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,\n        attempt INTEGER NOT NULL DEFAULT 1,\n        status TEXT NOT NULL,\n        feedback TEXT,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL\n      )",
  "CREATE TABLE IF NOT EXISTS agent_usage_events (\n        id TEXT PRIMARY KEY,\n        invocation_id TEXT NOT NULL UNIQUE,\n        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,\n        task_id TEXT,\n        kind TEXT NOT NULL CHECK (kind IN ('model','tool')),\n        provider_id TEXT,\n        model TEXT,\n        tool_name TEXT,\n        status TEXT NOT NULL CHECK (status IN ('started','completed','failed','cancelled')),\n        input_tokens INTEGER,\n        output_tokens INTEGER,\n        total_tokens INTEGER,\n        latency_ms INTEGER,\n        cost_micros INTEGER,\n        cost_unit TEXT,\n        cost_estimated INTEGER CHECK (cost_estimated IN (0,1)),\n        error_message TEXT,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n        completed_at INTEGER,\n  cached_input_tokens INTEGER,\n  cache_creation_input_tokens INTEGER,\n  reasoning_tokens INTEGER\n      )",
  "CREATE TABLE IF NOT EXISTS agent_commit_journals (\n        id TEXT PRIMARY KEY,\n        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,\n        project_id TEXT NOT NULL,\n        user_id TEXT NOT NULL,\n        status TEXT NOT NULL CHECK (status IN ('prepared','published','completed','rolled_back','conflicted')),\n        base_revision INTEGER NOT NULL,\n        target_revision INTEGER NOT NULL,\n        artifact_ids_json TEXT NOT NULL,\n        plan_json TEXT NOT NULL,\n        error_message TEXT,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n        published_at INTEGER,\n        completed_at INTEGER\n      )",
  "CREATE TABLE IF NOT EXISTS task_attempts (\n        id TEXT PRIMARY KEY,\n        task_id TEXT NOT NULL,\n        attempt_no INTEGER NOT NULL,\n        worker_id TEXT NOT NULL,\n        lease_token TEXT NOT NULL UNIQUE,\n        status TEXT NOT NULL CHECK (status IN ('running','interrupted','completed','failed','waiting','cancelled')),\n        claimed_at INTEGER NOT NULL,\n        heartbeat_at INTEGER NOT NULL,\n        lease_until INTEGER NOT NULL,\n        ended_at INTEGER,\n        error_message TEXT,\n        UNIQUE(task_id,attempt_no)\n      )",
  "CREATE TABLE IF NOT EXISTS agent_turns (\n        id TEXT PRIMARY KEY,\n        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,\n        task_id TEXT NOT NULL,\n        attempt_no INTEGER NOT NULL,\n        iteration INTEGER NOT NULL,\n        request_hash TEXT NOT NULL,\n        status TEXT NOT NULL CHECK (status IN ('responded','processing','completed','abandoned')),\n        response_json TEXT NOT NULL,\n        next_tool_index INTEGER NOT NULL DEFAULT 0,\n        created_at INTEGER NOT NULL,\n        updated_at INTEGER NOT NULL,\n        completed_at INTEGER,\n        UNIQUE(task_id,iteration)\n      )",
  "CREATE TABLE IF NOT EXISTS agent_checkpoints (\n        id TEXT PRIMARY KEY,\n        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,\n        task_id TEXT NOT NULL,\n        attempt_no INTEGER NOT NULL,\n        sequence INTEGER NOT NULL,\n        schema_version TEXT NOT NULL,\n        phase TEXT NOT NULL,\n        state_json TEXT NOT NULL,\n        created_at INTEGER NOT NULL,\n        UNIQUE(task_id,sequence)\n      )",
  "CREATE TABLE IF NOT EXISTS api_quota_rules (\n      department_id TEXT NOT NULL, provider_id TEXT NOT NULL, limit_amount INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL, PRIMARY KEY(department_id, provider_id)\n    )",
  "CREATE TABLE IF NOT EXISTS api_quota_usage (\n      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, department_id TEXT NOT NULL,\n      provider_id TEXT NOT NULL, model_id TEXT NOT NULL, amount INTEGER NOT NULL,\n      status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL\n    )",
  "CREATE TABLE IF NOT EXISTS api_model_access (\n      department_id TEXT PRIMARY KEY, models_json TEXT NOT NULL, updated_at INTEGER NOT NULL\n    )",
  "CREATE TABLE IF NOT EXISTS ai_protocol_tasks (\n  id TEXT PRIMARY KEY,\n  surface TEXT NOT NULL DEFAULT 'canvas',\n  owner_id TEXT,\n  canvas_id TEXT,\n  provider_site_id TEXT,\n  model_id TEXT,\n  base_url TEXT,\n  status TEXT NOT NULL,\n  mode TEXT NOT NULL,\n  executor_type TEXT NOT NULL DEFAULT 'declarative',\n  executor_adapter TEXT,\n  request_json TEXT NOT NULL,\n  plan_json TEXT NOT NULL,\n  plan_hash TEXT NOT NULL,\n  provider_protocol_id TEXT NOT NULL,\n  provider_protocol_version INTEGER NOT NULL,\n  provider_protocol_hash TEXT NOT NULL,\n  model_protocol_id TEXT NOT NULL,\n  model_protocol_version INTEGER NOT NULL,\n  model_protocol_hash TEXT NOT NULL,\n  profile_id TEXT NOT NULL,\n  intent TEXT NOT NULL,\n  remote_task_id TEXT,\n  result_json TEXT,\n  error_message TEXT,\n  workflow_state_json TEXT,\n  next_poll_at INTEGER,\n  poll_attempt INTEGER NOT NULL DEFAULT 0,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL,\n  started_at INTEGER,\n  completed_at INTEGER\n)",
  "CREATE TABLE IF NOT EXISTS ai_protocol_task_events (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  task_id TEXT NOT NULL REFERENCES ai_protocol_tasks(id) ON DELETE CASCADE,\n  sequence INTEGER NOT NULL,\n  type TEXT NOT NULL,\n  data_json TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  UNIQUE(task_id, sequence)\n)",
  "CREATE TABLE IF NOT EXISTS legacy_ai_tasks (\n  id TEXT PRIMARY KEY,\n  owner_id TEXT NOT NULL,\n  canvas_id TEXT NOT NULL,\n  status TEXT NOT NULL,\n  request_json TEXT NOT NULL,\n  remote_task_id TEXT,\n  output_kind TEXT NOT NULL,\n  prompt TEXT NOT NULL,\n  response_json TEXT,\n  error_message TEXT,\n  http_status INTEGER,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL,\n  completed_at INTEGER\n)",
  "CREATE INDEX IF NOT EXISTS idx_observations_task ON task_observations(task_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_workers_heartbeat ON worker_instances(heartbeat_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_memories_project ON project_memories(project_id, status, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(created_by, enabled, next_run_at)",
  "CREATE INDEX IF NOT EXISTS idx_automation_runs_task ON automation_runs(automation_id, created_at DESC)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_scheduled ON automation_runs(automation_id, scheduled_for)",
  "CREATE INDEX IF NOT EXISTS idx_canvases_owner ON canvases(owner_id, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_canvases_project ON canvases(project_id, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_canvas_members_user ON canvas_members(user_id)",
  "CREATE INDEX IF NOT EXISTS idx_canvases_deleted ON canvases(owner_id, deleted_at, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_canvas_invites_canvas ON canvas_invites(canvas_id, revoked_at, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_canvas_invite_members_user ON canvas_invite_members(user_id, invite_id)",
  "CREATE INDEX IF NOT EXISTS idx_user_wallpapers_user ON user_wallpapers(user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_user_installed_apps_user ON user_installed_apps(user_id, installed_at)",
  "CREATE INDEX IF NOT EXISTS idx_app_market_catalog\n        ON app_market_releases(channel, revoked_at, published_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_app_market_app\n        ON app_market_releases(app_id, channel, revoked_at, published_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_app_credential_bindings_user_app ON app_credential_bindings(user_id, app_id)",
  "CREATE INDEX IF NOT EXISTS idx_app_oauth_tokens_user_app ON app_oauth_tokens(user_id, app_id)",
  "CREATE INDEX IF NOT EXISTS idx_app_runtime_events_app_time ON app_runtime_events(app_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_app_network_audit_app_time ON app_network_audit(app_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_cloud_account_sessions_cloud_user\n        ON cloud_account_sessions(cloud_user_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_installation_binding_active\n        ON cloud_installation_binding(installation_id) WHERE status = 'active'",
  "CREATE INDEX IF NOT EXISTS idx_cloud_installation_binding_cloud_user\n        ON cloud_installation_binding(cloud_user_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_cloud_installation_sessions_cloud_user\n        ON cloud_installation_sessions(cloud_user_id)",
  "CREATE INDEX IF NOT EXISTS idx_cloud_entitlement_expiry\n        ON cloud_entitlement_cache(expires_at, grace_until)",
  "CREATE INDEX IF NOT EXISTS idx_canvas_cloud_sync_baselines_cloud\n        ON canvas_cloud_sync_baselines(cloud_user_id, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs(project_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs(user_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_agent_run_events_run ON agent_run_events(run_id, sequence)",
  "CREATE INDEX IF NOT EXISTS idx_agent_runs_parent ON agent_runs(parent_run_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_agent_runs_root ON agent_runs(root_run_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_agent_delegations_parent ON agent_delegations(parent_run_id, ordinal)",
  "CREATE INDEX IF NOT EXISTS idx_developer_agent_artifacts_session\n        ON developer_agent_artifacts(app_id, user_id, session_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_agent_artifacts_run ON agent_artifacts(run_id,status,created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_delegations_parent_request\n        ON agent_delegations(parent_run_id,request_hash) WHERE request_hash IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_agent_artifact_reviews_producer ON agent_artifact_reviews(producer_run_id,created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_agent_review_corrections_parent\n        ON agent_review_corrections(parent_run_id,created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_review_corrections_reviewer\n        ON agent_review_corrections(correction_reviewer_run_id)\n        WHERE correction_reviewer_run_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_agent_usage_events_run ON agent_usage_events(run_id,created_at)",
  "CREATE INDEX IF NOT EXISTS idx_agent_usage_events_task ON agent_usage_events(task_id,created_at)",
  "CREATE INDEX IF NOT EXISTS idx_agent_commit_journals_status\n        ON agent_commit_journals(status,created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_commit_journals_active_run\n        ON agent_commit_journals(run_id)\n        WHERE status IN ('prepared','published')",
  "CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts(task_id,attempt_no DESC)",
  "CREATE INDEX IF NOT EXISTS idx_task_attempts_lease ON task_attempts(status,lease_until)",
  "CREATE INDEX IF NOT EXISTS idx_agent_turns_resume ON agent_turns(task_id,status,iteration DESC)",
  "CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_latest ON agent_checkpoints(task_id,sequence DESC)",
  "CREATE INDEX IF NOT EXISTS idx_canvases_visible_updated ON canvases(deleted_at,owner_id,visibility,updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_canvas_members_user_canvas ON canvas_members(user_id,canvas_id)",
  "CREATE INDEX IF NOT EXISTS idx_canvas_invite_members_user_invite ON canvas_invite_members(user_id,invite_id)",
  "CREATE INDEX IF NOT EXISTS idx_api_quota_usage_scope ON api_quota_usage(department_id, provider_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_ai_protocol_tasks_status ON ai_protocol_tasks(status, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_ai_protocol_events_task ON ai_protocol_task_events(task_id, sequence)",
  "CREATE INDEX IF NOT EXISTS idx_legacy_ai_tasks_owner ON legacy_ai_tasks(owner_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_legacy_ai_tasks_status ON legacy_ai_tasks(status, updated_at)"
]);

/** @returns {string[]} DDL 语句副本（调用方修改不影响模块内常量）。 */
function dxosDdl() {
  return DXOS_DDL.slice();
}

module.exports = {
  DXOS_TABLES,
  DXOS_SKIPPED_TABLES,
  DXOS_CREATED_TABLES,
  DXOS_QUOTA_TABLES,
  DXOS_DDL,
  dxosDdl,
};
