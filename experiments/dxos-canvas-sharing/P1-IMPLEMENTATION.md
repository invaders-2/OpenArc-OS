# 画布三档共享 · P1 后端实现回执

> 版本：2026-10-17 · 基线 HEAD `9e43b8d` + 工作树未提交改动
> 范围：只改后端（`electron/canvas-*`、`identity-store` 迁移、`authorization-store` strict），
> 不动 `public/novai-canvas/**`、`src/**`、`src-vue/**`（UI 属 P2）。
> 产品决定以用户拍板为准：**三档角色 + 按人授权 + 私有/组织内可见**；ORGANIZATION = 只读底线。

---

## 1. 最终角色模型

| 档位 | 存储值 | 动作集合 | 说明 |
|---|---|---|---|
| 查看者 | `VIEWER` | `PERMISSION_SET.VIEWER` | 只读 |
| 编辑者 | `EDITOR`（旧 `CONTRIBUTOR` 读时归一） | `PERMISSION_SET.CONTRIBUTOR` | 读/改/保存/命令/撤销/运行 AI；**不是** `EDITOR_ACTIONS`（不含 delete/restore/share） |
| 管理共享 | `MANAGER` | `CANVAS_MANAGER_ACTIONS` = CONTRIBUTOR + `resource.share` + `resource.manageAccess` | 可改成员/角色/可见性；**不含** `resource.delete`/`restore`/`permanentDelete`，不能转移所有者 |
| 所有者 | `canvas_boards.owner_user_id` | `OWNER_ACTIONS` | 全部能力 |
| 超管 | `users.role='ADMIN'` | `OWNER_ACTIONS`（`SUPER_ADMIN`） | 可按 id 管理任意画布；列表仍只列 owned/shared/org |
| 组织可见（未共享） | 无 share 行 | `PERMISSION_SET.VIEWER`（`ORG_POLICY`） | 只读底线 |

角色优先级：`VIEWER(1) < EDITOR(2) < MANAGER(3) < OWNER(4)`（`canvas-domain.cjs:270`）。
判定顺序（`canvas-domain.cjs:315-335`）：

```
NOT_FOUND → SUPER_ADMIN → OWNER_POLICY → SHARE_<role> → ORG_POLICY → NO_GRANT
```

显式 share 先于 ORGANIZATION，所以组织可见**不会**把 EDITOR/MANAGER 降级。
share 分支额外要求 `board.organization_id === actor.organizationId`：历史跨组织脏行不能当读取后门。

### 1.1 权限矩阵（最终版）

| 主体 | 打开/读 | 编辑/保存/命令 | 运行 AI | 看成员列表 | 改共享/角色/移除 | 改可见性 | 转移所有者 | 回收站 | 永久删除 |
|---|---|---|---|---|---|---|---|---|---|
| 所有者 | 是 | 是 | 是 | 是（完整） | 是 | 是 | 是 | 是 | 是 |
| 超管 | 是（按 id） | 是 | 是 | 是（完整） | 是 | 是 | 是 | 是 | 是 |
| MANAGER | 是 | 是 | 是 | 是（完整） | 是 | 是 | **否** | **否** | **否** |
| EDITOR | 是 | 是 | 是 | 否（只给人数+自己的角色） | 否 | 否 | 否 | 否 | 否 |
| VIEWER | 是 | 否 | 否 | 否（只给人数+自己的角色） | 否 | 否 | 否 | 否 | 否 |
| 组织成员（ORGANIZATION） | 是 | 否 | 否 | 否（只给人数+自己的角色） | 否 | 否 | 否 | 否 | 否 |
| 同组织私有未共享 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 |
| 外组织/停用/未登录 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 |

能力投影（`canvas/access/get`）：`canView/canEdit/canManage/canShare/canTrash/canRestore/canPurge`，
全部由同一份 actions 推导；`canManage = resource.manageAccess`，`canShare = resource.share`。

> 说明：`restoreCanvas` 仍沿用既有“canEdit 即可恢复”，未收紧为 canRestore（避免扩大行为变化）；
> MANAGER/EDITOR 可恢复被删画布，但都不能删除/永久删除。

---

## 2. 命令契约（唯一 `canvas:command` envelope）

所有命令：身份只来自主进程 session；payload 里的 `userId/owner/sessionRef` 一律忽略；
成功返回 `{ok:true,...}`，失败 `{ok:false,error,detail}`；写命令的审计与业务写入同一事务。

### 2.1 `canvas/share`（upsert）

- payload：`{ canvasId, userId, role }`；`role ∈ VIEWER|EDITOR|MANAGER`（`CONTRIBUTOR` 归一 EDITOR）
- 返回：`{ ok, changed:"CREATED"|"UPDATED", share, shares }`
- 调用者：`canManage`（owner / 超管 / MANAGER）
- 校验：目标必须存在、`status=ACTIVE`、与画布同组织、且不是 owner；空 userId 不再退化成“返回列表”
- 错误：`NOT_FOUND` / `NOT_FOUND_OR_FORBIDDEN` / `READ_ONLY`(detail=access.source) /
  `INVALID_INPUT`(detail=`role|target|target-disabled|target-org|owner`) / `INTERNAL_ERROR`(detail=`audit`)
- 审计：新共享 `canvas.share.grant`（old `[]` → new `[role]`）；已存在 `canvas.share.update`（old→new）

### 2.2 `canvas/share/update`（独立改角色）

- payload：`{ canvasId, userId, role }`
- 返回：`{ ok, changed:true, share, shares }`
- 调用者/校验：同 `canvas/share`，且目标必须已有 share 行（否则 `NOT_FOUND detail="share"`）
- 审计：`canvas.share.update`，old `[旧角色]` → new `[新角色]`
- 不允许改 owner 的角色（`INVALID_INPUT detail="owner"`）

### 2.3 `canvas/share/remove`（幂等）

- payload：`{ canvasId, userId }`
- 返回：`{ ok, removed:boolean, shares }`
- 调用者：`canManage`；不能移除 owner（`INVALID_INPUT detail="owner"`）
- 目标本来没有 share：`ok:true, removed:false`，**不写审计**（避免噪声）
- 成功：`canvas.share.revoke`，old `[旧角色]` → new `[]`

### 2.4 `canvas/shares`（成员列表）

- payload：`{ canvasId }`；调用者：`canView`
- 有管理权：`{ ok, canvasId, visibility, owner{userId,displayName,username,status}, shares[ShareView], shareCount, canManage:true, access{allow,actions,source} }`
- 无管理权：`{ ok, canvasId, visibility, owner, shares:null, shareCount, myRole, canManage:false, access }`
  —— **不返回其他成员 ID/显示名**
- `ShareView = { userId, displayName, username, role, grantedBy, grantedByName, createdAt, at, status:ACTIVE|DISABLED|MISSING }`
- 错误：`NOT_FOUND_OR_FORBIDDEN`

### 2.5 `canvas/share/candidates`

- payload：`{ canvasId, query?, limit? }`（limit 1..50，默认 20；query 匹配 display_name/identifier）
- 调用者：`canManage`；否则 `READ_ONLY`
- 返回：`{ ok, items:[{userId,displayName,username,status}] }`
- 只返回同组织 `ACTIVE`、排除 owner 与已在 `canvas_shares` 的账号；无审计（只读）

### 2.6 `canvas/access/get`

- payload：`{ canvasId }`；调用者：`canView`
- 返回：`{ ok, canvasId, visibility, owner, share:{role}|null, access:{allow,actions,source}, capabilities:{canView,canEdit,canManage,canShare,canTrash,canRestore,canPurge} }`
- 不给成员列表；无审计

### 2.7 `canvas/visibility`（保留命令名）

- payload：`{ canvasId, visibility:'PRIVATE'|'ORGANIZATION' }`（大小写归一）
- 调用者：`canManage`
- 非法值：`INVALID_INPUT detail="visibility"`（**不再静默变 PRIVATE**）
- **不更新 updated_at / revision**（避免宿主 `base_updated_at→revision` 基线冲突）
- 同值：`ok:true, changed:false`，不写审计
- 审计：`canvas.visibility.set`，old `[旧值]` → new `[新值]`

### 2.8 `canvas/owner/transfer`

- payload：`{ canvasId, newOwnerUserId }`
- 调用者：**仅当前 owner 或超管**（MANAGER 不行）
- 目标：存在、ACTIVE、同组织、不是当前 owner
- 单事务：`UPDATE canvas_boards.owner_user_id`（不动 updated_at/revision）→ 删目标原 share →
  旧 owner upsert 为 `EDITOR` → 审计两行
- 审计：`canvas.owner.revoke`（旧 owner，`["OWNER"]`→`["EDITOR"]`）、
  `canvas.owner.grant`（新 owner，`[目标原角色或 []]`→`["OWNER"]`）
- 并发：事务内重读 owner，已变化 → `READ_ONLY detail="owner-changed"`，不覆盖别人的转移
- 返回：`{ ok, canvas, shares }`

### 2.9 既有命令的变化

- `canvas/get` / `canvas/meta`：`access` 增加 `canManage/canShare`；meta 增加 `visibility`；
  **`access.canEdit` 语义不变**（只由 `resource.edit` 决定）。
- `canvas/list`：`shareRole` 归一（`CONTRIBUTOR→EDITOR`），`access.canEdit` 不变。
- `canvas/purge`：同事务清 `canvas_shares` / `canvas_commands` / `canvas_runs` / `canvas_run_facts`，再删 board。

### 2.10 错误码表

| 错误 | detail | 含义 |
|---|---|---|
| `NOT_FOUND` | — | 画布不存在/已永久删除/已进回收站（写命令） |
| `NOT_FOUND_OR_FORBIDDEN` | — | 当前用户看不到（撤销共享后立即如此） |
| `READ_ONLY` | `access.source` / `owner-changed` | 没有该动作权限 |
| `INVALID_INPUT` | `role` / `target` / `target-disabled` / `target-org` / `owner` / `visibility` / `share` | 输入或目标不合法 |
| `INTERNAL_ERROR` | `audit` | strict 审计失败，事务已回滚 |
| `CANVAS_COMMAND_NOT_ALLOWED` | 命令名 | 未登记白名单 |

---

## 3. 审计（`authorization_audit`）

公共字段：`app_id="canvas"`、`resource_ref="canvas:"+canvasId`、`actor_user_id=当前用户`、
`target_user_id=被授权/移除/新 owner`、`request_id=context.requestId`、
`permission_source=access.source`（`OWNER_POLICY/SUPER_ADMIN/SHARE_MANAGER`）。

| 操作 | action | old_permissions | new_permissions |
|---|---|---|---|
| 新增共享 | `canvas.share.grant` | `[]` | `["VIEWER"|"EDITOR"|"MANAGER"]` |
| 改角色 / 重复 upsert | `canvas.share.update` | `["旧角色"]` | `["新角色"]` |
| 移除共享 | `canvas.share.revoke` | `["旧角色"]` | `[]` |
| 改可见性 | `canvas.visibility.set` | `["PRIVATE"|"ORGANIZATION"]` | `["新值"]` |
| 转移：旧 owner | `canvas.owner.revoke` | `["OWNER"]` | `["EDITOR"]` |
| 转移：新 owner | `canvas.owner.grant` | `[目标原角色]` 或 `[]` | `["OWNER"]` |
| 被拒绝的写尝试 | 对应 action | — | —（`decision="DENY"`, `reason_code=错误码`） |

- 成功写入：`auditAuthorization({ strict:true })` 与业务写入在同一个 `store.transactSync`；
  审计插入失败 → 抛错 → 事务回滚 → 返回 `INTERNAL_ERROR detail="audit"`。
- 被拒绝的写尝试：`DENY` 为 best-effort 留痕，不改变拒绝结果（不会把 `READ_ONLY` 变成 `INTERNAL_ERROR`）。
- 只读命令（shares/access/candidates/log/get/meta/list）不写审计。

---

## 4. 三个 bug 的修复证据

### bug 1 · 组织可见把显式 EDITOR 降级

- 修复：`canvas-domain.cjs:315-335` 调整为 share 先于 ORG；share 分支按 `normalizeShareRole` 取档。
- 探针（`probe-output.txt`）：
  `PASS bug1 组织可见不把显式 EDITOR 降级 :: source="SHARE_EDITOR", canEdit=true`
  `PASS bug1 组织内未共享成员仍是只读 ORG_POLICY`
- 测试：`tests/dxos-canvas-sharing.test.mjs` 第 2 条（ORG+EDITOR / ORG+VIEWER / ORG+MANAGER / 跨组织脏行）。

### bug 2 · 共享目标不校验（跨组织/不存在）

- 修复：`canvas-service.cjs:256-267` 的 `#validateShareTarget`（存在 / ACTIVE / 同组织 / 非 owner），
  share 与 update 共用；读取侧 `evaluateCanvasAccess` 的 share 分支要求同组织（脏行兜底）。
- 探针：
  `PASS bug2 不存在用户被拒 :: INVALID_INPUT/target`
  `PASS bug2 外组织成员被拒 :: INVALID_INPUT/target-org`
  `PASS bug2 外组织成员打不开也列不到 :: NOT_FOUND_OR_FORBIDDEN`
- 测试：第 3 条（含停用用户 `target-disabled`、owner 自己、空 target、非法 role、DENY 审计）。

### bug 3（后端部分）· 撤销/降级后不刷新权限

- 前端刷新属 P2；后端保证**下一次写就拒绝**并给明确错误码：
  - 降级 EDITOR→VIEWER：保存 `READ_ONLY detail="SHARE_VIEWER"`
  - 移除共享：保存/打开 `NOT_FOUND_OR_FORBIDDEN`，列表立即消失
- 探针：`PASS bug3 降级为 VIEWER 后立即 READ_ONLY`、`PASS bug3 撤销共享后立即 NOT_FOUND_OR_FORBIDDEN`
- 测试：第 4 条（含 meta 的 `access.canEdit=false`、幂等移除不重复写审计）。

---

## 5. 数据一致性与迁移

### 5.1 `canvas_shares` 新形态

```sql
canvas_id  TEXT NOT NULL REFERENCES canvas_boards(id) ON DELETE CASCADE
user_id    TEXT NOT NULL
role       TEXT NOT NULL CHECK (role IN ('VIEWER','CONTRIBUTOR','EDITOR','MANAGER'))
granted_by TEXT
at         INTEGER NOT NULL              -- 最近变更时间
created_at INTEGER NOT NULL DEFAULT 0    -- 加入时间（迁移回填 = at）
PRIMARY KEY (canvas_id, user_id)
```

新增索引：
`idx_canvas_shares_user(user_id)`（保留）与 `idx_canvas_boards_org_visibility(organization_id, visibility)`。

### 5.2 迁移方式（**重要偏差，需知悉**）

实现为 `identity-store.cjs:1642` 的显式函数 `applyCanvasSharingRolesLayer(db)`，
由 `canvas-store.cjs:92` 在 `CanvasStore` 构造时于 `identity.transactSync` 内调用。

**为什么不占用 v29 / 不进 `MIGRATIONS` 阶梯**：

1. `v28` 已被 `model_providers.allow_insecure_http` 占用；
2. `v29` 已被在途的任务表合并包按**显式迁移**占用（`electron/task-merge-migration.cjs:TASK_MERGE_VERSION=29`，
   `tests/migration-task-merge.test.mjs`），且该包明确要求“生产 SCHEMA_VERSION 仍是 28”；
3. 全仓约 18 个测试/夹具冻结了 `SCHEMA_VERSION===28`（`tests/migration.test.mjs`、`tests/identity-store.test.mjs` 等），
   本包不应为画布共享去改其他包的版本契约。

因此沿用**既有先例**：`canvas_run_facts` 同样是 `CanvasStore` 构造时幂等建表、“不依赖 identity-store 的新迁移级”。
迁移仍是显式的、可重复执行、失败可回滚：

- 先查 `PRAGMA table_info` 与 `sqlite_master.sql`；已有 `created_at` 且 CHECK 含 `MANAGER` → 空跑；
- 建 `canvas_shares_next` 新表 → 搬行（`created_at = COALESCE(at,0)`，已有列则保留）→ 删旧表 → 改名 → 补索引；
- 先清 `canvas_id` 不在 `canvas_boards` 的孤儿行（它们本来就不可访问），避免 FK 插入失败；
- 整个函数在 `transactSync` 内，任何一步抛错整级回滚，不会留下半张表。

> 若 Lead 要求进阶梯：把该函数作为 `{version:29,run:...}` 加入 `MIGRATIONS`，并同步更新上述 18 处
> 版本冻结断言与任务合并包的版本目标（需与那个包协调）。本次按“不破坏既有”优先。

### 5.3 幂等与失败回滚证据

测试 `tests/dxos-canvas-sharing.test.mjs` 第 14/15 条 + `artifacts/dxos-canvas-sharing/migration-evidence.txt`：

- 隔离临时 userData 建 v28 库 → 倒回旧 `canvas_shares`（无 created_at / 无 FK / CHECK 只到 EDITOR）→ 灌入
  `VIEWER/EDITOR/CONTRIBUTOR` 三行；
- 构造 `CanvasStore` 后：列含 `created_at`、CHECK 含 `MANAGER`、FK `canvas_boards(id) ON DELETE CASCADE`、
  索引两枚、3 行不丢、`created_at` = 原 `at`、可插入 `MANAGER`；
- 再构造一次 `CanvasStore`：行数/角色/时间戳不变（空跑）；
- 失败回滚用例：把 `canvas_boards` 改名让迁移在第一步抛错 → 旧表与 2 行原样保留、无 `canvas_shares_next` 半成品；
  恢复父表后重试成功，孤儿行被清掉。
- `PRAGMA user_version` 始终保持 28（画布层迁移不抢版本号）。

### 5.4 孤儿清理

- `canvas_shares` 加 `ON DELETE CASCADE`：任何直接 `DELETE FROM canvas_boards`（包括
  `integration-store.deleteBoard`）都不再留孤儿共享行；
- `purgeCanvas` 仍显式清共享/命令/运行（对老库或未迁移库同样成立）；
- 迁移时清一次历史孤儿共享行。

---

## 6. 验证数字（真实执行）

| 检查 | 结果 |
|---|---|
| `node --test tests/dxos-canvas-sharing.test.mjs` | 15/15 通过 |
| `node --test tests/dxos-canvas-*.test.mjs tests/canvas-library-list.test.mjs tests/dxos-governance-*.test.mjs` | 198/198 通过 |
| 全部 canvas 相关（`*canvas*.test.mjs` + `d5-02-canvas-*`） | 273/273 通过 |
| schema/迁移批（migration/identity-store/device/dxos-foundation/061/agent/media/app-grant） | 88/88 通过 |
| task-merge/task-store/side-effect/tool/reset/session 批 | 49/49 通过 |
| `node experiments/dxos-canvas-sharing/probe.mjs` | 20 项 PASS，0 FAIL；exit 0 |
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | exit 0（vite 构建成功） |

原始输出：`artifacts/dxos-canvas-sharing/probe-output.txt`、`test-sharing.txt`、`test-regression.txt`、
`migration-evidence.txt`。

---

## 7. 改动清单（文件 · 关键行）

| 文件 | 改动 |
|---|---|
| `electron/canvas-domain.cjs` | 新增 `SHARE_ROLES/ROLE_RANK/CANVAS_MANAGER_ACTIONS/normalizeShareRole/actionsForShareRole`；重写 `evaluateCanvasAccess`（share 先于 ORG、同组织兜底）；新增 `canManage/canShare/canTrash/canRestore/canPurge`（:268-349） |
| `electron/canvas-store.cjs` | `setVisibility` 不再写 updated_at；新增 `updateOwner/deleteSharesOfCanvas/deleteCommandsOfCanvas/deleteRunsOfCanvas/usersOfTeam`；`upsertShare` 写 created_at；构造时执行共享迁移（:10、:29-39、:84-92、:130-150） |
| `electron/canvas-service.cjs` | 新构造参数 `authStore`；审计/能力/用户投影辅助（:137-267）；`purgeCanvas` 同事务清子表（:391）；`shareCanvas/updateShareRole/removeShare/listShares/shareCandidates/accessGet/setVisibility/transferOwner`（:414-661） |
| `electron/canvas-bootstrap.cjs` | 登记 5 个新命令；`createCanvasBundle` 接收 authStore；分发新命令（:29-36、:61-66、:105-122） |
| `electron/identity-store.cjs` | 新增 `CANVAS_SHARES_TARGET_SQL` 与 `applyCanvasSharingRolesLayer` 并导出（:1626-1665、:3137）；`SCHEMA_VERSION` 保持 28（:109） |
| `electron/authorization-store.cjs` | `auditAuthorization` 增加 `strict`（失败抛出，供事务回滚）（:545-600） |
| `electron/identity-bootstrap.cjs` | `createCanvasBundle` 传入同一个 `authStore`（:188-195，一行装配改动） |
| `tests/dxos-canvas-sharing.test.mjs` | 新增 15 条：矩阵/顺序/目标校验/撤销即拒/审计同事务/列表可见性/候选人/access/可见性/转移/purge+FK/列表语义/命令面/迁移幂等/迁移回滚 |
| `experiments/dxos-canvas-sharing/probe.mjs` | 改为对三 bug 的 PASS/FAIL 探针（含三档/审计/列表），失败非 0 退出 |
| `experiments/dxos-canvas-sharing/migrate-evidence.mjs` | 隔离 userData 的迁移真机取证脚本 |
| `experiments/dxos-canvas-sharing/P1-IMPLEMENTATION.md` | 本文件 |
| `artifacts/dxos-canvas-sharing/*` | 探针/测试/迁移原始输出 |

未改：`public/novai-canvas/**`、`src/**`、`src-vue/**`、`dist/**`（仅 `npm run build` 产物）、`electron/integration-*`。

---

## 8. 遗留与风险

1. **P2（前端）**：宿主需在 2.5s 轮询里比较 `access.canEdit/canManage/source`，变化时 `pushContext`；
   收到 `READ_ONLY`/`NOT_FOUND_OR_FORBIDDEN` 时关闭共享面板并提示。后端已给明确错误码，未改 UI。
2. **integration-service 同表风险**：`electron/integration-service.cjs` 的 `CanvasService` 仍只认 owner/超管
   （不识别 `canvas_shares`），其 `resource/listBoards` 等命令仍在白名单；它的 React UI 未挂载。
   - 最小防护：`canvas_shares` 的 FK `ON DELETE CASCADE` 已覆盖它直接 `deleteBoard` 的孤儿共享行；
   - 仍遗留：它直接删 board 不会清 `canvas_commands/canvas_runs/canvas_run_facts`（既有问题，未扩大改动）；
   - 建议后续把 `resource/*Board*` 从白名单移除或改走文档服务（DESIGN §6.5）。
3. **恢复语义**：`restoreCanvas` 仍允许 EDITOR/MANAGER（既有行为），未收紧为 canRestore；如需收紧应单独决策。
4. **迁移版本号**：画布共享迁移不占 `user_version`（理由见 §5.2）。若要求进阶梯，需一次性更新约 18 处
   冻结断言并与任务合并包协调 v29。
5. **所有者转移并发**：无 revision 概念，靠事务内重读 owner 拒绝“owner-changed”；两个窗口同时转移时后到者被拒。
6. **本地库边界**：`identity.db` 不是 OS 级安全边界；共享是应用层权限，不能防本机直接读库。
7. **超管列表**：仍不列“全部私有画布”，避免超管变成默认可见所有人的私有内容。
