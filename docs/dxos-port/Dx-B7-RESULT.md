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

- `agnes.ts`（未移植；仅保留 3 个 legacy 端口名可注入；归属媒体协议批次）
- `developerOAuth.ts`（OUT：开发者 OAuth/PKCE 属排除项；manifest 的 oauth/oauthRedirect 一律拒绝）
- 领星：`lingxingBusinessAnalytics`、运营看板查询/导出、汇率
- 紫鸟：VC 行级导入（`importZiniaoVcFile`/`ziniaoVcRows`/`queryZiniaoVcData`）；`listZiniaoVcFiles` 已移植
- RunningHub：`callRunningHubChat`/`describeRunningHubImage`；AI 应用/工作流入口已实现但未暴露命令
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

