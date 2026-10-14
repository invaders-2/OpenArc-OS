# Dx-B7-RESULT · B7（本地开发者平台 + 可选第三方插件）+ UI-4/UI-5 测试与验收报告

> 依据：本轮任务「OK 继续」= 按 §5 推进 B7，并同步 UI-4/UI-5。分支 `dxos-port/r1`，起点 `d140969`（B6 收口）。
> 真实命令与输出见下；未验证项显式标注。

## 1. 交付对照

| 要求 | 落点 | 状态 |
|---|---|---|
| B7 · dx-app/v2 清单、本地装载/启用/回滚 | `developer-{domain,store,service,bootstrap}.cjs`：v1+v2 清单校验（版本/build/systemVersion/dataVersion、入口存在性、危险权限与危险字段**整包拒绝**、原型污染键拒绝）、装载→启用→禁用→**回滚**→卸载全链路；复用 v22 六表（`user_installed_apps`/`user_app_install_state`/`app_market_releases` 作本地清单缓存/`app_credential_bindings`/`app_runtime_events`/`app_network_audit`），**零新建表** | ✅ |
| B7 · 出网治理 | 仅 HTTPS、禁内嵌凭据、端口围栏、域名白名单（未声明一律拒绝）、DNS 公网校验、60 次/分限流（先于一切校验）、审计落 `app_network_audit` | ✅ |
| B7 · developerLab / 打包 / 协同项目 / 声明式迁移 / 本机与局域网实时房间 | `developer-{lab,collab,migrations,realtime}.cjs`：示例工程四文件与源 **SHA-256 逐字一致**；协同一律落既有 `projects`/`project_members`（`sqlite_master` 无新表）；迁移幂等、失败**整批回滚**；实时房间序号/冲突/重连，传输未注入即结构化不可用（**云端房间 OUT**） | ✅ |
| B7 · 可选第三方插件（默认关） | `plugin-{registry,service,bootstrap}.cjs` + 8 个插件：钉钉、天气、黄历、领星、紫鸟、夸克、RunningHub、ModelScope；**默认全关**、依赖探测（binary/python/credential/network）、缺依赖返回 `INTEGRATION_UNAVAILABLE` + "缺什么/怎么装" | ✅ |
| B7 · ComfyUI | `comfy-{domain,workflow,store,worker,service,bootstrap,bridge}.cjs`：24 条命令、随包 3 份内置工作流、**重活受监督子进程**（自持 deadline、killTree、零子进程当依赖缺失时）、桥接字符串与源 SHA-256 一致 | ✅ |
| B7 · 本地市场（替代云端市场） | `market-{domain,service}.cjs` + `resources/market/catalog.json`（**有效但空** + schema + README）：不联网、不下载；云发布/审核/灰度 OUT | ✅ |
| B7 · B2 legacy 执行器"第三方原生适配"补口 | `legacy-executor-ports.cjs` + RunningHub/ModelScope 插件：B2 执行器 8 处分支改为"端口已注入则调用、未注入仍原样拒绝" | ✅ |
| UI-4 · 组织治理 | 部门/成员/APP 访问/**审计（切到 `identity/audit-list` 真源）**；界面 0 处"会员/权益"字样 | ✅ |
| UI-5 · 模型与协议 | 协议表（71 条真实投影）、能力 manifest（未返回字段如实标注）、流式状态机（P1 信封、sequence 单调） | ✅ |

## 2. UI 验收记录（UI-4 / UI-5）

**规范依据**：`DESIGN_SYSTEM.md` §1–§11、`MOTION_SYSTEM.md` §5/§7、`PLAN.md` §4/§42；计划 `Dx-UI-PLAN.md`。**tokens.css 全程零改动**（新增 CSS 行中自定义属性定义数 = 0）。

| 项 | UI-4 组织治理 | UI-5 模型与协议 |
|---|---|---|
| 状态覆盖 | 12 张截图：loading/empty/error/session-expired/not-super-admin/invalid-input/ready/saving/narrow-640/app-access | 13 张截图 + 流式/停止/错误等 |
| 基准对照（light/1440×900/×2/reduce） | 与 SkillCenter：容器与两栏宽度差 0、三项字阶差 0px；行高 110 vs 108（+2px，已登记） | 与 SkillCenter：列定义与 gap 一致、三项字阶差 0px；协议行 +56px（多一行说明，已登记） |
| 探针 | **51/51 PASS**，单测 32/32 | **66/66 PASS**，单测 37/37 |
| 边界 | 0 console error / 0 非本地请求 / 只发 14→15 条白名单命令 / 载荷不含 sessionRef / 0 处"会员·权益·套餐·积分" | 只发 8 条白名单命令 / 0 console error / 0 非本地请求；探针 fixture **直接 require 主进程真实模块生成**，legacy-only 38 条如实返回 `PROTOCOL_NOT_FOUND` |
| 动效 | 连续录屏 `org-console-flow.webm`；保存中 disabled+aria-busy 防连点 | 连续录屏 `model-protocol-flow.webm`；流式增量与状态切换按 MOTION §7 |

## 3. 真实命令与真实输出

```
$ npm run build                                              BUILD_EXIT=0

$ npm test                    （独占）
1..2443
# tests 2443 / # pass 2442 / # fail 1                      TEST_EXIT=1
唯一失败：not ok 337 - D5-03-E · ACP SDK 只认项目内那一份（基线既有环境项）
对照：B6 2159/2158/1 → B7 2443/2442/1（新增 284 例）

$ npm run test:model-ipc-ui   （真实 Electron，preload 26 键）
10/10 IPC checks passed                                     MODELIPC_EXIT=0

$ npm run test:design-system                                 DS_EXIT=0

$ 五套 UI 探针（一次门禁内串行）
dxos-ui-skills 33/33 · dxos-ui-mcp 49/49 · dxos-ui-tasks 45/45 · dxos-ui-org 51/51 · dxos-ui-model 66/66
node experiments/dxos-b5/run-all.mjs  全部通过（真实 ffmpeg 全链路）

$ 各域验收（执行岗与验证岗）
developer* + integration* + plugin* 154/154（含 B7h 新增 4 条）
dxos-plugin*/market* 40/40 · dxos-integration-* 34/34 · dxos-comfy* 51/51
```

## 4. 独立验证与收口

**验证岗结论**：B7 与 UI-4/UI-5 在**声明范围内交付成立**；六项重点证伪全部未被推翻 —— ① 70 条命令经真实 bootstrap 逐条可达（`COMMAND_NOT_ALLOWED=0`、`NOT_IMPLEMENTED=0`）；② 迁移失败整批回滚；③ legacy 端口注入后 B2 执行器真的走新实现；④ 8 插件默认全关（新建 registry 两次均 `enabled=[]`）；⑤ comfy 依赖缺失时**零子进程**；⑥ 空市场清单是有效状态（真缺目录才 `MARKET_CATALOG_MISSING`）。运行：32 个测试文件 **404/404**、五套 UI 探针 **244/244**、离线守护 **BLOCKED=0**。

**验证岗发现并在本批关闭的问题**：

| 严重度 | 问题 | 处置 |
|---|---|---|
| 低-中（可观测性） | 扩展切片装配失败被 `console.warn` 吞掉，34 条命令静默变 `COMMAND_NOT_ALLOWED`，而 `developer/health` 仍静态报 `commands:70` | `developer/health` 改为报**实际可达数** + `extensions:{lab,collab,migrations,realtime}` 状态 + `degradedReason`；`main.cjs` 逐切片 try/catch 把失败原因带进 health；新增"四切片全命令经 bootstrap 可达"与"切片装配失败可观测"两条用例 |
| 低（一致性） | `install()` 先迁移后写包/激活，写盘失败会出现"数据已迁移、版本未更新" | 改为"先落盘（唯一可失败前置）→ 迁移快照 + 本地事务内 activate/setInstalled → 任一步失败恢复快照 + 删包 + 事务回滚"；新增"写包失败"（迁移一次都没跑）与"激活失败"（按快照恢复）两条故障注入用例 |
| 低 | RunningHub AI 应用/工作流入口内部实现但未暴露命令；agnes/oauth/领星看板与汇率/紫鸟 VC 行级导入未移植 | 逐条登记进对应文件头（声明范围外），并在本报告 §5 台账 |
| 低 | UI-3 的 CSS 边界断言被 UI-4/UI-5 追加区块顶旧（`#1496`） | 修正边界提取范围（与 B7f 对 org-console 的处理一致），并用注入反例证明断言强度不变 |

**验证岗未验证项**：全量 `npm test`（采信 Lead 独占结果）、真实 Electron 启动、Chromium 子进程网络、真实凭据网络往返、DX 源 100% 行级等价。

## 5. 未移植 / 声明外台账（如实登记）

- `agnes.ts`（原登记"未移植，仅保留 3 个 legacy 端口名可注入"；**2026-10-14 按 §11 更正**：B7e3 已提供 `plugin-agnes.cjs` 真实实现并注入 3 个 legacy 端口，执行可用性改标 conditional）
- `developerOAuth.ts`（OUT：开发者 OAuth/PKCE 属排除项；manifest 的 oauth/oauthRedirect 一律拒绝）
- 领星：`lingxingBusinessAnalytics`、运营看板查询/导出、汇率
- 紫鸟：VC 行级导入（`importZiniaoVcFile`/`ziniaoVcRows`/`queryZiniaoVcData`）；`listZiniaoVcFiles` 已移植
- RunningHub：AI 应用/工作流入口已实现但未暴露命令（`callRunningHubChat`/`describeRunningHubImage` 原登记为未移植，**2026-10-14 按 §11 关闭**：两者已接进 legacy 端口，见下文）
- ComfyUI：runninghub/tunnel/SSH 自动修复、封面（sharp）、云发布/更新
- 厂商大文件**未复制**：`vendor/quark-drive.cjs`（486KB）、`server/ziniao/*.py`（按路径调用或注入，缺则结构化不可用）

## 6. 未验收 / NOT VERIFIED

1. **真实 Electron 端到端**：`developer:command`/`integration:command`/`market:command`/`comfy:command` 的真机投递未跑（`test:model-ipc-ui` 覆盖 preload 键契约，不启动 `main.cjs`）。
2. **真实第三方连通**：RunningHub/ModelScope/领星/紫鸟/夸克/钉钉/天气/黄历 全部只到"请求构造/轮询/降级"层，无凭据、不联网。
3. **ComfyUI 真机运行**：本机无 Python-embeded/main.py，实例启动与运行为依赖缺失态（零子进程），只验证了受监督协议与降级。
4. **LAN 实时房间 ws 路径**未真实启动；**多进程文件锁**未实测。
5. **迁移的项目根**需 install payload 的 `migrationRoots`（产品里尚无 app→项目根映射），未注入时结构化拒绝。
6. **UI 非真机渲染**：五套探针均为 esbuild 挂载壳 + Chromium + 本地静态服务；深色主题、减少透明度、125/150/200% 缩放、动效帧时间未单独验证。
7. **远程 ComfyUI（本机不装）**当前被保守闸门拒绝，若产品要 remote-only 需放宽 `assertAvailable`（决策项）。
8. **health.commands 语义变更**：由"白名单长度"改为"实际可达数"（`declaredCommands` 保留静态值），属对外行为变化，已同步 3 处断言并全仓 grep 确认无其它消费者。

## 7. 结论

B7（开发者平台 + 8 个可选插件 + ComfyUI + 本地市场 + B2 端口补口）与 UI-4/UI-5 均**落地并通过门禁**：build ✅、全量测试 ✅（唯一失败为基线既有 #337）、真机 preload 探针 ✅（26 键）、design-system ✅、五套 UI 探针 33/49/45/51/66 全 PASS ✅、媒体真机探针 ✅。验证岗的六项证伪全部未推翻、约束零违规；它提出的两条实现缺口（可观测性、install 一致性）**已在本批内关闭并加故障注入用例**，其余差异已逐条登记台账。B1–B7 全部批次至此完成。

---

## 8. 范围变更：ComfyUI 移除（B7i，追加于 2026-10-14）

> 本节是**追加说明**，不改写上面任何历史结论：§1–§7 如实记录的是移除**之前** B7e1 的交付与验证事实；自本日起 B7e1 已从移植范围移除。

**用户决定**：ComfyUI **从移植范围移除**，不再作为可选插件/域提供；要求干净移除，不留半成品、不留死引用。

**移除日期**：2026-10-14。

**被删模块清单（12 个文件）**

| 类别 | 文件 |
|---|---|
| 域实现（8） | `electron/comfy-domain.cjs`、`comfy-workflow.cjs`、`comfy-store.cjs`、`comfy-worker.cjs`、`comfy-service.cjs`、`comfy-bootstrap.cjs`、`comfy-bridge.cjs`、`comfy-projects.cjs` |
| 验收测试（4） | `tests/dxos-comfy-workflow.test.mjs`、`dxos-comfy-supervisor.test.mjs`、`dxos-comfy-ipc.test.mjs`、`dxos-comfy-projects.test.mjs` |

**同步清理的接线与引用**

- `electron/main.cjs`：`createComfyBundle` / `registerComfyIpc` 的 require、comfy bundle 变量与整段装配；
- `electron/preload.cjs`：顶层键 `comfy`（键数 26 → 25；`market` 之后不再有键）；
- `src/types/openarc-ipc.d.ts`：`OpenArcComfy*` 全部类型与 P1 声明的 `comfy?` 可选键（一并去掉）；
- `electron/dxos-foundation-paths.cjs`：`DXOS_LAYOUT.directories` 去掉 `comfy-workflows`（注释里的 ComfyUI 同步清理）；
- `electron/developer-service.cjs`：去掉对已删 `comfy-service.cjs` 的悬空注释引用；
- `electron/agent-cli-bridge.cjs`：去掉指向 `ComfyUI-API-Modelscope` 旧目录的 Codex OAuth 兼容候选路径；
- `tests/dxos-foundation.test.mjs`、`tests/dxos-plugin-ipc.test.mjs`、`tests/fixtures/model-ipc-probe/main.cjs`：顶层键/目录口径改为 **25**，并把 `comfy` 位次断言改成负向口径（comfy 键不存在 + `market` 之后不再有键；负向断言不放松）。

**随之丢失的能力**

1. **受监督实例监督**：本地 / 局域网 / 远端 ComfyUI 实例的登记、启动、停止与运行句柄跟踪——`dxos-foundation-runner.cjs` + `comfy-worker.cjs` 的受监督子进程通道整体移除（含"依赖缺失时零子进程"的降级协议）；
2. **工作流执行**：API 工作流的解析 / 导入 / 保存 / 删除、参数校验与节点映射，以及 `comfy/run/*` 的提交 / 查询 / 取消 / 结果回读；随包 3 份内置工作流与 `bundled-comfy-workflows` 目录装配一并移除；
3. **桥接**：`comfy-bridge.cjs` 的随包扩展安装 / 打包，以及 `comfy:command`（24 条命令）+ `comfy:event` 两条 IPC 通道全部移除；依赖探测（Python / `main.py`）与 `COMFY_DEPENDENCY_UNAVAILABLE`、`COMFY_NOT_READY` 等失败码随之消失。

**未删除、且不属于本次移除范围的引用（保留原因）**

- `src/canvas/CanvasHost.tsx` 的 `comfy` 能力投影、`public/novai-canvas/openarc-canvas-guard.js` 的守卫与 `comfyui-settings` 静态页：属 D5-02 **既有画布界面**（硬约束「不改既有界面」）。画布一直把 ComfyUI 显示为「未接入（不可用）」，**不依赖**被删的 B7e1 域，移除后行为不变；
- `electron/canvas-domain.cjs` 的 `NODE_TYPES` 含 `"comfy"`：D5-02 画布节点类型表（提交 `d875558` 引入），非 B7e1 域；
- `electron/plugin-runninghub.cjs` 的 `ComfyUI_RH_OpenAPI` 注册表 URL：RunningHub 插件（提交 `3aa2598`）的**第三方上游地址**，改动会破坏该插件，故保留；
- `experiments/d5-02/**` 与 `experiments/d5-03/batch13/verify/31-electron-d5-02-canvas.txt`：D5-02 画布的历史实验与 vendored 上游代码（`pruneMissingComfyWorkflows()` 是上游画布函数的调用），保留为历史证据。

**历史文档的处理**：`docs/dxos-port/Dx-P0-BASELINE.md`、`Dx-P0-COMMIT-RECORD.md`、`Dx-P0-DEPENDENCIES.md`、`Dx-P0-IPC-CONTRACT.md`、`Dx-P0-LOCALIZATION-SWITCHES.md`、`Dx-ROUND-RESULT.md` 中出现的 ComfyUI 均为移除前的基线/验收记录，原文保留，并在同一处加注"2026-10-14 随 B7i 移除"；`docs/D5-02-*` 中的 ComfyUI 指**保留的画布页面**，与本次移除无关，不改写。

**若要恢复需要哪些前提**

1. 用户重新把 ComfyUI 纳入移植范围（产品决策）；
2. 恢复八个 `electron/comfy-*.cjs` 与 `dxos-foundation-paths.cjs` 的 `comfy-workflows` 目录，并在 `main.cjs` / `preload.cjs` 重新装配（顶层键回到第 26 位，`openarc-ipc.d.ts` 恢复 `OpenArcComfy*`）；
3. 恢复四个 comfy 测试，并把 `test:model-ipc-ui` 与探针口径改回 26 键；
4. 本机具备 Python 运行时与 ComfyUI `main.py`（当前实测缺失，见 `Dx-P0-DEPENDENCIES.md`），否则只能停留在依赖缺失的降级态；
5. 仍需遵守原硬约束：不联网云发布 / 云更新（`api.dx-os.com` OUT）、不新增依赖、DX OS 只读。

**本批验证**：`npm run test:model-ipc-ui` 10/10（真实 Electron，preload **25 键**）；相关离线单测 `node --test` 62/62；代码目录 grep 已无被删域的引用（保留项如上）。

---

## 9. 语义文档化：developer/health 的 commands 与 declaredCommands（追加于 2026-10-14）

> 本节是**追加说明**，不改写 §1–§8 的历史结论；只补文档与类型注释，不改运行时代码。

**背景**：`developer/health` 回包里有两条含义不同的计数。B7h 起 `commands` 由"白名单长度"改为"实际可达数"（见 §4 验证岗发现项），但字段语义此前只散落在测试注释里，现集中写清：

| 字段 | 语义 | 口径 | 代码位置 |
|---|---|---|---|
| `commands` | **实际可达数** | 基座 16 条 + 已装配扩展切片（lab / collab / migrations / realtime）的命令数 | `electron/developer-service.cjs:586` |
| `declaredCommands` | **静态白名单长度** | `domain.listDeveloperCommands().length`，B7f 起固定 70 | `electron/developer-service.cjs:587` |

- `commands` 随装配结果变化：切片装配失败由 `main.cjs` 逐切片 try/catch 捕获，health 同口径给出 `degraded` / `degradedReason` / `extensions`，`commands` 随之下降。它**不是**"契约声明了多少条"。
- `declaredCommands` 不随运行时变化，只反映白名单契约本身，**不能**用来判断命令是否真的可用。
- 类型侧注释已同步到 `src/types/openarc-ipc.d.ts:484-500`（`OpenArcDeveloperCommand` 上方的开发者域注释块）。

**全仓消费者核查（本次 grep，排除 `node_modules` / `dist` / `artifacts` / `.git`）**：

```
$ grep -rn "declaredCommands" .
tests/dxos-developer-ipc.test.mjs:123,125                      （断言 70）
tests/dxos-developer.test.mjs:442,444                          （断言 70）
tests/dxos-developer-command-fusion.test.mjs:141,143,188,225   （断言 70）
electron/developer-service.cjs:587                             （字段定义）
docs/dxos-port/Dx-B7-RESULT.md:91                              （本文档 §6 第 8 条）
src/types/openarc-ipc.d.ts:498                                 （本次新增类型注释）

$ grep -rn "\.commands\b" src/                                 → 0 命中
$ grep -rn "commands:" src/                                      → 0 命中
```

**结论**：该语义变更只影响 `developer/health` 的返回值与 3 个守护测试文件里的断言（共 5 处 `assert.equal(..., 70)`），`src/`（界面）没有任何消费者，IPC 分发也不读这两个字段。故本次只补文档与类型注释，无需改动运行时代码。

---

## 10. 打包/分发链路验收 + 随包技能包与厂商路径机制（追加于 2026-10-14）

> 本节是追加说明，不改写 §1–§9 的历史结论。工作树 `dxos-port/r1`。

### 10.1 打包产物验收（真实 .app + 隔离 userData + CDP）

**既有链路（先读后写）**：

- `scripts/sync-app.mjs`：干净检出 ref → `npm run build` → 复制 `node_modules/electron/dist/Electron.app` 作底座 → 覆盖载荷 `Contents/Resources/app/{dist,electron,resources,package.json}` → 写 `openarc-build.json` → `codesign --force --deep --sign -`。**不下载 Electron**（用本仓 44.3.0 底座），同步/打包本身没有联网步骤。
- `scripts/oa-status.mjs`：只读多 worktree / 分支 / 脏标记 / `.app` 来源标记。

**约束与取舍**：本轮硬约束禁止运行 `npm run build` / `npm test`，故未直接跑 `sync-app.mjs`（其内部必跑 `npm run build`）。改用等价离线打包探针 `scripts/pack-app-offline.mjs`：**不构建**，直接用工作区既有 `dist/` + `electron/` + `resources/` 组装真实 `.app`（底座、plist 身份、载荷、来源标记、签名步骤与 sync-app 同构）。

**真实命令与关键输出**：

    $ node scripts/pack-app-offline.mjs --app "/tmp/oa-pack-offline/OpenArc OS Pack.app"
    [pack-app-offline] 新建 .app：.../node_modules/electron/dist/Electron.app → /tmp/oa-pack-offline/OpenArc OS Pack.app
    /tmp/oa-pack-offline/OpenArc OS Pack.app: replacing existing signature
    [pack-app-offline] ✅ /tmp/oa-pack-offline/OpenArc OS Pack.app
    [pack-app-offline] bundle=OpenArc OS Pack / com.openarc.os.pack / 载荷=openarc-os-pack / 新建=true / resources=true
    [pack-app-offline] 可执行=.../Contents/MacOS/Electron

    $ node experiments/dxos-e2e/run-all.mjs --app-path "/tmp/oa-pack-offline/OpenArc OS Pack.app"
    PASS [boot] B0 · 真实打包产物 ... 启动并暴露本机 CDP
    PASS [contract] C0 · window.openarc 顶层键恰为 25
    PASS [health] H4 · 登录后 12 条健康 / 只读命令全部 ok:true
    PASS [health] H5 · 第 9 条 */health（integration/plugins/health）:: {"ok":true,"plugins":9,"ms":241}
    PASS 103 / FAIL 0 / NOT_VERIFIED 1
    报告：artifacts/dxos-e2e/report-app.json

- 25 键与契约逐字一致：sync,navigate,action,browser,onNativeState,onDisplay,identity,authorization,device,resource,governance,model,mcp,canvas,task,agent,skill,media,sideEffect,files,automation,platform,developer,integration,market。
- **9 条 `*/health` 全部 ok:true**：agent / skill / media / automation / platform / developer / integration / market / integration/plugins（第 9 条单列 H5，避免改动契约矩阵锁死的通道顺序）；另有 protocol/mcp/canvas/task 四条等价只读基线也全 ok。
- 隔离 userData 与真实 profile：`/var/folders/.../oa-dxos-e2e-*`；`~/Library/Application Support/openarc-os-pack` 的 identity.db/-wal/-shm 前后 sha256 与顶层快照 0 变化；无残留进程；console error=0 / pageerror=0 / 非本地请求=0。
- 载荷内真实落盘 `resources/`：`Contents/Resources/app/resources/{bundled-skill-packages,market,vendor}`；并用**打包后的 skill-pack.cjs 自身**验证随包技能包可列出可导入（见 10.2）。
- 探针改动：`experiments/dxos-e2e/run-all.mjs` 新增 `--app-path` / `OA_DXOS_E2E_APP_PATH`；指向 `.app` 时派生其 `Contents/MacOS/<CFBundleExecutable>`，指向目录时按 `electron <dir>` 启动；不传时行为与既有 `electron .` 完全一致（回归 PASS 103 / FAIL 0）。
- 未执行项：真实 `scripts/sync-app.mjs`（硬约束）；`scripts/oa-status.mjs` 未复跑（只读工具，本轮无代码改动）。

### 10.2 随包技能包约定

新增 `resources/bundled-skill-packages/`：

- `README.md`：目录约定 / 两种包格式（标准包 skill.json+SKILL.md、Agent Skills 多 SKILL.md）/ 大小上限 / 扫描优先级 / "为什么只有自有内容"。
- `dxos-example-bundle/`：**自写**源目录（`SKILL.md`、`skill.json`、`references/notes.md`）。
- `dxos-example-bundle.zip`：由 `scripts/build-bundled-skill-packages.mjs` 从源目录生成，ZIP 内容位于包根。
- `scripts/build-bundled-skill-packages.mjs`：生成 / `--check` 校验，零第三方依赖、不执行包内文件。

**扫描优先级**（`electron/skill-pack.cjs` `bundledPackageDirs`，先命中者胜出）：

1. 显式注入 `bundledDir`；
2. 环境变量 `DX_BUNDLED_SKILL_PACKAGES_DIR` / `DX_BUNDLED_SKILL_PACKS_DIR`；
3. **`<应用根>/resources/bundled-skill-packages`（随包，优先扫描）**；
4. `<应用根>/electron/bundled-skill-packages`（历史兼容）。

**新增 API**：`listBundledSkillPackages` / `resolveBundledSkillPackage` / `readBundledSkillPackage` / `importBundledSkillPack`；`ensureBundledSkillPacks` 改为在全部候选目录中查找预置 spec 的 ZIP。空目录是**有效空态**；越界包名与非文件结构化拒绝；没有 SKILL.md 的包结构化拒绝（`NO_SKILL_FOUND`）。

**打包内验证**（用打包后的载荷模块自身，离线）：

    $ ls ".../Contents/Resources/app/resources/bundled-skill-packages"
    README.md  dxos-example-bundle/  dxos-example-bundle.zip
    $ node -e "加载 .../app/electron/skill-pack.cjs，configureSkillPack({userDataDir})"
    bundledPackageDirs: [".../app/resources/bundled-skill-packages",".../app/electron/bundled-skill-packages"]
    listBundledSkillPackages: [{"name":"dxos-example-bundle.zip","bytes":1588}]
    imported: {"name":"dxos example bundle","skillCount":1}

### 10.3 厂商路径约定与"为什么不入仓"

新增 `resources/vendor/README.md`。本仓**不随附**任何第三方二进制：

- 夸克 `quark-drive.cjs`（约 486 KB 官方 CLI）；
- 紫鸟 Python 运行时 / `server/ziniao/*.py` 及其运行环境。

**为什么不入仓**：版权、许可证与版本归厂商；复制进仓即等于把第三方内容随产品再分发，且升级/校验不可控。合规做法是按路径调用，缺失即结构化 `INTEGRATION_UNAVAILABLE`，绝不假成功、绝不静默下载。

**解析优先级**（`electron/integration-quark.cjs` / `electron/integration-ziniao.cjs`）：

1. 显式注入（`createPluginBundle({ quarkCliPath })` / `createQuarkIntegration({ cliPath })`；`createZiniaoIntegration({ runtimePath })`）；
2. 环境变量（`DX_QUARK_CLI_PATH` / `QUARK_DRIVE_CLI`；`DX_ZINIAO_RUNTIME` / `DX_ZINIAO_PYTHON`）；
3. `<userData>/dxos/vendor/`（夸克 `quark-drive.cjs`；紫鸟 `ziniao/`）；
4. `<应用根>/resources/vendor/`（同上）。

**校验与失败行为**：显式 / 环境变量必须是绝对路径且存在；越界（`..` 段）、相对路径、夸克非文件、紫鸟非文件非目录一律 `INTEGRATION_INVALID_INPUT`；全部缺失时，夸克的运行/登录与紫鸟的 `requireRuntime()` 返回 `INTEGRATION_UNAVAILABLE`，`detail` 列出上述四个放置位置。`status()` 新增 `cliSource` / `runtime` 字段如实报告来源。`plugin-service.cjs` 现向两者传 `userDataDir`；`scripts/sync-app.mjs` 现在会把 `resources/` 一起同步进 `.app`（否则打包后 `<appDir>/resources` 查找落空）。

### 10.4 本轮真实测试（离线）

    $ node --test tests/dxos-vendor-paths.test.mjs tests/dxos-skill-bundled-packages.test.mjs
    # pass 13 / # fail 0

    $ node --test <integration/plugin/skill/market 20 个测试文件 + 上两文件 + e2e-contract>
    # tests 255 / # pass 254 / # fail 1
    唯一失败：tests/dxos-skill-center.test.mjs「skillRunDisabledReason」——读 src/skills/skillCenterLogic.ts
    （本轮在途改动 +461 行，isMediaSkillKind 把 image 类 capability 判为可运行）与旧断言不一致，
    与本轮改动无关，未修（避免动 UI 在途代码）。

### 10.5 未完成 / 未验证

1. 真实 `npm run build` 打包链路（`scripts/sync-app.mjs`）未执行（硬约束）；本轮用等价离线组装验证。
2. 本机无真实厂商二进制，三种来源只以临时假文件验证解析；未跑真实 `quark-drive.cjs` / 紫鸟 Python。
3. `resources/vendor/` 默认空目录；未提供任何厂商文件（合规要求）。
4. 仅在 macOS 验证；Windows / Linux 未测。
5. 未做 git commit / push（硬约束）。

---

## 11. 合并完整性核对 + 两处一致性缺口收口（追加于 2026-10-14）

> 本节是**追加说明**，不改写 §1–§10 的历史结论。背景：两个并发改动都落在 `electron/provider-protocol-domain.cjs`、
> `electron/protocol-engine/legacy-executor-{images,media}.cjs`，各自跑绿但结果可能互相覆盖。硬约束：DX OS 只读、
> 不联网、不新增依赖、不 commit；只跑离线 `node --test`。

### 11.1 合并完整性核对（逐项取证）

**A. 端口白名单：B7e2 的 8 个 + CLI 3 个（核对时共 11）**
`electron/legacy-executor-ports.cjs:38-51` 的 `LEGACY_EXECUTOR_PORT_NAMES` 实测 8 + 3 = 11，未发生互相覆盖：
`generateAgnesImages / generateModelScopeImages / generateRunningHubImages / generateAgnesVideos / generateRunningHubVideos /
editAgnesImages / editModelScopeImages / editRunningHubImages` + `cliJimeng / cliCodex / cliGemini`。
（本次按 §11.3 又追加 `callRunningHubChat / describeRunningHubImage`，收口后为 **13**。）

**B. legacy 执行器的 cli:* / agnes / modelscope / runninghub 分支：一律"端口已注入则调用、未注入仍 LEGACY_DEPENDENCY_UNAVAILABLE"**
逐分支线下矩阵探针（先清空端口取一次、注册假端口再取一次），**20/20 PASS，ALL_OK=true**：

| 执行器 | 分支（源行号） | 未注入 | 注入后 |
|---|---|---|---|
| images | cli:jimeng(829) / cli:codex(834) / cli:gemini(839) / agnes(845) / modelscope(850) / runninghub(856) | LEGACY_DEPENDENCY_UNAVAILABLE | 调用注入端口 |
| media·视频 | cli:jimeng(743) / agnes(750) / runninghub(756) | LEGACY_DEPENDENCY_UNAVAILABLE | 调用注入端口 |
| media·编辑 | cli:jimeng(1547) / cli:codex(1552) / cli:gemini(1557) / agnes(1563) / modelscope(1568) / runninghub(1574) | LEGACY_DEPENDENCY_UNAVAILABLE | 调用注入端口 |
| chat | cli:codex / cli:gemini 对话 / 流式 / 图片理解（102/207/573 等） | LEGACY_DEPENDENCY_UNAVAILABLE | 调用注入端口 |
| chat | runninghub 对话(106) / 流式(211) / 图片理解(577)（本次新增） | LEGACY_DEPENDENCY_UNAVAILABLE | 调用注入端口 |

**C. provider-protocol-domain.cjs 的 execution 语义自洽；协议表仍 71（38+33）**
- `LEGACY_CONDITIONAL_EXECUTION` = cli:jimeng / cli:codex / cli:gemini / runninghub / modelscope / agnes；`LEGACY_UNAVAILABLE_EXECUTION` 收口后为空表（当前无"确实未实现"条目）。
- 可见 legacy 里 conditional 恰为 5 个（agnes 被 v2 同名遮蔽，不在可见表）；`shadowedLegacyProtocols()` 恰返回 agnes 一条，execution=conditional、reason 写明"启用插件 + 配置 Key"。
- `protocolTable()` 实测 `keys=71, model=38, provider=33, dup=0`，与 B2 交付一致（去重契约未动）。

**D. plugin-service.cjs：legacyPorts 与 cliPorts 并存，未互相覆盖**
- `electron/plugin-service.cjs:360-377`：`legacyPorts = setLegacyExecutorPorts({...运行期/ModelScope/Agnes...})`，`cliPorts = installLegacyCliPorts({...})`，两个结果都在返回对象（:796-797）。
- 二者写的是同一张模块级端口表（`legacy-executor-ports.cjs` 的 `ports.set`），**先注册插件端口、后注册 CLI 端口，都不 clear**。并存探针实测：先注册 10 个插件端口，再以假适配器注册 3 个 CLI 端口 → `merged count: 13`，插件端口、agnes 三项、runninghub 两个新端口、CLI 端口全部仍在。**未发现覆盖，无需修复。**

### 11.2 agnes 改判：unavailable → conditional

`plugin-agnes.cjs` 已实现并注册了 legacy 端口（`generateAgnesImages / editAgnesImages / generateAgnesVideos`，装配见 `plugin-service.cjs:366-368`），
因此 `provider-protocol-domain.cjs` 不再把 agnes 标为 unavailable，改为与 runninghub / modelscope 同语义：

- `execution: "conditional"`，`unavailableReason` = "需启用 agnes 插件并配置 Key（B7e3 可选插件，electron/plugin-agnes.cjs）；未启用时端口回 LEGACY_DEPENDENCY_UNAVAILABLE"；
- `LEGACY_UNAVAILABLE_EXECUTION` 清空（保留表结构，后续批次同规约登记）；
- 因 agnes 的 legacy 行仍被 v2 同名定义遮蔽，它不出现在可见 `items`，而是继续由 `shadowedLegacy` 附加清单如实暴露，只是 execution 从 unavailable 变为 conditional；
- 同步断言：`tests/dxos-protocol.test.mjs`、`tests/dxos-model-protocol-console.test.mjs` 的 shadowed agnes 断言改为 conditional + reason 文案。界面 `src/settings/modelProtocolLogic.ts` 对 conditional 的既有投影无需改动。

### 11.3 RunningHub 对话 / 图片理解端口（补上第四个维度）

此前协议表把 runninghub 标 conditional，但 `legacy-executor-chat.cjs` 的 `callChat / streamChat / describeImage` 对 runninghub 固定回
LEGACY_DEPENDENCY_UNAVAILABLE，而 `integration/runninghub/chat` 与 `integration/runninghub/describe-image` 已可用 —— 语义与实现不一致。本次补口：

- 白名单新增 `callRunningHubChat / describeRunningHubImage`（`legacy-executor-ports.cjs`），注入点 `plugin-service.cjs:360+`：
  插件方法返回 integration 形状 `{ ok:true, value }`，端口适配回 legacy 执行器约定（对话 `{ text, usage, latencyMs, raw }`、图片理解 string），失败原样透传；
- `legacy-executor-chat.cjs` 三个入口接端口：`callChat` 与 `streamChat` 复用 `callRunningHubChat`，`describeImage` 用 `describeRunningHubImage`；未注入仍结构化 LEGACY_DEPENDENCY_UNAVAILABLE；
- 未启用插件时 `gateLegacyPort` 返回结构化 `INTEGRATION_UNAVAILABLE`（默认关语义），不假成功；
- 至此 runninghub 的 **对话 / 图片 / 视频 / 图片编辑** 四个维度都满足 conditional。

### 11.4 本轮真实命令与输出（离线）

```
$ node --test tests/dxos-protocol*.test.mjs tests/dxos-integration-*.test.mjs tests/dxos-plugin*.test.mjs tests/dxos-model-protocol-console.test.mjs
1..249
# tests 249 / # pass 249 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0
```
（改动前基线 247/247；本次新增 2 条 runninghub 对话/图片理解端口用例。）

### 11.5 未完成 / 未验证

1. runninghub **模型目录**（`fetchModelCatalog`）仍如实报 `LEGACY_DEPENDENCY_UNAVAILABLE`，不在本次四维度补口范围；协议表 conditional 文案已限定为"对话 / 图片 / 视频 / 图片编辑"。
2. `chatWithTools`（带工具的对话）对 runninghub 未单列端口，沿用既有非 legacy 分支行为，未在本次改写。
3. 未做 git commit / push（硬约束）；未运行 `npm run build` / `npm test`（硬约束）。



