# D5-03 第二批 · 内置策略提供记录与 App Grant 跨组织唯一键

状态：**已实现并完成真机（Electron）验收** —— `experiments/d5-03/mcp-policy-e2e.mjs` 在真机跑出
**43 PASS / 0 FAIL / 43、exit 0**（2026-09-24；被测提交 `360d94b`；artifact `artifacts/d5-03/mcp-policy-e2e.json`，
sha256 `d4af5e9cbf6e7b8b6b8643f67d3dd38d040ee35baabb937fbeb338141c71d831`；该路径在 23:01:50 被本任务自己并行跑的批次重跑覆盖（原文曾记为“另一个并发 DSH 会话”，**【第三批订正】**），当前磁盘值 = `0c9ea8e5…`，判定一致 —— 两个值都记录在 `docs/D5-03-RESULT.md` §12 第 7 条），覆盖首用播种 / 撤权即时 /
跨登录 / 跨重启 / 正式重授 / 新组织 / v20 → v21 升级路径 / 撤销审计行归属 / `mcp.view`-only 部分授权。
两处"共库双组织的**行为级**场景"在真机不可构造，仍如实记为 notVerified（见 §5）；完整口径与判定见
`docs/D5-03-RESULT.md` 正文 §1–§13。

> **【第三批已更新 · 2026-09-28】** 本决策的 §1–§4（schema v21 设计、墓碑语义、跨组织唯一键、迁移归属判据）**内容未变、继续有效**；第三批（`1b78953` / `0aa4027`）只做了两件事：① 在同轮三门禁里重跑本台架 —— **43/43、exit 0**，artifact 改走 `artifacts/d5-03/runs/20260928T020348Z-fb87-mcp-policy-e2e/mcp-policy-e2e.json`（sha256 `df7891ef…`），根目录 `artifacts/d5-03/mcp-policy-e2e.json` 只作历史；② **R3 门禁重基线**（基线 `d583154` → `c2e96c1`，改白名单式：仅允许 `src/mcp/McpCenter.tsx`、只增不删、补丁必须含 `MCP_SESSION_ENDED`）、**H2 只补一次真实 `mcp/connect` 驱动**（判定与 `expected` 一字未动；44 个 `record` 调用点 id 序列一致），其余 42 条判定逐字未动 —— 详见 §7。`notVerified` 仍为 **2 条，未清零**（本批不新增"创建组织"入口，用户明令）。

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

### 4.1 撤销证据的 App 归属判据（第二批修复批次加固）

历史 `authorization_audit` 行的 `app_id` 在 v21 之前记的是**发起治理的上下文 App**
（`authorization-service.cjs` `#governanceGate` 的 `context.appId || 'resource-library'`），
不是被撤销授权所属的 App。直接拿它当归属会把墓碑补到错误的 App 上：被撤的那个 App 因此
判成"从未提供"，在下一次登录被重新种回来（真实缺陷 **D5-03B-D1**，真机 `L3` 复现）。
本批在两侧收口：

* **写入侧** `electron/authorization-service.cjs`：`#govAudit` 增加显式 `appId` 覆盖参数；
  App Grant 的**授予**传目标 App（请求里的 `appId`）、**撤销**传 `before.app_id`
  （resource 版与 tool 版走同一条 `revokeAppResourcePermission`），其余治理动作
  （部门 / 资源授权 / 注册 App / 状态）保持"上下文 App"缺省不变。
* **迁移侧** `electron/identity-store.cjs` `revokeTombstoneTargets`：历史行先用
  `old_permissions` 的命名空间反推家族（`mcp.*`→mcp、`model.*`→model、
  `resource.*`/`tool.*`→对应族），再按下面这张表判归属：

  | 情形 | 归属 |
  | --- | --- |
  | 审计行 `app_id` 是该族提供者，且该 App 当前没有该族 baseline 行 | 精确归到该 App |
  | `app_id` 不是该族提供者（旧缺陷的典型形状），或该 App 的 baseline 行还在（撤销不是针对它） | 给该族**全部**现存提供者补墓碑 |
  | 该族没有登记提供者（tool 族），或候选全被排除 | 退回审计行的 `app_id`，不扩面 |

  家族 → 提供者表 `BASELINE_POLICY_PROVIDERS` 与三处播种点对齐：resource →
  `resource-service.cjs` `BUILTIN_APP_BASELINE` 的全部 App；model → `model-bootstrap.cjs`
  `seedModelAppPolicy` 的四个 App；mcp → `mcp-bootstrap.cjs` `HOST_APP_ID`；
  tool → 没有播种点（工具授权一律显式），空表。

方向仍然保守：不能唯一确定目标 App 时**宁可多补墓碑**（把"从未提供"误判成"已撤销"，
代价是该 App 的 baseline 不再补种、需治理侧正式重授），也绝不漏补（把"已撤销"判成
"未提供" = 已撤权限复活）。残余不确定性如实记录：

* 同一族有多个提供者（model 4 个、resource 10 个）而审计行 `app_id` 又恰好是该族提供者时，
  "精确归属"仍可能记错 App：真实目标漏补 → 复活。窗口只覆盖 v21 之前写下的历史行，
  写入侧修复后不再产生这类行；
* `BASELINE_POLICY_PROVIDERS` 是**手工对齐**的：新增 baseline 提供者若忘了同步，
  该 App 的历史撤销会退回"只认审计行 `app_id`"的旧口径；
* 撤销发生在审计表没有留下对应行的路径上：见上一节的残留清单。

**真机实测（2026-09-24，`mcp-policy-e2e` 的 J2 / J1 / L1–L3）**：修复后 4 条撤销审计行的 `app_id`
**全部 = `mcp-center`**（修复前是 `resource-library`），`old_permissions` / `new_permissions` 如实；
`L1` 用 `git archive 140182f` 的 v20 代码跑旧服务建库并真实撤销一次（不写一行 SQL），产出的历史行仍是旧
口径（`app_id=resource-library`）；`L2` 升级到 v21 后既有授权行 **4 → 4 一条不丢**、`user_version=21`、
唯一键含 `organization_id`；`L3` 迁移把该撤销证据归到 `(organization_id,'mcp-center','mcp')` 的墓碑
（`revoked_at` 非空、`provisioned_at` 空 = "有撤销证据、无提供证据"），升级后登录不再复活。

## 5. 未闭合项

* 真机（Electron）验收：**已完成**（`experiments/d5-03/mcp-policy-e2e.mjs`，**43/43、exit 0**；8 个真实
  Electron 实例：首用 / 跨重启 / 重授后重启 / 再撤销重启 / 新组织 ×2 / 回第一组织 / v20 升级库）。
  `mcp.view`-only 部分授权同为真机实测：`toolsHidden=true`、`tools=[]`、`hash=null`，但连接状态可见，
  工具名 / 描述 / 参数 / hash 在 DOM + `mcp/get` + `mcp/testLog` 三面 0 命中，`connect` / `test` 被拒，
  再授 `mcp.use` 立即可见。
  **仍未闭合**：同一库内两个组织的**行为级**互不覆盖在真机不可构造（单 root 团队约束 + 无创建组织入口），
  只验到 schema 级（`G1`：唯一键 / 主键含 `organization_id`）与 node 层行为级
  （`tests/authorization-app-grant-scope.test.mjs` 6/6、`tests/d5-03-mcp-policy-persistence.test.mjs` 11/11：
  不同 `organization_id` 各一行、两种写入顺序同结论）—— 如实记在 artifact 的 `notVerified`（2 条）。
* 证据完整性缺口（与本文件描述的修复无关，如实登记）：第一批台架 `mcp-center-e2e` 的源码指纹集**不含**
  本批改动的 `electron/authorization-service.cjs` 与 `electron/identity-store.cjs`；第二批台架的
  `fingerprints`（7 条，与 HEAD 逐条相同）覆盖了它们，两个台架合起来才可复核本批受验源码。见
  `docs/D5-03-RESULT.md` 正文 §12。**【第三批已更新：该缺口已闭环 —— 第三批把源码指纹集扩为 14 条（product 源码 12 条，含 `authorization-service.cjs` / `identity-store.cjs` / `governance-service.cjs` / `authorization-store.cjs` / `executor-launcher.cjs` / `src/mcp/McpCenter.tsx`），三个 artifact 里产品源码全部 `inTestedCommit=true` / `worktreeMatchesCommit=true`；center 与 policy 的指纹集整体 sha256 同为 `0b435692…`。】**
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

## 7. 第三批更新（2026-09-28，`1b78953` / `0aa4027`）

* **判定不变**：本台架（`experiments/d5-03/mcp-policy-e2e.mjs`）第三批同轮重跑 **43 PASS / 0 FAIL / 43、exit 0**；内嵌第一批回归 **38/38**；`notVerified` 仍 **2 条**（同一安装内第二个组织无产品入口 + 跨组织行为级），**未清零** —— 本批不新增"创建组织"入口（用户明令）。
* **证据路径换代**：第三批起每次运行独立写 `artifacts/d5-03/runs/<runId>/mcp-policy-e2e.json`（+ 日志 + `.sha256` + 截图），索引只追加（`runs/index.json` / `index.jsonl`）；**根目录不再写入可变 JSON**。**当前有效证据以本轮 runId 目录为准，历史轮次只作历史。**本轮 runId `20260928T020348Z-fb87-mcp-policy-e2e`、artifact sha256 `df7891ef72abcb02fe057654d1132633f64bbdfae9c83a7393bd342fb9dc2a5b`；根目录 `artifacts/d5-03/mcp-policy-e2e.json`（mtime 2026-09-24）只作历史。
* **R3 门禁重基线（白名单式，判定更严不是放宽）**：基线由 `d583154` 改为 `c2e96c1`；仅允许 `src/mcp/McpCenter.tsx`；只增不删（`numstat=8\t0`）；补丁必须含 `MCP_SESSION_ENDED`；白名单外任何 `src/` 改动 FAIL；`git` 拿不到 diff 时 fail-closed。实测 `srcDiffOutsideWhitelist=[]`、`srcWhitelistAddOnly=true`、`kFailures=[]`、`kAllCascade=true`。原因：第三批在 `1b78953` 为"会话已结束"提示合法改了渲染层 8 行（`src/mcp/McpCenter.tsx`），旧基线"src/ 零改动"已过期。
* **H2 只补驱动、不动判定**：重授四动作后补一次真实 `mcp/connect` 前置（先连回 `READY`，再收窄 `view-only`；`H1` 是 grant 收窄不是 revoke，按第三批契约不收流），**H2 判定与 `expected` 一字未动**；全文件 44 个 `record` 调用点 id 序列与基线 `c2e96c1` 逐条一致（执行岗 `diff` 复核）。其余 **42 条判定逐字未动**。
* **脚本指纹口径**：`mcp-policy-e2e.mjs` 在三份 artifact 里都标 `worktreeMatchesCommit=false` / `status="modified"` —— 这是"重基线当时未提交"的诚实自报；sha256_16 `56b9ba59ee896864`（全量 `56b9ba59ee896864f2922785749eda9bc525a765ba7f3088de116b2e04e798af`）与提交 `0aa4027` 当前内容逐字节相同。
* **归因订正（第三批）**：第二批文档里"另一个并发 DSH 会话重跑覆盖本 artifact"的说法已订正 —— 那是**本任务自己并行跑的批次**；第三批的机制性修复 = 独立 runId 目录 + `acquirePort` 独占探测 CDP 端口 + 只清理自己的 pid 树 + Electron 批次串行执行（见 `docs/D5-03-RESULT.md` 正文 §3/§10）。
* 本决策文档描述的 schema v21 / 墓碑 / 唯一键 / 迁移归属实现**本批未改动**（第三批 `src/` 只动了 `src/mcp/McpCenter.tsx` 的一行文案类说明）。

