# D5-03 第二批 · 内置策略提供记录与 App Grant 跨组织唯一键

状态：已实现（node 层验收通过）；真机（Electron）验收留给下一批。

## 1. 要修的两个真实缺陷

1. **撤销不持久**：会话事件里无条件重 upsert 内置 App baseline（`seedModelAppPolicy` /
   `seedMcpAppPolicy` / `ResourceService#ensureBuiltinPolicy`），而治理撤销是**删行**
   （`revokeAppGrant` → `DELETE`）—— 撤销后下一次登录 / 应用重启就被种回来。
   resource 那一路的守卫还是**内存 Set**（重启即失效）。
2. **跨组织互相覆盖**：`app_resource_grants` 的唯一键不含 `organization_id`，而 upsert 的
   `ON CONFLICT` 又固定写 `organization_id = excluded.organization_id` —— 两个组织对同一
   `(app, resource_type, scope)` 的授权互相覆盖，谁后写谁赢。

## 2. 设计：把"是否已提供"变成持久事实（schema v21）

```sql
CREATE TABLE app_policy_provisions (
  organization_id TEXT NOT NULL,
  app_id          TEXT NOT NULL,
  policy_key      TEXT NOT NULL CHECK (policy_key IN ('resource','model','mcp','tool')),
  provisioned_at  INTEGER,   -- NULL = 没有"曾提供"的证据
  provisioned_by  TEXT,
  revoked_at      INTEGER,   -- NULL = 未撤销
  revoked_by      TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (organization_id, app_id, policy_key)
);
```

* 键是 `(organization_id, app_id, policy_key)`：`policy_key` 是 **baseline 家族名**而不是单条
  grant —— 一族 baseline 可能写多行（例如 resource-library 的全局行 + memory 行），同生同灭。
* 播种语义：**没有记录 ⇒ 首次使用才给 + 记 provisioned；有记录 ⇒ 无论是否撤销都不再 upsert**。
  新组织第一次使用仍然拿到既定初始授权（没有记录）。
* 墓碑与清标记只有一处实现（`AuthorizationStore.upsertAppGrant` / `revokeAppGrant`），
  而不是散在各治理入口：这样 model-service 的测试用入口、未来的新入口都不会漏。

### baseline 形状（写墓碑 / 记已提供只认它）

`resource_id` / `collection_id` / `department_id` 全空，且

* `scope = ''` → `resource_type` `''` / `model` / `mcp` 各归各族；
* `scope = 'TOOL'` → `resource_type = 'tool'` 归 tool 族（tool 授权只走 scope=TOOL 专用入口）。

非 baseline 形状（针对具体 resource / collection / department、`memory` / `image` 这类资源类型
定向行）撤销**不写墓碑**，也不影响该族记录。

`scope = 'ORGANIZATION'` 这类**同族但非基线字样**的正式授予：清墓碑（正式重授 = 恢复），
但不写 `provisioned_*`、也不创建记录 —— 避免一次定向授权挡住该族以后的首次播种。

## 3. 跨组织唯一键迁移

SQLite 改不了表约束，按 v17/v18 的既有做法重建：`CREATE TABLE IF NOT EXISTS app_resource_grants_v21`
→ 逐行 `INSERT ... SELECT`（id 与全部字段原样保留）→ `DROP` 旧表 → `RENAME` → 补 `idx_agrants_app`。
新唯一键：`UNIQUE (organization_id, app_id, resource_id, collection_id, resource_type, department_id, scope)`；
`upsertAppGrant` 的 `ON CONFLICT` 与按键查询同步带上 `organization_id`。
新增 `app_policy_provisions`。整级在一个事务里，全部 `IF NOT EXISTS` / `DELETE + 重填`，可重放。

## 4. 迁移的诚实边界（无法判定的历史情形）

v21 升级时**无法**从"行不存在"区分"从未播种"与"曾经撤销"。已用可恢复证据尽量补：

1. 现存 baseline 形状的 grant 行 ⇒ `provisioned_at = 最早一行 created_at`（当前有效，未撤销）；
2. `authorization_audit` 里 `action = governance.revokeAppPermission`、`resource_ref` 与
   `department_id` 均为空的历史行 ⇒ `revoked_at = 撤销时刻`（已有证据 ① 时不覆盖）。

无法判定、因而**宁可不补**的情形（这些情形下一次使用仍会补种，属已知残留）：

* 撤销发生在审计表没有留下对应行的路径上（审计写入失败被 `auditAuthorization` 吞掉、
  或直接改库的历史操作）；
* 审计行里的撤销者已被删除 / 查不到 team，无法确定组织；
* 审计表没有 `organization_id`，只能用 `actor_user_id → users.team_id` 反推
  （撤销本身被 `before.organization_id === gate.user.team_id` 约束，故该映射成立）；
* 审计只记 `resource_ref` / `department_id`，**collection 定向行**的撤销与 baseline 撤销同形
  —— 可能把"从未提供"误标成"已撤销"。这是保守方向（绝不复活已撤权限），代价是该 App 的
  baseline 不再补种，需要治理侧正式重授。

## 5. 未闭合项

* 真机（Electron）验收：本批只做 node 层；主进程装配路径同一条已在 `createIdentityService`
  上跑到（登录 → 撤销 → 重启 → 再登录）。
* `ModelService.revokeAppModelAccess` / `grantAppModelAccess` 只被测试夹具使用（无 IPC 入口），
  现已随 store 收口自动写/清墓碑；正式入口仍是 `governance/grantAppAccess|revokeAppAccess`。
* MCP 工具调用仍未开放（5 个入口仍回 `MCP_TOOL_INVOCATION_NOT_ENABLED`），本批不改这条边界。
* `app_policy_provisions` 目前没有保留期/清理策略（记录随组织与 App 数增长，量级很小）。

## 6. 相关代码

* `electron/identity-store.cjs`：v21 DDL、形状判据、证据补写、唯一键重建；
* `electron/authorization-store.cjs`：提供记录读写、upsert/revoke 的墓碑与清标记；
* `electron/authorization-service.cjs`：`resourceType='mcp'` 的 namespace 分派；
* `electron/mcp-bootstrap.cjs`、`electron/model-bootstrap.cjs`、`electron/resource-service.cjs`：
  三处播种改为"首次使用才给"；
* `electron/mcp-service.cjs`：工具目录（名/描述/参数/hash）一律要 `mcp.use`。
