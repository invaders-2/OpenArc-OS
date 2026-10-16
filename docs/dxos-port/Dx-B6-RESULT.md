# Dx-B6-RESULT · B6（自动化 + 文件系统 + 平台）+ UI-2/UI-3 测试与验收报告

> 依据：本轮任务「OK 继续」= 按 §5 推进 B6，并同步 UI（用户指示：前端采用 OpenArc 自己的设计语言）。
> 分支 `dxos-port/r1`，起点 `d805943`（B5 收口）。真实命令与输出见下；未验证项显式标注。

## 1. 交付对照

| 要求 | 落点 | 状态 |
|---|---|---|
| B6 · 自动化定义/启停/调度/运行记录 | `automation-{domain,store,service,bootstrap}.cjs`（1,557 行）：命令白名单 + 调度解析（daily/weekly/once 逐字 + cron/interval）、主进程内调度器（15s tick，异步不阻塞）、重试（maxAttempts 3，只落一行 run 记真实 attempts）、取消绝不写 success、启动恢复 running→failed；表沿用 v22 `automations`/`automation_runs`，**零 CREATE/ALTER** | ✅ |
| B6 · 业务动作 | 依赖全部走注入（开发者 App 属 B7、钉钉/领星/紫鸟属第三方插件默认关、本地账号用 B4 的 `localAccountService`）；未注入一律结构化 `AGENT_DEPENDENCY_UNAVAILABLE`（`detail.dependency`），**不假执行** | ✅（部分动作受 B7 未落地限制） |
| B6 · 文件系统（虚拟文件树/blob/缩略图/共享与部门盘/回收站/快照） | `dxos-fs.cjs` 1,423 行（源 `fs.ts` 64 个函数逐函数移植）+ `dxos-fs-adapter.cjs`；数据落 `<userData>/dxos/fs`；既有 `file-service.cjs`/`folder-trash.cjs`/`resource-*.cjs` **一字未动**（边界写在文件头） | ✅ |
| B6 · blob/快照语义对齐 | 内容寻址 `blobs/sha256/xx/<sha>` + 哈希校验、revision 乐观锁 + Journal 批量提交、快照创建/恢复、回收站软删/恢复/清空、共享盘/部门盘可见性 | ✅ |
| B6 · 平台（诊断/数据保护/网络安全/供应商测试安全） | `platform-{domain,service,bootstrap}.cjs`：应用与进程诊断（只取 RuntimeSupervisor safe 记录，不暴露 env/path）、数据保护快照（create/verify/list/restore + 失败回滚，凭据目录排除）、网络安全判定（白名单/HTTPS/DNS 公网，解析器可注入）、供应商测试安全检查；25/25 测试 | ✅ |
| B6 · 接线 | `fsAdapter` 真正接进 agent/skill 装配点（B6d）；preload 顶层键 20→**22**（automation、platform）；探针同步 | ✅ |
| UI-2 · MCP 中心扩展 | 工具聚合区块（命名空间 `mcp__<server>__<tool>`、参数摘要空对象如实标注、停用/未连接不参与聚合）+**产品边界显式标注**（界面 0 个调用入口）+ 设计系统一致性修正：主标题改 `--fs-title`、列表/详情/聚合改用 `ScrollArea`（0→3） | ✅ |
| UI-3 · 任务 / Agent 控制台 | `TaskConsole.tsx` + `taskConsoleLogic.ts`；`main.tsx` 的 projects 分支改为"任务控制台 / 项目与资源"子视图；九类状态 + 事件流 `afterSequence` 增量 + 回答输入 | ✅ |

## 2. UI 验收记录（UI-2 / UI-3）

**规范依据**：`DESIGN_SYSTEM.md` §2（组件清单）/§5（字阶）/§8（组件状态）/§9、`MOTION_SYSTEM.md` §5/§7、`PLAN.md` §4/§42；计划 `Dx-UI-PLAN.md`。**tokens.css 零改动**（`git diff --stat -- src/design-system/tokens.css package.json package-lock.json index.html` 为空）。

| 验收项 | UI-2（MCP 中心） | UI-3（任务/Agent 控制台） |
|---|---|---|
| 页面与状态 | 8 张状态截图（loading/empty/error/ready/unavailable/tools-many/narrow-640/detail-ready） | 9 张状态截图（loading/empty/error/session-expired/dependency/ready/running/waiting-user/narrow-640） |
| 复用 token 与组件 | 仅 primitives（Button/Badge/TextField/ScrollArea…）与 PageState | 仅 primitives 与 PageState；`.task-*` 为纯追加，**无自定义属性声明（token 零新增）** |
| 基准对照（同 light / 1440×900 / dSF 2 / reduce） | **改前/改后**对照：`before-mcp-center.png` vs `after-mcp-center.png`（标题 14px→21px、ScrollArea 0→3；配色/圆角/毛玻璃/布局/信息密度未动），结论落 `compare-fixes.md` | **与基准页**对照：`compare-task.png` vs `compare-skill.png`，关键度量 **完全一致**（root 1180 / split 1180 / 行高 108 / 标题 21px / 行标题 14px / 元信息 11px，差异项全为 0；仅 rootHeight +22.9 来自详情内容长度） |
| 动效 | 尊重 reduced motion（动画 none）、Tab 顺序只在页内（outside=0） | 按 MOTION §7：每相位 label+glyph+文字（不靠颜色单独传意）、queued/waiting 停转圈、busy 时 `disabled+aria-busy` 防连点；**连续录屏** `task-console-flow.webm` |
| 边界 | 只发 `mcp/list|get|testLog`；0 调用入口；localStorage 长度 0；0 console error；0 非本地请求 | 只发 9 条白名单命令；载荷不含 userId/role/sessionRef/appId；0 console error；0 非本地请求 |
| 探针 | **49/49 PASS，exit 0** | **45/45 PASS，exit 0**（连跑 3 次一致）；单测 33/33；`tsc --noEmit` 0 |

证据目录：`artifacts/dxos-ui-mcp/`、`artifacts/dxos-ui-tasks/`（`artifacts/` 为 gitignore，不入提交）。

## 3. 真实命令与真实输出

```
$ npm run build                                              BUILD_EXIT=0

$ npm test                    （独占）
1..2159
# tests 2159 / # pass 2158 / # fail 1                       TEST_EXIT=1
唯一失败：not ok 337 - D5-03-E · ACP SDK 只认项目内那一份（基线既有环境项）
对照：B5 2047/2046/1 → B6 2159/2158/1（新增 112 例）

$ npm run test:model-ipc-ui   （真实 Electron，preload 22 键）
10/10 IPC checks passed                                      MODELIPC_EXIT=0

$ npm run test:design-system
5 个探针：PASS 4 / PARTIAL 1 / FAIL 0                         DS_EXIT=0

$ node experiments/dxos-ui-skills/run-all.mjs   PASS 33/33    UISKILL_EXIT=0
$ node experiments/dxos-ui-mcp/run-all.mjs      PASS 49/49    UIMCP_EXIT=0
$ node experiments/dxos-ui-tasks/run-all.mjs    PASS 45/45    UITASK_EXIT=0
$ node experiments/dxos-b5/run-all.mjs          全部通过       MEDIA_EXIT=0

$ node --test tests/dxos-automation*.test.mjs                 # tests 23 / pass 23
$ node --test tests/dxos-fs*.test.mjs                         # tests 17 / pass 17
$ node --test tests/dxos-fs-wiring.test.mjs                   # tests 9 / pass 9
$ node --test tests/dxos-platform*.test.mjs                   # tests 25 / pass 25
```

## 4. 门禁期间发现并收口的问题

| 问题 | 性质 | 处置 |
|---|---|---|
| `fsAdapter` 接线（B3/B5 一直 `AGENT_DEPENDENCY_UNAVAILABLE`） | B6b 交付了适配器但装配点仍传 null；且 **skill-service 曾把 DX 虚拟树错当 `node:fs` 替身传给 `fsImpl`（形状不符、静默无效）** | B6d 修正语义错配（只喂 skillRunner 落盘路径，`fsImpl` 回归 node:fs），并在 main 构造适配器注入 agent/skill；**装配失败如实 `fsAdapter:false` + 结构化拒绝**。解锁效果：`agent/tool/call` 的 fs_read/fs_write 真落虚拟树、`project/snapshot`、`project/run` 不再停在 `fs_list`、`skill/run` 产物落虚拟树；越界写围栏仍生效 |
| `test:model-ipc-ui` 顶层键断言滞后 | B6a/B6c 有意新增 automation/platform 域（20→22） | 探针 `expectedTopKeys` 20→22 并写明原因；负向断言（15 项 raw 能力黑名单、桥值只允许 function）未放松；真机 10/10 |

## 5. 未验收 / NOT VERIFIED

1. **真实 Electron 端到端**：`automation:command`/`platform:command` 及 fsAdapter 生效路径的真机投递未跑（B6d 允许的一次 `test:model-ipc-ui` 不 boot `main.cjs`；改用"源码级契约 + 同一 helper 进程内真跑 + 真实 22 键"三重合证）。
2. **B7 依赖的动作不可达**：开发者 App、钉钉/领星/紫鸟在 main 中一律 null，只验证了"缺依赖结构化拒绝"与"假适配器注入成功"两条路径。
3. **源 AI 解析分支未移植**：`POST /api/automations/parse` 的模型分支只保留离线规则解析（`parsedBy=rules`）。
4. **mediaAdapter / artworkAdapter / libraryAdapter 仍未装配**（属 B5/B7 后续接线），命令侧保持结构化拒绝。
5. **多进程文件锁未实测**：`waitForFsLock` 的 2s 超时/30s 僵死回收按源移植，但只做了同进程两实例的基线过期验证。
6. **平台进程诊断只覆盖 RuntimeSupervisor**：media runner / MCP stdio 无枚举句柄 → 返回空数组（不伪造条目）。
7. **UI 未做真实 Electron 渲染**：三套探针均用 Chromium + 本地静态服务与假桥；`agent:event` 只消费 progress（log/approval 未接）。
8. **UI-2 的一处已知重复**：后端 `MCP_COMMANDS` 无聚合命令，工具聚合目前在渲染层按 B4 同规则从 `mcp/list` 派生；正确修法是后端加一条白名单聚合命令后前端只换数据源（**登记为待收口**）。
9. 计划明细与检查点明细不在 `task/get` 安全投影里：界面用有序步骤表达计划、检查点只显示数量并注明不编造明细。

## 6. 结论

B6 三域与 UI-2/UI-3 均**落地并通过门禁**：build ✅、全量测试 ✅（唯一失败为基线既有 #337）、真机 preload 探针 ✅（22 键）、design-system ✅、三套 UI 探针 33+49+45 全 PASS ✅、媒体真机探针 ✅。本批最有价值的解锁是 **fsAdapter 真正接上**（含修正一处静默错配），使 B3/B5 中一批"依赖缺失"路径转为可用且仍保持越界围栏。UI 侧两页在同一设计语言下与基准页度量完全一致，MCP 中心的一致性修正有改前/改后对照。未验收项已逐条列明。


## 7. 独立验证（只读，与移植岗分离）与收口

**验证岗结论**：B6 三域 + fsAdapter 接线 + UI-2/UI-3 的核心声称**属实、可复现、无高危缺陷**。它自建离线守护（socket/dns/fetch 级，非回环一律封杀）：12 个测试文件 145/145、4 个 experiments 全 PASS、37 个被守护进程**非回环事件 0**。

**重点证伪（4/4 通过）**：
1. **fsAdapter 真接线**：同一实例贯穿 `agentTaskStore.getAgentFsAdapter()`、`agent-runtime-deps.requireDependency("fsAdapter")`、kernel/runtime/reactDriver；`git diff` 证明确实移除了此前 `fsImpl: fsAdapter` 的静默错配（不是只改注释）。
2. **装配失败如实**：非法目录抛 ENOTDIR 不返回半成品；null 时 `dependencies.fsAdapter=false` + `AGENT_DEPENDENCY_UNAVAILABLE(dependency:"fsAdapter")`。
3. **调度器不阻塞**：慢动作 300ms 期间第二次 tick 已领取并完成另一 run；900ms 内心跳 81 次、最大间隔 12ms。
4. **平台快照不含密钥**：植入明文凭据后快照 manifest/磁盘仅 `[fs/fs.json, providers.json]`，全目录搜不到明文串。

**UI 证据独立复核**：三套 artifacts 可复现（checks 33/49/45，0 consoleError / 0 externalRequests）；webm 有效（vp8 1440×900，10.72/4.04/7.56s）；像素级独立测量坐实 MCP 主标题 20→30 设备像素（1.50 = 21/14）与任务页列表栏 288 CSS px。

**验证岗发现并在本批关闭的问题**：

| 严重度 | 问题 | 处置 |
|---|---|---|
| 中（可靠性） | 调度领取语义与源不同：源 server/desktop 双路径且**每次领取做 10 分钟 stale 恢复**，移植只在启动时恢复 → 主进程不重启时挂起的 run 长期停留 running | B6e 补齐 **per-claim stale 恢复**（阈值常量 `DEFAULT_STALE_AFTER_MS` 可注入，事务内带守卫 UPDATE，`stale-recovered` 事件 + 审计，幂等且不误收敛未超阈值 run，与启动恢复不重复处理）；源 `:314-334` 两处 UPDATE 逐行对齐；新增 5 用例（58/58） |
| 低 | `agent-runtime-workspace.cjs:22` 契约注释 `ensureFolder -> FsNode` 与实际返回文件夹 id 不符 | 按源 `fs.ts:685-691` 与调用点订正注释 |
| 低 | 命令通道实际 **24** 条（automation 13 + platform 11），任务书写的 25 与实现不符 | 以 24 为准登记（白名单与 `case` 1:1，无"白名单未实现"） |
| 低（继承源） | `sanitizePlatformText` 对 JSON 引号键的 token 值不命中（源 `appDiagnostics.ts:4-8` 同款正则） | **非本轮回归**，如实登记；`redactValue` 按键脱敏正常 |
| 提示 | `automation/catalog` 依赖注入 developerApps（B7 未落地）→ 生产不可用；`platform/network/evaluate` 未注入 lookup 时会做真实 DNS 解析（设计如此） | 如实登记，不伪造 |

**验证岗未验证项**（与本报告 §5 一致）：真实 Electron 端到端、全量 `npm test`（采信 Lead 独占结果）、多进程文件锁、DNS 实测、MCP 前后端字段取值一致性、UI 非真机渲染。

## 8. 提交

`5d4bd91` 自动化域 / `b638ac0` 文件树与 fsAdapter 接线 / `211f707` 平台域 / `f43762e` UI-2+UI-3 / `e17db61` 装配与探针契约 /（B6e stale 恢复与本报文同批提交）。

