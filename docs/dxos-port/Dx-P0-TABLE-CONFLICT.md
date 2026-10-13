# Dx-P0 · 表冲突清单（OpenArc 65 表 vs DX OS 51 表）

> 取证方式：`grep -oE "CREATE TABLE (IF NOT EXISTS )?<name>"` 于
> · OpenArc：`electron/identity-store.cjs`
> · DX OS：`ccsDb.ts`、`authDb.ts`、`ai-tasks/store.ts`、`ai-tasks/legacyStore.ts`（源目录见 §2.2 路径）
>
> 计数口径：本清单只统计源码中**字面**的 `CREATE TABLE` 语句。

## 1. 实测计数与勘误

| 项 | 计划原文 | 实测 | 说明 |
|---|---|---|---|
| OpenArc 表 | 65 张 | **64 张** | 差 1；计划数可能含动态建表或另一处 DDL，**保留为待核对项** |
| DX OS 表 | 51 张（`ccsDb.ts` 51 表 / 48 迁移） | **55 张**（跨 4 个文件合计） | 口径不同：计划按 `ccsDb.ts` 单文件计数；本清单含 `authDb.ts` 与 `ai-tasks/*` |
| 冲突表 | 计划未给 | **5 张** | 见下 |

## 2. 同名冲突表（5 张，**跳过不建**）

| 表名 | OpenArc 侧 | DX OS 侧 | 处理 |
|---|---|---|---|
| `projects` | 有 | 有 | 保留 OpenArc 定义；DX OS 侧字段差异登记为**待对齐**，本轮不动既有表结构 |
| `project_members` | 有 | 有 | 同上 |
| `tasks` | 有 | 有 | 同上 |
| `task_steps` | 有 | 有 | 同上 |
| `task_events` | 有 | 有 | 同上 |

处理原则（计划 §6.2）：**迁移只新增表**，不动现有表结构（除必要索引）；表名保持 DX OS 原名以避免语义漂移；同名表先做冲突清单再合并 —— 本轮只出清单与跳过决策，字段级合并留待后续阶段显式决策。

## 3. 额外跳过

| 表名 | 理由 |
|---|---|
| `schema_migrations` | DX OS 自己的迁移记账表；OpenArc 已有一套迁移框架（`MIGRATIONS` + `SCHEMA_VERSION`），并入会造成两套记账并存 |

## 4. DX OS 表全量（55）

```
agent_artifact_reviews, agent_artifacts, agent_checkpoints, agent_commit_journals, agent_delegations,
agent_profiles, agent_review_corrections, agent_run_events, agent_runs, agent_turns, agent_usage_events,
agent_workspaces, ai_protocol_artifacts, ai_protocol_task_events, ai_protocol_tasks, app_credential_bindings,
app_market_releases, app_network_audit, app_oauth_tokens, app_runtime_events, automation_runs, automations,
canvas_cloud_sync_baselines, canvas_invite_members, canvas_invites, canvas_members, canvases,
cloud_account_sessions, cloud_entitlement_cache, cloud_installation_binding, cloud_installation_sessions,
deliverables, developer_agent_artifacts, installation_identity, legacy_ai_tasks, project_members,
project_memories, projects, schema_migrations, system_preferences, task_attempts, task_checkpoints,
task_events, task_observations, task_plans, task_steps, tasks, thread_messages, threads, tool_operations,
user_app_install_state, user_installed_apps, user_preferences, user_wallpapers, worker_instances
```

## 5. OpenArc 现有表全量（64）

```
app_policy_provisions, app_principals, app_resource_grants, app_resource_grants_v21, audit_log,
authorization_audit, canvas_boards, canvas_commands, canvas_resource_nodes, canvas_runs, canvas_shares,
collections, content_objects, department_memberships, departments, device_access, device_audit,
device_credentials, device_pairing_credentials, devices, installations, library_resources, login_attempts,
mcp_connection_logs, mcp_connections, mcp_credentials, model_call_records, model_configs, model_credentials,
model_defaults, model_providers, project_members, project_resources, projects, resource_favorites,
resource_grants, resource_import_jobs, resource_index_jobs, resource_preview_cache, resource_recent,
resource_registry, resource_relations, resource_search_docs, resource_tags, resource_versions, sessions,
side_effect_calls, side_effect_leases, tags, task_artifacts, task_budgets, task_events, task_harness_runs,
task_model_calls, task_steps, task_tool_proposals, task_verifications, task_verifications_v15, tasks,
teams, tool_approvals, tool_decisions, tool_executions, users
```

## 6. NOT VERIFIED

- 5 张同名表的**字段级**差异（本轮未逐列比对）。
- OpenArc 与 DX OS 是否还有通过非 `CREATE TABLE` 字面语句创建的表（如动态 DDL、视图）。
