# D5-03 第四批 · 会话自然到期 → MCP 收流 与策略保留规则【第五批已更新：本文件为第四批决策**原文**，被第五批改写的口径就地加【第五批已更新】/【第五批订正】；第五批节见 §13】

状态：**已实现并完成真机（Electron）验收** —— 2026-09-28 **统一重跑（修复后 · 最终口径）**：6 个到期场景 + 3 个既有门禁串行全绿、exit 0；浅/深实机截图与第一批基准逐像素同尺寸、对比度实测达标；本批未新增动效。

* **当前有效证据 = 本轮统一重跑的 9 个 runId**（清单见 §1 / §10）。首轮（EXP-01 修复前，6 个 runId）与 1R 单场景复测（1 个 runId）**仅作历史对照**，不作为交付证据。
* 被测内容 = 提交 `7b75ea3`（分支 `integration/ui-core`）；artifact 里记的 `testedCommit=8cbf8df2` 是**提交前在工作树上跑**的取证口径，逐文件 sha256 冻结在汇总 JSON 的 `freezeSnapshot`（24 文件），逐条披露见 §1。未 push、未合并 main、未切分支。
* 真机报告：`experiments/d5-03/D5-03-BATCH4-EXPIRY-REPORT.md`；机器可读汇总：`experiments/d5-03/d5-03-batch4-expiry-summary.json`；tracked 证据：`docs/D5-03-GATE-EVIDENCE.json` 的 `batch4` 段。

## 1. 被测内容、提交链与证据口径披露

| 项 | 值 |
| --- | --- |
| 分支 | `integration/ui-core` |
| 交付提交（HEAD） | `7b75ea3`（24 文件；未 push、未合并 main、未切分支） |
| artifact 记录的 testedCommit | `8cbf8df2`（9 次真机运行的 artifact 原样记录；每次运行都是提交前的工作树） |
| 冻结快照 | `freezeSnapshot`：2026-09-28T04:33:00Z 工作树 24 个改动/未跟踪文件的逐文件 sha256 |
| 跑后复核 | 24 个文件里 **22 个一字未改**；只有 `experiments/d5-03/D5-03-BATCH4-EXPIRY-REPORT.md` 与 `experiments/d5-03/d5-03-batch4-expiry-summary.json` 因本轮报告更新而改写（属预期，报告文件本身是证据的一部分） |
| 提交与冻结的关系 | `7b75ea3` 的文件清单与冻结清单**逐条相同（24/24）**；其中 **22/24 的提交 blob sha256 与冻结值逐字节相同**，仅上述 2 个报告文件不同（它们在冻结之后写成最终文本） |

**口径结论（如实披露，不含糊）**：被测内容 = `7b75ea3` 的内容，即「冻结的 24 文件工作树状态 + 两个报告文件的最终文本」；**不写成「测试提交 = 7b75ea3」**，也不写成「测试在工作树上、与提交无关」。9 次 artifact 的 `testedCommit=8cbf8df2` 记录保持原样，作为「运行发生在提交前」的诚实痕迹。

提交链：

| 提交 | 内容 |
| --- | --- |
| `8cbf8df2` | 第三批结果与证据定稿（第四批真机运行发生在它之后的工作树上） |
| `7b75ea3` | **本批唯一提交（被测内容）**：会话自然到期收流 + 策略收口（防漂移 / 保留规则 / 临时目录归属） |

## 2. 决策一：到期判据只有一份 `sessionExpiry()`

背景：第三批登记的残留 —— 会话自然过期**只在命令层懒判定**，空闲到期不会触发收流，活连接要等下一次收尾动作才被收掉。

* `electron/identity-domain.cjs` 抽出共用判据 `sessionExpiry()`：`dueAt = min(expires_at, idle_expires_at)`、`reason = idle | absolute`；`evaluateSession` 与定时器走**同一份判据**，不可能各算各的。
* 懒判定（每条命令过 `validateSession`）与定时器（见 §3）共用它；对外错误码仍是 `SESSION_EXPIRED`，语义与第三批懒判定一致 —— **既有断言不翻码**。

## 3. 决策二：单一定时器做权威调度，触发时重读权威行过四道门

`electron/identity-service.cjs`：

* **单一定时器**（字段 `#expiryTimer`）+ 代次 `#expiryGen`；句柄 `unref()`（不阻止进程退出）；超长 horizon 分块（单次 `setTimeout` 上限 2^31−1）；全链路**无 `setInterval`**（源码扫描的唯一命中是注释里的「禁止 `setInterval`」）。
* 每条命令后按**持久层权威行**重排下一次到期（合法活动延长空闲期限时旧安排随之让位）。
* 触发时**重读权威行**，过四道门：
  1. 旧代次（已被后续重排取代）→ 什么都不做；
  2. 已被其它路径终结（登出 / 撤权 / 锁屏等）→ 什么都不做；
  3. 未到期（例如活动已把空闲期限推后）→ 只重排，不落终态；
  4. 真过期 → 落终态 + emit。
* `electron/identity-store.cjs` 新增**幂等** `expireSession(ref)`：`transact` 队列写权威终态（`revoked_reason = EXPIRED`），重复调用不产生第二条终态。

单测锁：`tests/identity-session-expiry.test.mjs`（12 例，含「在途定时器 ≤ 1」「已出队旧回调不得动新会话」的注入式夹具；该夹具自身用 `setInterval` 抛错 + `pending()` 计数来钉这两条）。

## 4. 决策三：新事件 `identity/session-expired` → 既有 MCP dispose 收流

* 新事件 `identity/session-expired`（payload：`reason` / `sessionId` / `sessionRef`）并入 `electron/mcp-bootstrap.cjs` 的 `MCP_SESSION_END_EVENTS`，接第三批既有的 dispose 路径：
  * 活连接与在途请求立刻收掉（服务端 `getSse.openStreams` 1→0、无自动重连）；
  * **不改写 `enabled`**（用户「启用」意图保留）；状态如实 `DISABLED + MCP_SESSION_ENDED`；
  * 连接日志 `detail = expired:idle | expired:absolute`；
  * **既有路径的 detail 一字未改**：登出 `logout`、锁屏 `user`、关应用 `app-quit`、撤权 `app-grant-revoked`。
* 渲染层订阅该事件，走**与登出同一条收敛**（`identityEventConvergence` 纯函数：清投影 + 置未认证）；没有第二条过期分支。

## 5. 决策四：登录页只显示规范那一句（EXP-01 修复）

* 真机缺陷 **EXP-01**：登录页把内部到期枚举拼进了用户可见文案 —— 实测 `登录状态已过期，请重新登录。（idle）`。
* 修法：事件订阅**不再把事件 `reason` 当 `detail` 传**（`src/identity/useIdentity.ts`：`absorb({ ok:false, error: intent.errorCode }, "unauthenticated")`）；**未**采用「给 `errorText` 加白名单」那条 —— 白名单只会放行域内/运维说法，登录页仍会出现内部词，且会连带改掉命令失败路径既有的括注行为，不是最小改动。
* 修复后实测文案：`登录状态已过期，请重新登录。`（旧 → 新原文见真机报告 §8.1）；新增断言 U5/U6（U1–U4 与期望值一行未改），先红后绿；事件 payload 的 `reason` 仍原样发出，运维口径不变。
* **本批只修「事件 reason 被当 detail 传」这一条根因**；`errorText` 仍是通用括注实现，命令失败路径的 detail（如 `idle-expiry`）照旧显示（见 §9）。

## 6. 决策五：短有效期双重开关（仅测试 / 运维）

* `createIdentityService({ sessionTtlMs, sessionIdleMs })` + 双重开关：`OPENARC_ALLOW_SESSION_TTL_OVERRIDE=1` **且** `OPENARC_SESSION_IDLE_MS` / `OPENARC_SESSION_TTL_MS` 为**十进制整数 ≥ 2000**。
* 非法值忽略留痕；生效时打印「默认值 → 生效值」；**默认路径不读这些变量**。产品默认：绝对 12h（43200000ms）/ 空闲 2h（7200000ms），下限 2000ms。
* **`SCHEMA_VERSION` 仍 21、连接状态仍 5 种（未新增第六态）** —— 与第三批定的「不新增状态」一致。

## 7. 决策六：`BASELINE_POLICY_PROVIDERS` 防漂移守卫（两道守卫 + 负向自证）

背景：表（`electron/identity-store.cjs` 的 `BASELINE_POLICY_PROVIDERS`）是**产品事实**；`revokeTombstoneTargets` 靠它决定给哪些 App 补撤销墓碑。表与实际播种点漂移的后果是「撤销判错 App / 撤销被下一次播种复活」。第二批登记的缺口「手工对齐、无漂移守卫」在本批闭环。

新增 `tests/policy-provider-drift.test.mjs`（T1–T6，实测 6/6）：

* **① 行为级（主）T1/T2**：走真实装配路径 `createIdentityService`（建库 → 注册管理员 → 登录 → 真实资源操作）触发全部内置策略播种，断言实际产生的 `(appId, policyKey)` 集合与表**逐项相等**（多一个、少一个都 FAIL）；再对「全部 App Principal × 全部策略键」穷举，断言表里没写的一个记录都不许有 —— 反向穷举**表外 = 0**。
  * 实测对数：**15 对 = resource 10 + model 4 + mcp 1**（tool 族声明为空、无落点）。
* **② 源码级（兜底）T3/T4，fail-closed**：扫描 `electron/**`，凡引用 `policyProvisionByKey` 的文件必须登记；当前登记的播种点 = `resource-service.cjs` / `model-bootstrap.cjs` / `mcp-bootstrap.cjs`，另登记规则拥有者 `authorization-store.cjs`（定义规则、本身不是播种点）。未登记的文件、登记文件里出现表外 appId / 表外 policyKey、锚点消失或文件读不到，一律 FAIL。
* **③ 负向自证 T5/T6**：把漂移注入**内存里的源码副本**（不碰产品文件），断言守卫确实报错 —— 表外 appId（resource / model 两族）、表里多写一个提供点、新增未登记播种点、锚点消失，各自都必须 FAIL。
* **结论：表没有漂移、未改表。**

## 8. 决策七：`app_policy_provisions` 保留规则与总经理裁定

产品口径（v21）：内置策略「首次使用才给，撤销后永不再给」。成立前提是**只要组织还在，撤权记录（`(organization_id, app_id, policy_key)` 行 + 其 `revoked_at` 墓碑）永远不被删除、不被改写**。

新增 `tests/app-policy-provisions-retention.test.mjs`（R1–R6，实测 6/6）：

| 用例 | 内容 |
| --- | --- |
| R1 | 撤销后反复重播种/重试（resource / model / mcp 三族）→ 墓碑逐字段不变、撤权不复活、恰好一行 |
| R2 | 其它组织操作（部门 / 集合 / 资源 / App 状态 / 定向授权与撤销 / 另一个组织播种 / 审计读取）→ 一条撤权记录都不许消失或被改写 |
| R3 | 应用重启（关库 → 重开 → 重放迁移链 → 重新登录 → 再播种）→ 墓碑跨重启保持（正是「原来重启后第一次资源操作会复活」那条路径） |
| R4 | 正式重授只清撤销标记：不删行、不重复建行、最早提供时刻 `provisioned_at` 保留；`clearPolicyRevoked` 对不存在的记录不得凭空造行 |
| R5 | `resetInstallation` 现状刻画 + 「组织整体消失」路径的安全不变量（判断证据，不改产品代码）【第五批已更新：该缺陷已修 —— R5 期望值随之从「残留 15 / 15、墓碑原样保留」改为 **0 / 0 / null**（本批唯一允许改期望值处，已逐字披露）。见 §13】 |
| R6 | 源码级守卫：除登记的组织删除路径外，`electron/**` 里任何 `app_policy_provisions` 行删除（`DELETE FROM` / `DROP TABLE` / `TRUNCATE` / cleanup 式语句）都 FAIL；正式重授的 SQL 只允许 `SET revoked_at, revoked_by, updated_at`【第五批已更新：守卫**收紧** —— 白名单从空数组改为**恰好一条**（安装重置），放行判据改为「文件 + 命中形态 + 去空白后逐字相等的完整语句」三者同时成立（取消 `includes` 模糊匹配），并新增永久负向自证 **R6b**。见 §13】 |

**总经理裁定（本批决策，写进本文件即生效）**：

* 产品**没有**「组织正式删除」入口，因此**本批不实现任何删除**，R6 的守卫白名单 `ALLOWED_ORG_DELETION_PATHS` **保持为空**（空 = 产品里没有合法删除路径，测试反而把它钉住）。【第五批已更新：白名单已从空数组改为**恰好一条**（安装重置 `identity/reset-installation`）；「不开放通用清理、不做整库扫删」的原则不变。见 §13】
* 规则：**组织仍存在时，撤权记录永不清理**；将来若新增「组织正式删除」入口，必须 **provisions + grants 同事务一并清**，并在守卫白名单登记（当前无此入口）。【第五批已更新：第五批正是按这条办的例外 —— 安装重置就是「组织整体消失」路径，四张授权事实表在**既有的那个 `transactSync`** 内先清、再删身份五表；登记项与回滚证据（T1a/T1b）见 §13】
* `resetInstallation` 现状残留：重置后 `app_policy_provisions` 留 **15 行**孤儿、`app_resource_grants` 留 **15 行**孤儿，都指向已从 `teams` 删除的组织。**判定为不可达、不致权限复活**：重置后重建得到**全新随机组织 id**，新组织拿到与重置前**完全相同的 15 对播种**（R5 实测），旧组织的授权行对所有授权判定都不可达（无任何用户属于旧组织），治理视图只看到新组织自己的行。【**第五批订正**：**该判定仅对 user 侧取数成立**（判定按 `organization_id = user.team_id` 过滤，`electron/authorization-domain.cjs:490`）；**对 App 侧取数不成立** —— `electron/authorization-store.cjs:80` 的 `appGrantsForApp` **只按 `app_id` 过滤、完全不看 `organization_id`**，`electron/authorization-domain.cjs:547 evaluateAppAuthorization` 也只比对 `grant.app_id` 与目标覆盖、无组织判断。实测（T5）：往**不存在的组织** id 写一条同形 grant → 立刻 **ALLOW**（`allowSources` 含 `APP_GRANT`），删掉 → **DENY**；T5b 产品级后果：重置后在新组织撤销 canvas 是真 DENY，把旧组织那条残留行种回去立刻变 **ALLOW（撤销失效）**。**这正是第五批把授权表纳入重置同事务清理的原因 —— 不是卫生问题，是撤销失效路径（已修，见 §13）。** 原文保留不删】【**第六批已更新**：该取数与判权实现已在第六批改掉 —— `appGrantsForApp(appId, organizationId)` 现按 `(app_id, organization_id)` 取数、**组织为空/缺失 fail-closed 返回空集**，`evaluateAppAuthorization` 逐条挡异组织行（含 `organization_id=''` 的无主行）；本处引用的旧实现是**第五批当时的事实**，历史结论与取证价值不变。详见 `docs/decisions/D5-03F-app-grant-org-isolation-and-auth-error-contrast.md`。】
* 如实记为**数据残留 / 不变量缺口**（现有 `invariants()` 不检查指向已删组织的孤儿行）；**唯一真实风险写清**：将来若出现**组织 id 复用**（恢复备份 / 导入 / 人为指定），旧墓碑会**静默抑制新组织首次播种**。本批按裁定不修，风险登记在案。【**第五批订正**：同上 —— 「不可达」只对 user 侧成立；App 侧孤儿 grant 能直接复活权限，这一点在本批已由代码 + 实测推翻，并随重置清理一并修掉。「组织 id 复用」风险已用 node 受控 T3 验证：重置前同 id 播种被旧墓碑压制（`seeded:false`）→ 重置清除 → 重新初始化后同 id `seeded:true` 且授权形状与全新安装逐行同形。`invariants()` 仍未加「孤儿授权行」检查（本批新登记残留）。见 §13】

## 9. 决策八：临时目录归属标记与清理

**根因订正**：门禁脚本本来就有收尾清理，真漏洞有两处 —— ① `launchApp` 自建的 run1 userData 与 legacy 解包树**不在清理清单里**；② **硬退出（Ctrl-C / SIGTERM / 崩溃）时收尾块不执行**。不是「脚本没有清理」。

修法（`experiments/d5-03/userdata-ownership.cjs` 新增，policy 门禁 5 处 `mkdtemp` 全部接线）：

* 新建即写归属标记 `owner.json`（script / runId / pid / createdAt / kind / prefix）；
* **收尾只删「本次登记过 + `owner.json` 标记确属本进程 + 位于 `os.tmpdir()` 下」的目录**（`cleanupOwnedDirs`，按创建清单，绝不做通配符扫删）；
* 硬退出兜底：`SIGINT` / `SIGTERM` 处理器按同一清单收尾（SIGKILL 拦不住，见 §10）；
* 历史孤儿清理 `cleanOrphans`（CLI 默认 **dry-run**，加 `--apply` 才真删）：**三条件缺一不删** —— (a) 名字属于 `oa-d503b-` 命名空间；(b) 能证明归属（`owner.json` / 目录内含本脚本 userData 的 `identity.db` / 本脚本 legacy 解包树形状）；(c) 归属进程已不在（标记 pid 已死 / 标记写明 run 已结束 / 无标记时 `ps` 无存活进程引用且该 runId 的 run 产物已归档）。只读判断，不用 `pkill`。
* 单测 `tests/d5-03-tmpdir-ownership.test.mjs`（O1–O5，实测 5/5，含「没登记过的目录不得因为名字像就被删」「标记 pid 不是本进程 → 不删」「ps 不可用 → fail-closed 当在用」）。

**结果**：历史残留 **4 → 0**；本轮 9 次运行 `userDataDirsKept = []`、`leftovers = []`、`pkillUsed = false`。

## 10. 未闭合项与残留（如实登记）

1. **`notVerified` 仍 2 条**（`mcp-policy-e2e`）：同一安装内第二个组织无产品入口（单 root 团队约束）→ 跨组织行为级只到 schema + node 级；**本批不新增「创建组织」入口**（用户明令）。expiry 六场景与 center / stream 本轮 **0 条**。
2. **`errorText` 仍是通用括注实现**：命令失败路径的 detail（如 `idle-expiry`、`session-missing`）照旧显示；本批只修「事件 reason 被当 detail 传进用户文案」这一条根因。【第五批已更新：**已收口** —— `errorText` 改为「code 那一句 + 可展示 detail 白名单 `SHOWABLE_ERROR_DETAIL`（4 条全挂 `INVALID_INPUT`，每条带 `why`）」，表外 detail 一律过滤（模板串 / `String(detail)` / 括号括注都不允许）；内部诊断（日志 / 审计 / 连接 `detail=expired:idle`）原样保留。本批新登记残留：`RATE_LIMITED` 的 `{retryAfterMs}` 对象 detail 现被过滤但未映射成人话。见 §13】
3. **`resetInstallation` 孤儿残留**（数据残留 / 不变量缺口）：provisions 15 行 + grants 15 行指向已删组织；按 §8 裁定不修；风险 = 将来若出现组织 id 复用（恢复备份 / 导入 / 人为指定），旧墓碑会静默抑制新组织首次播种。【**第五批订正 + 已闭环**：孤儿行已随重置**同事务**清零（真机四表 15 / 14 / 1 / 0 → **0 / 0 / 0 / 0**，审计三表一行不删）；且「不可达」判定只对 **user 侧**成立 —— **App 侧**孤儿 `app_resource_grants` 能直接复活权限（`appGrantsForApp` 不带组织过滤 + `evaluateAppAuthorization` 无组织判断，T5/T5b 实测）。见 §13】【**第六批已更新**：该取数与判权实现已在第六批改掉 —— `appGrantsForApp(appId, organizationId)` 现按 `(app_id, organization_id)` 取数、**组织为空/缺失 fail-closed 返回空集**，`evaluateAppAuthorization` 逐条挡异组织行（含 `organization_id=''` 的无主行）；本处引用的旧实现是**第五批当时的事实**，历史结论与取证价值不变。详见 `docs/decisions/D5-03F-app-grant-org-isolation-and-auth-error-contrast.md`。】
4. **SIGKILL 拦不住**：临时目录归属清理靠 `SIGINT` / `SIGTERM` + 收尾块；`kill -9` 只能靠 `cleanOrphans` 事后按三条件清理（默认 dry-run）。
5. 既有缺口不变：**OAuth**（仅 `NONE` / `BEARER`）、**真实第三方与 Adobe / PS**（D5-04 / D5-05）、**插件隔离**（D5-08，连接成功 ≠ 插件隔离通过）、**D5-02 重命名受 Electron 不支持 `prompt()` 限制**。
6. 协议版本仍 `2025-06-18`（记录 / 客户端常量 / 域常量三处一致），本批不升级。

## 11. 相关代码与测试

* `electron/identity-domain.cjs`：`sessionExpiry()` 共用判据 + `EXPIRY_REASON` / `EXPIRY_DETAIL` + `evaluateSession` 到期优先；
* `electron/identity-service.cjs`：权威到期调度（单一定时器 / 代次 / 分块 / 四道门 / 重排）；
* `electron/identity-store.cjs`：幂等 `expireSession()`；
* `electron/mcp-bootstrap.cjs`：`identity/session-expired` → `MCP_SESSION_END_EVENTS` → 既有 dispose（`detail = expired:idle | expired:absolute`）；
* `electron/identity-bootstrap.cjs` / `electron/main.cjs`：短有效期双重开关与留痕；
* `src/identity/types.ts` / `src/identity/useIdentity.ts`：事件订阅收敛 + 登录页只显示规范文案；`src/mcp/McpCenter.tsx`：说明行补「会话过期」（一行文案）；
* 测试：`tests/identity-session-expiry.test.mjs`（12）、`tests/identity-session-expired-ui.test.mjs`（6）、`tests/d5-03-mcp-lifecycle.test.mjs`（9）、`tests/policy-provider-drift.test.mjs`（6）、`tests/app-policy-provisions-retention.test.mjs`（6）、`tests/d5-03-tmpdir-ownership.test.mjs`（5）、`tests/session-expiry-fixtures.mjs`；
* 验收脚本：`experiments/d5-03/mcp-expiry-e2e.mjs`（6 场景）；门禁 center / stream / policy 三个脚本；临时目录归属 `experiments/d5-03/userdata-ownership.cjs`。

## 12. 判定

* **D5-03 第四批（会话自然到期收流 + 策略收口）= PASS（限定范围）**：expiry 六场景 **25/25 + 7/7 + 5/5 + 7/7 + 7/7 + 5/5**、exit 0、defects 0；三个既有门禁 **38/38 + 29/29 + 43/43**（policy `notVerified` 仍 2）、exit 0，计数不低于首轮；视觉 = 通过（实机浅/深截图 1660×1140 与第一批基准逐像素同尺寸、对比度浅 4.94:1 / 深 6.30:1，12px/400 按普通文本门槛 4.5:1）；动效 = 通过（本批未新增动效）；回归 = node 目标集 193/193、全量 `npm test` 两条既有失败与本批无关、`npm run build` exit 0（本批记录）。
* **D5-03 整体仍 = PARTIAL**，剩余缺口 = §10 逐条（policy `notVerified` 2 条 / 第二个组织真机入口、OAuth、真实第三方与 Adobe / PS、插件隔离、`resetInstallation` 孤儿残留、`errorText` 通用括注、SIGKILL 边界、D5-02 `prompt()` 遗留）。【第五批已更新：`resetInstallation` 孤儿残留与 `errorText` 通用括注两项已由第五批闭环；第五批自身 = **PASS（限定范围：功能通过、视觉部分通过）**，D5-03 整体仍 = **PARTIAL**；剩余缺口与第五批新登记残留见 §13 / `docs/decisions/D5-03E-install-reset-authorization-consistency.md`】

---

## 13. 第五批更新（2026-09-28 · 产品修复 `09dccf9` + 门禁脚本/报告 `7ad424c`）

> 本节是**追加**，上面任何一行都没有删改；被改写的口径已就地加【第五批已更新】/【第五批订正】。
> **本批完整决策与证据 = `docs/decisions/D5-03E-install-reset-authorization-consistency.md`**；真机报告 `experiments/d5-03/D5-03-BATCH5-RESET-REPORT.md`（§9 = R3 重基线）、汇总 `experiments/d5-03/d5-03-batch5-summary.json`、tracked 证据 `docs/D5-03-GATE-EVIDENCE.json` 的 `batch5` 段。

### 13.1 决策（对本文档的直接改写）

* **安装重置在既有的那个 `transactSync` 内先清授权事实**：`electron/identity-store.cjs:1574` 的 `RESET_AUTHORIZATION_DELETE_SQL`（字面量四条整表删除：`app_policy_provisions` / `app_resource_grants` / `resource_grants` / `device_access`），在 `resetInstallation`（:2767）里先执行，**随后**才删 `sessions` / `login_attempts` / `users` / `teams` / `installations`。**T1a/T1b 两个注入点**（授权第 2 条 / 身份最后一条）都证明整体回滚，排除「两个独立事务」。
* **审计三表一行不删**：`audit_log` / `authorization_audit` / `device_audit`。**不写成「行数不变」**：`audit_log` 既有行不删（前缀逐行相等），重置自身**恰好新增两条**（`OK_REQUESTED` + `OK`），被拒 confirm 各留一条 `DENY`；真机 2 → 2 → **4** → **6** → 8。
* **不做整库扫删**：27 张带 `organization_id` 的表逐表判据（4 清 + 23 不清），表集合与数量由 `ORG_SCOPED_TABLE_COUNT = 27` + `orphanInventory()` 机器核对（T2）。
* **守卫收紧，不是放宽**：`ALLOWED_ORG_DELETION_PATHS` **恰好一条**（安装重置），放行 = 文件 + 命中形态 + 去空白逐字相等的完整语句；追加 fail-closed 四条（登记项必须在源码有对应字面量、必须位于 `RESET_AUTHORIZATION_DELETE_SQL` 内、`resetInstallation` 必须真的迭代它、必须在 `transactSync` 里）；新增永久负向自证 **R6b**（`tests/app-policy-provisions-retention.test.mjs:537`）。
* **`errorText` 收口**：`src/identity/types.ts:95` 的 `SHOWABLE_ERROR_DETAIL`（4 条、全挂 `INVALID_INPUT`、每条带 `why`）+ code 那一句；表外 detail 一律过滤；`AuthScreens.tsx` 只发 `password-mismatch` 标记；内部诊断（日志 / 审计 / 连接 `detail=expired:idle`）原样保留。

### 13.2 【第五批订正】第四批「孤儿行不可达」只对 user 侧成立

* **user 侧成立**：判定按 `organization_id = user.team_id` 过滤（`electron/authorization-domain.cjs:490`）→ 指向已删组织的 `resource_grants` / `app_policy_provisions` 在「组织整体消失」后确实不可达（除非组织 id 复用）。
* **App 侧不成立**：`electron/authorization-store.cjs:80 appGrantsForApp` **只按 `app_id` 过滤，完全不看 `organization_id`**；`electron/authorization-domain.cjs:547 evaluateAppAuthorization` 只比对 `grant.app_id` 与资源覆盖，**无组织判断**。实测（T5）：往不存在的组织 id 写一条同形 grant → 立刻 **ALLOW**（`allowSources` 含 `APP_GRANT`），删掉 → **DENY**；T5b：重置后在新组织撤销 canvas 是真 DENY，把旧组织残留行种回去立刻 **ALLOW（撤销失效）**。【**第六批已更新**：该取数与判权实现已在第六批改掉 —— `appGrantsForApp(appId, organizationId)` 现按 `(app_id, organization_id)` 取数、**组织为空/缺失 fail-closed 返回空集**，`evaluateAppAuthorization` 逐条挡异组织行（含 `organization_id=''` 的无主行）；本处引用的旧实现是**第五批当时的事实**，历史结论与取证价值不变。详见 `docs/decisions/D5-03F-app-grant-org-isolation-and-auth-error-contrast.md`。】
* **结论**：这正是本批把授权表纳入重置同事务清理的原因 —— **撤销失效路径，不是卫生问题**。

### 13.3 证据与判定

| 项 | 值 |
| --- | --- |
| 安装重置门禁（最终有效） | `20260928T070842Z-9cd0-mcp-reset-e2e` **26/26 · exit 0** · sha256 `17202b48…` |
| policy（R3 重基线后，当前有效） | `20260928T071705Z-db3d-mcp-policy-e2e` **43/43 · notVerified 2 · exit 0** · sha256 `18fe75ba…`（首轮 42/43 仅历史对照） |
| center / stream / expiry-idle | `20260928T065801Z-c7ba` 38/38、`20260928T065841Z-cce3` 29/29、`20260928T070551Z-f078` **26/26**（M1 修前 `…5288` 24/25 仅历史对照），全部 exit 0 |
| 视觉 / 动效 | `20260928T070627Z-27eb-auth-error-visual` **16/17**（唯一 FAIL = 浅色向导卡 `.auth-error` **2.62:1** < 4.5:1，既有缺口、本批未改样式）；动效 = 通过（本批改动文件**不含任何 `.css`**） |
| 受影响性分析 | `20260928T070745Z-e3b6-batch5-affectedness` 10/10 · exit 0 |
| 被测内容披露 | 产品修复 = `09dccf9`；门禁脚本/报告 = `7ad424c`（**只改 `experiments/` 7 个文件，产品代码零改动**）；10 个 batch5 artifact 全部记 `testedCommit=09dccf9`。汇总 JSON 冻结于 07:09:52Z，**早于 §9 的 R3 重跑（07:17）**，故它记 42/43 且不含 `db3d` —— 两个数字并列、不互相顶替。 |
| 回归 | 相关五文件 `55/55`（`d5-03-reset-authorization-consistency` 9 + `app-policy-provisions-retention` 7 + `identity-session-expired-ui` 11 + `identity-session-expiry` 12 + `identity-store` 16）；全量 `1347/1349`（两条既有失败与本批无关）；`npm run build` exit 0；`SCHEMA_VERSION` 仍 21。 |
| 判定 | **D5-03 第五批 = PASS（限定范围：功能通过、视觉部分通过）；D5-03 整体仍 = PARTIAL** |

### 13.4 裁定与残留（本节生效，覆盖 §8 里被第五批改写的两条）

1. **守卫只放行「安装重置」这一条路径，不开放通用清理**；用户内容与配置登记为不清（不做整库扫删）。
2. **R3 采用登记表式基线、跨批不复位**：第六批若动到这 4 个文件之外、或改掉任一条必含标记 / 引入禁含形态 → R3 FAIL，属 **fail-closed 设计**。
3. **浅色 `.auth-error` 2.62:1 本批不改**（设计值 / 视觉属产品决策），**登记为未闭合缺陷**。
4. `notVerified`：跨组织真机 **2 条继续保留**；本批新增 6 条（组织 ID 复用真机不可构造 → node T3；`device_access` 真机 0 → 0 不构成清理证据；`invariants()` 原生入口缺失 → 等价只读复算；`session-missing` / `not-locked` 真机不可达；浅色对比度不达标；整窗截图与第四批窗口裁剪非逐像素同尺寸）。
5. **本批新登记残留**：`device_pairing_credentials` 未清（T7 证明不产生授权结论，建议下批或产品裁定）；【**第七批已更新**：已随安装重置**同事务**清空 —— 真机证据 = 设备三表 **1 / 1 / 2 → 0**、旧未使用密钥 `PAIRING_TOKEN_UNKNOWN` 且 **0 新设备 / 0 新凭据**、旧指纹 `DEVICE_CREDENTIAL_UNKNOWN`；第五批 / 第六批的历史结论不变（详见 `docs/decisions/D5-03G-install-reset-device-identity.md`）。】`app_principals.status` 不受重置影响（安装级配置）；`RATE_LIMITED` 的 `{retryAfterMs}` 对象 detail 现被过滤但未映射成人话；`invariants()` 未加「孤儿授权行」检查（理由与代价已登记）；浅色 `.auth-error` 2.62:1 未闭合。
6. **本批未新增「创建组织」入口**（用户明令）；协议仍 `2025-06-18`、`SCHEMA_VERSION` 仍 21。

