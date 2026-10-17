# 缺口 ↔ 任务板覆盖核对（只读）

> 用途：核对 openarc-gap-list.json / VERIFY-PLAN.md 的缺口是否都有任务板归属。只读分析，未改产品代码；本文件不改任何任务状态。

## 0. 口径

- 缺口全集：`openarc-gap-list.json` 的 77 条（已实现 36 / 部分 34 / 缺失 6 / 不适用 1）。**只有 40 条非“已实现”需要任务归属**。
- 覆盖判定：任务描述明确包含该能力才算“有归属”；有归属 ≠ 已实现（任务状态另列）。
- 任务板数据：2026-10-17 21:2x 的 team_task_list + task_get 快照（task-1..24）。

## 1. 摘要

| 指标 | 数量 |
|---|---|
| 缺口总数 | 77 |
| 已实现（无需任务） | 36 |
| 不适用（产品决定） | 1 |
| 需任务归属（部分+缺失） | 40 |
| 其中：任务板有归属 | 13 |
| 其中：任务板无归属 | 27 |

## 2. 有任务归属的缺口（含任务状态）

| 缺口 | 状态 | 缺口一句话 | 归属任务（状态） | 判定 |
|---|---|---|---|---|
| A01 | 部分 | 画布以内置 React 岛屿（AI Studio）替代 dx-app 沙箱包，缺少运行时包安装/加载通路。 | task-19(completed) | 已关闭（待 task-13 复核） |
| A06 | 缺失 | 无 sync-sources 等价命令；批量从画布/文件夹来源入库未迁移。 | task-16(completed)、task-12(in_progress) | 在途 |
| A09 | 缺失 | 无邀请码/兑换命令，共享通过成员/角色直接授予。 | task-16(completed)、task-12(in_progress) | 在途 |
| A12 | 部分 | 有同进程房间/事件/补丁命令，但无网络传输层（DX 用 WebSocket，跨机需局域网服务）。 | task-8(pending)、task-15(completed) | 排期未开始 |
| A13 | 部分 | 有 package/export\|import（内联 ≤32MB）；DX 的 multipart 大包通道与 1GB 上限未等价。 | task-15(completed)、task-6(pending) | 排期未开始 |
| A16 | 缺失 | 无画布插件数据/网络命令；开发者域的网络白名单只覆盖 App 出网。 | task-16(completed)、task-12(in_progress) | 在途 |
| B06 | 部分 | 两域与传输中心已存在且可从访达进入；DX 的 dev-photocraft 等价物 image-studio 未注册为应用入口，appExchange 的 image.edit/receive target 可能不可达。 | task-19(completed)、task-24(pending) | 排期未开始 |
| B10 | 部分 | 扫描/曲目/歌词/封面写入有；DX 的 iTunes/Deezer 在线封面与 AI 整理后处理未逐项等价。 | task-14(completed)、task-5(pending) | 排期未开始 |
| C02 | 部分 | 本地 dx-app 安装/回滚/凭据/出网有；画布宿主式 dx-app 加载容器（DX DeveloperAppHost）未见等价入口。 | task-19(completed)、task-7(pending) | 排期未开始 |
| D02 | 缺失 | 无云端市场目录/审核/灰度；更新源是 GitHub Releases/ModelScope 仓库。 | task-19(completed)、task-24(pending)、task-7(pending) | 排期未开始 |
| D08 | 部分 | 5 条命令已移植；DX 的 dev-photocraft target 映射到 image-studio，但 image-studio 未注册为应用。 | task-19(completed)、task-24(pending) | 排期未开始 |
| F07 | 部分 | 桌面执行端与画布能力存在；客户端执行器集合/回传 observations 语义未核对（desktop-executor 为并行新增文件）。 | task-3(completed) | 已关闭（待 task-13 复核） |
| F08 | 部分 | 路由/回退代码存在；modelResolver 为并行新增（工作树未提交），能力依赖不可用问题由 task-3 收口中。 | task-3(completed) | 已关闭（待 task-13 复核） |

## 3. 无任务归属的缺口（需决策）

| 缺口 | 状态 | 缺口一句话 | 影响 |
|---|---|---|---|
| A02 | 部分 | 文档是 nodes/edges/viewport/logs，不是 Card 三槽；DX 旧画布/.dxcanvas 需转换层。 | 部分能力；验收按已知部分项记录 |
| A03 | 部分 | 命令层只有 10 类 card kind；DX 17 个 builtin.* 仅作清单校验数据，未进入画布运行期注册/执行。 | 部分能力；验收按已知部分项记录 |
| A07 | 部分 | upsert/update/delete 已有；DX 的 sourceNodeId 复制、封面 data URL、workflow 递归重写等复合语义未逐项核对。 | 部分能力；验收按已知部分项记录 |
| A10 | 部分 | 资产库仅 PRIVATE/ORGANIZATION 两档，无 publicAccess 与逐成员 ACL。 | 部分能力；验收按已知部分项记录 |
| A11 | 部分 | 画布侧未检出等价“文档引用即可见”放宽；媒体可见性主要走资源域授权，交叉边界未验证。 | 部分能力；验收按已知部分项记录 |
| A14 | 缺失 | 明确 OUT：无云同步/云备份（仅本机/局域网协作与在线更新，不涉画布云同步）。 | **产品 OUT（task-12 声明）→ 应改不适用**，见 §4/§6，不计入“待补任务” |
| A15 | 部分 | 清单/内置节点/模板校验已移植；运行期插件注册表与插件节点执行未迁移。 | 部分能力；验收按已知部分项记录 |
| A17 | 部分 | 有能力投影与 canvas/run/modelCall，但客户端工具集与 DX canvas_* 的语义/数量未对齐。 | 部分能力；验收按已知部分项记录 |
| A18 | 部分 | docx/xlsx 因缺 adm-zip/exceljs 依赖被显式标为不可用（仅文本/CSV 可用）。 | 部分能力；验收按已知部分项记录 |
| A20 | 部分 | 走 model/task 域 + protocol-engine，但 DX 的 protocol-tasks.db 固定三元组与 legacy Comfy/CLI 分支未逐项等价。 | 部分能力；验收按已知部分项记录 |
| A21 | 部分 | 本地公共媒体映射/归一有；独立音频抽取/裁剪命令缺失（仅在渲染计划内 atrim）。 | 部分能力；验收按已知部分项记录 |
| B02 | 部分 | 仅 public/department 两态共享判定；DX 的 canvas/asset-library 共享区判定未等价。 | 部分能力；验收按已知部分项记录 |
| B15 | 部分 | 媒体辅助模块存在，但无 Figma/Illustrator 应用入口，插件注册表也未登记这两个 MCP。 | 部分能力；验收按已知部分项记录 |
| B16 | 部分 | 本地公共媒体列出/URL/JPEG 归一有；DX 的远端抓取/上传语义未等价。 | 部分能力；验收按已知部分项记录 |
| C01 | 部分 | OpenArc 25 个应用（合并/新增/缺失见 appMatrix），不是 30 项一一对应。 | 部分能力；验收按已知部分项记录 |
| D09 | 部分 | 本地 catalog skillPacks 与导入逻辑存在；在线来源/授权与 DX 的 ModelScope 在线导入未逐项核对。 | 部分能力；验收按已知部分项记录 |
| E03 | 部分 | 作业/导入/恢复命令齐全，但依赖 python3+requests+selenium+openpyxl，缺依赖时结构化拒绝。 | 部分能力；验收按已知部分项记录 |
| F01 | 部分 | agent 域与任务控制台在 React 侧；Vue 壳层未检出 Jarvis 悬浮入口与 agent 桥调用。 | 部分能力；验收按已知部分项记录 |
| F03 | 部分 | 任务/项目域与 React 任务控制台存在；Vue 项目应用只接 resource 桥，Agent 入口待接。 | 部分能力；验收按已知部分项记录 |
| F04 | 部分 | App 清单可声明并投影 agent-tool，运行期 agent 入口与 DX 的 developer-app profile 未逐项对齐。 | 部分能力；验收按已知部分项记录 |
| F05 | 部分 | envelope/profile/准入分层存在；profile 集与能力边界是否 1:1 未逐项核对。 | 部分能力；验收按已知部分项记录 |
| F06 | 部分 | 工具目录与能力发现存在；7 类覆盖度与 schema 投影未逐条对齐。 | 部分能力；验收按已知部分项记录 |
| F10 | 部分 | 监督与检查点模块存在；深度/并行/每 Run 上限与 reviewer 门禁未逐项核对。 | 部分能力；验收按已知部分项记录 |
| F14 | 部分 | 本地配额账本（reserved→spent/released）存在；部门×平台规则/模型白名单与 DX 计量口径未逐项对齐。 | 部分能力；验收按已知部分项记录 |
| F15 | 部分 | 各域各自实现隔离；跨域统一口径未逐表核对（integration-service 实际是 Projects/Canvas 集成服务）。 | 部分能力；验收按已知部分项记录 |
| F16 | 部分 | 本地账号/绑定流程存在；是否等价“桌面壳自动超管会话 + 短期 secret”未核对。 | 部分能力；验收按已知部分项记录 |
| F17 | 缺失 | 无云账号/权益/兑换/席位链路（本地部署形态）。 | **待决策**：本地部署是否 OUT；若 OUT 改不适用，否则补任务 |

（注：27 条中 A14 已由 task-12 声明“产品 OUT”、F17 待决策是否 OUT；实际待补任务约 25 条。）

## 4. 状态漂移（gap list / VERIFY-PLAN 需刷新的点）

| 缺口/能力 | gap list 现状 | 当前工作树证据 | 对 task-13 的影响 |
|---|---|---|---|
| A06/A09/A16 | 缺失（20:47 快照） | 已实现：canvas-dxos-commands.cjs:50,67-70,72-73；task-16 completed、task-12 in_progress | 按 VERIFY-PLAN §0.3/S1-S3 判“必须通过”，不按旧缺口判 |
| A01/C02/D02/D08 | 部分/缺失 | task-19 completed：全部应用包加载路径 + 第三方目录/安装/回滚；cloud 审核/灰度仍未覆盖 | 包加载/第三方命令按已交付复核；D02 的“云市场审核/灰度”子项仍无归属 |
| F07/F08 | 部分（注明“task-3 收口中”） | task-3 completed：modelResolver + 桌面执行端 | 旧备注已过期，按“已交付待复核”处理 |
| A14 画布云同步 | 缺失 | task-12 描述明确“不碰云同步（产品 OUT）” | **应改“不适用”**，不是待补任务；VERIFY-PLAN M1 需同步改口径 |
| B09 本机代理 | 已实现（仅 detect） | task-17 completed（UI 代理/更新/缓存）；task-22 in_progress（后端 proxy/set 与 proxy/clear） | VERIFY-PLAN D9 只验 detect；若 task-22 合入，验收应加 set/clear 检查 |
| 访达共享盘/快照 | 映射无独立条目（VERIFY-PLAN 新增 D8） | task-16 completed（后端 platform/fs/shared*、snapshot）；task-23 in_progress（前端 UI） | 验证按 D8；映射建议补条目（否则 gap list 漏这项） |
| B10/B11/B12 增量 | 部分/已实现 | task-9/14/15 已完成本地能力；task-20 待多轨；在线封面/歌词仍未覆盖 | 验收按“本地通过、在线/多轨另列” |

## 5. 任务板有、映射无（盲区；task-13 范围会漏）

| 任务 | 任务范围 | 映射/gap 状态 | 建议 |
|---|---|---|---|
| task-5（pending） | 相册扩图/宫格切片；日历提醒/农历/AI 建日程；访达共享盘/部门盘/快照 UI | 映射无（相册扩图、日历能力、共享盘 UI 均未成条目；共享盘仅 VERIFY-PLAN D8 提及） | 补进映射或 task-13 单列“扩展项” |
| task-6（pending） | 视频多轨时间线与 Agent 粗剪；短剧素材登记/成片导出；画布打包/协作 UI | 映射仅 B12/B11/A13 部分提及；多轨与粗剪未成条目 | 同上 |
| task-7（pending） | 设置手动代理/更新/缓存；英文 i18n；小组件音乐/天气；窗口标签合并；市场第三方/全应用更新 | 映射无（i18n/标签/小组件未映射；代理仅 detect） | 补进映射或单列扩展项 |
| task-8（pending） | 局域网协作服务；任务双表 v29 合并 | 映射 A12 提及 LAN；任务表合并未映射 | 同上 |
| task-18（in_progress） | 英文 i18n（shell + 设置 + 应用名/菜单） | 映射无 | 扩展项 |
| task-20（pending） | 视频多轨 + Agent 粗剪 | 映射 B12 只写“已实现（ffmpeg 渲染）” | 扩展项，验收时区分单轨/多轨 |
| task-21（pending） | 窗口标签合并（tabGroupId） | 映射 C04 写“等价实现（壳层 8 模块）”，未含标签合并 | 扩展项 |
| task-22（in_progress） | 手动代理保存/清除、缓存清理、系统更新检查 | 映射无；VERIFY-PLAN D9/B09 仅 detect | 验收时若合入需加检查 |
| task-23（in_progress） | 共享盘 UI + 日历农历/提醒/AI 建日程 | 映射无（共享盘仅 VERIFY-PLAN D8） | 补进映射/扩展项 |
| task-24（pending） | 市场第三方列表/安装/回滚 + 全应用更新入口 | 映射 D02/D08 部分；UI 入口未映射 | 扩展项 |
| task-9/14/15/17/19（completed） | 短剧素材登记/成片导出、相册扩图/音乐库、画布打包/协作房间、设置代理/更新/缓存/小组件、市场第三方/包加载 | 仅在相应 gap 条目里部分体现 | 在 task-13 报告中按能力复核，不重开任务 |

## 6. 原待决策（已被 2026-10-17 决策取代，见 §8）

1. **27 条无任务归属的缺口**（见 §3；A14 应改“不适用”、F17 待决策 → 实际待补约 25 条）如何处理：补任务 / 明确 OUT / 接受为已知限制？按域分组见下：
   - 画布：A02 文档模型、A03 17 节点运行期、A07 复合语义、A10 逐成员 ACL、A11 媒体可见性放宽、A15 插件运行期、A17 canvas_* 工具集、A18 docx/xlsx、A20 协议三元组、A21 音频工具。
   - 媒体：B02 相册共享区、B15 Figma/Illustrator、B16 公共媒体远端、E03 紫鸟 Python 依赖。
   - 市场/开发者：D09 skill 在线来源。
   - AI/组织：F01、F03、F04、F05、F06、F10、F14、F15、F16。
2. **A14 云同步**：task-12 已把它标为“产品 OUT”，但 gap list 仍写“缺失”。是否改“不适用”（我只读不改，需你确认后由我或文档负责人在 task-13 时更新）？
3. **F17 云账号/权益/兑换/席位**：本地部署是否 OUT？若 OUT 改“不适用”，否则需补任务。
4. **任务板盲区 §5（10+ 项）**：是否补进映射/gap list？不补的话，task-13 若只按映射验收，这些扩展能力会漏检。
5. **task-13 输出名**：task 描述要求 `docs/dxos-rea/OPENARC-VERIFY.md`；我已在 VERIFY-PLAN 附录 C 对齐该名（建议执行时也产出证据台账 JSON）。

## 7. 限制

- 覆盖判定基于任务描述文本，不是代码/验收证据；任务描述可能未写全隐含范围（例如“应用包加载路径”是否含画布宿主容器，需 task-19 执行人确认）。
- 任务板状态是 2026-10-17 21:2x 快照；in_progress/pending 会变化，task-13 前需重新核对。
- gap list 写于 20:47，之后并行合入了多项改动（见 §4），本文件只标注漂移，不修改 gap list。
- 本文件只读：未改任务状态、未改产品代码、未运行应用。

## 8. 决策落地（2026-10-17，lead）

- **产品 OUT**：A14 画布云同步、F17 云账号/权益/兑换/席位、D02 云市场审核/灰度 → task-13 记“不适用”；gap list 已把 A14/F17 改为“不适用”、D02 改为“部分（第三方已实现，云审核/灰度 OUT）”。
- **无归属 27 条**：task-25 承接画布 10 条（A02/A03/A07/A10/A11/A15/A17/A18/A20/A21）、task-26 承接媒体/集成 5 条（B02/B15/B16/D09/E03）、task-27 承接 AI/组织 9 条（F01/F03/F04/F05/F06/F10/F14/F15/F16）；加 A14/F17 两条 OUT → **无归属缺口 = 0**。
- **gap list 已同步**：A06/A09/A16 → 已实现；当前 77 条 = 已实现 39 / 部分 35 / 缺失 0 / 不适用 3；items 增加 `ownerTasks`，`meta.decisions` 记录本次决策。
- **F01/F03 旧映射过期**：`src-vue/shell/AssistPanel.vue` 已落地并使用 task 桥（:15）；task-13 以构建产物为准，不得据旧映射直接报缺口。
- **任务板盲区**：task-5/6/7/8/18/20/21/22/23/24 各自覆盖；VERIFY-PLAN 已新增 §5.1 E1-E13 扩展能力检查项。
- **task-13 判定口径**（已写入 VERIFY-PLAN §7）：产品 OUT=不适用；task-25/26/27 与已知部分项只验“已实现/如实不可用”，未等价不判失败；扩展能力单列，任务 pending 不算失败。
