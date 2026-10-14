# Dx-UI-PLAN · DX OS 复刻的前端界面任务计划（OpenArc 设计语言）

> 规范版本：`DESIGN_SYSTEM.md`(21,061 B) / `MOTION_SYSTEM.md`(14,817 B) / `PLAN.md` 于基线提交 `128e21d` 冻结，本工作树内**零改动**（已用 `git status -- DESIGN_SYSTEM.md MOTION_SYSTEM.md PLAN.md src/design-system/` 核验为空）。
> 纪律：视觉零继承（不复制 DX OS 的配色、圆角、毛玻璃参数、图标、字体、文案、布局与交互模式）；tokens.css 不新增/不改写 token；功能对等、界面重做。

## 1. 规范来源（逐条可查）

| 主题 | 规范出处 |
|---|---|
| 设计原则与视觉身份、token 分层、颜色映射与使用边界、禁止发丝线框 | DESIGN_SYSTEM §1–§3.2 |
| 玻璃材质四级、字体字阶、空间密度、层级与焦点 | DESIGN_SYSTEM §4–§7 |
| 组件状态合同（18 类）、页面映射与 AI 可见信息、可访问性、交付与验收 | DESIGN_SYSTEM §8–§11 |
| 动效职责边界、token、统一中断规则、窗口/浮层/画布/通知与 AI 状态动效、减少动态、性能验证与验收 | MOTION_SYSTEM §1–§11 |
| 全局视觉与动效规范（含 Spectrum 映射、性能降级、焦点/缩放/中文长文本检查） | PLAN §4 |
| 设计语言与交互动效交付（DS-A01…A08 / MS-A01…A09） | PLAN §42 |

## 2. 可复用资产（位置固定，不得复制粘贴出新变体）

- **token**：`src/design-system/tokens.css`（颜色/字阶/间距/圆角/材质/动效 token；**本计划不改该文件**）
- **组件**：`src/design-system/primitives.tsx` — `Button / IconButton / TextField / SearchField / Tooltip / Badge / ScrollArea / Surface / ToastProvider / useToast / ToastViewport`
- **页面状态**：`src/design-system/page-states.tsx` — `PageState` + `PAGE_STATE_SPEC`（四类状态：加载 / 空 / 错误 / 就绪由调用点选择）
- **最接近的已确认基准（本仓内、已通过 D5-03 验收的同类管理页）**：`src/mcp/McpCenter.tsx`（连接列表 + 详情 + 能力表 + 日志；显式使用 primitives 与 PageState；渲染层只经 `window.openarc.*.command`，不发 userId/role/sessionRef，凭据只写不读）。**这是"已确认基准"而不是 D1-04 的像素基线**；像素/动效基线仍需按 §4 逐项实测截图与录屏。
- shell 装配方式：应用在 `src/main.tsx` 的 `apps` 数组注册，窗口内容在 `renderWindowContent` 的 `w?.appId === "<id>"` 分支渲染。

## 3. 本轮 UI 波的页面与状态

### UI-1 · Skill 中心（appId `skills`，当前为占位页"尚未实现"）

| 项 | 内容 |
|---|---|
| 受影响页面 | Skill 中心窗口（左侧分类导航 保留 市场/我的技能/已安装 三分类；右侧内容区由占位改为真实数据） |
| 数据源 | `window.openarc.skill.command`（B4 已交付 15 条命令：`skill/list|get|enable|disable|save|delete|run|analyze|pack/list|pack/install|pack/import|pack/export|pack/uninstall|workspace/list|health`）+ `skill.onEvent` 下行事件 |
| 必须覆盖的状态 | ① 加载中 ② 空（无技能/无技能包）③ 错误（命令被拒 / 会话失效 / 依赖缺失 `SKILL_DEPENDENCY_UNAVAILABLE`）④ 就绪（有数据）⑤ 运行中（`skill/run` 进行中，含流式/进度事件）⑥ 禁用态（技能 enabled=false 的呈现）⑦ 导入中/导入失败（ZIP 非法、路径越界）⑧ 容器窄宽（窗口缩到最窄时列表与详情不溢出） |
| 复用组件 | `PageState` + `PAGE_STATE_SPEC`（四态）、`Button/IconButton/TextField/SearchField/Tooltip/Badge/ScrollArea/Surface`、`ToastProvider/useToast`（导入/运行结果通知）；结构写法对齐 `src/mcp/McpCenter.tsx`（split-side / split-main 既有类名） |
| 实际复用 token | 全部取自 `tokens.css` 既有语义 token（`--fs-*`、`--surface-*`、`--line-*`、`--accent-*`、材质与动效 token）；**不得新增/改写 token** |
| 当前差异（起点） | `skills` 分支渲染 `empty-content` 占位（"尚未实现"徽标 + 说明），无任何数据绑定、无四态、无动效 |
| 动效要求 | 遵循 MOTION_SYSTEM：列表/详情切换、抽屉式详情、Toast 通知、`skill/run` 进行态使用统一的状态反馈（排队/执行/等待输入/成功/失败），不靠颜色单独传意；可中断、连点不叠加残影；尊重"减少动态效果" |
| 逐项验收 | ① 每类状态都有可复现路径与截图 ② 同主题/同窗口尺寸/同缩放/同背景与透明度下与基准（McpCenter）对照截图 ③ 动效用连续录屏核对触发/过程/终态/中断 ④ `npm run build` 通过、`npm run test:design-system` 通过、新增探针通过 ⑤ 不直连本机端口、不 fetch、不读凭据、不写 localStorage ⑥ 键盘焦点顺序与 Esc/Enter 行为可用 |

### 后续 UI 波（本轮先出计划，达成 UI-1 后按同一模板展开）

| 波次 | 页面 | 数据源 | 备注 |
|---|---|---|---|
| UI-2 | MCP 中心扩展（appId `mcp-center`） | `mcp:command` + 新增工具聚合投影 | 现有页已含连接/能力/日志；需补"已连接 server 的工具清单"与"调用受产品边界限制"的显式标注（不得给出调用入口，因为后端边界关闭） |
| UI-3 | 任务 / Agent 面（appId `projects` 内子视图或就地扩展） | `agent:command`（27 条，含 `agent/project/run`）+ `agent:event` | 任务 11 态、计划/步骤/检查点/交付物/事件流、Run 巡检；状态色与文案遵循 DESIGN_SYSTEM §8 与 MOTION_SYSTEM §7 |
| UI-4 | 组织治理扩展（appId `organization`） | `identity:command` 新增 14 条本地账号命令 | 部门/用户/APP 访问/审计；会员门禁已按 OUT 去除，界面不得出现"会员/权益"字样 |
| UI-5 | 模型与协议（appId `settings` 内既有 ModelSettings） | `model:command`（含协议表、能力 manifest、`model:event` 流式） | 已有页面，只补协议表/流式状态，不改既有视觉 |

## 4. 验收口径（每波必须全给）

1. 功能：命令面真实调用、每类状态可复现；`npm run build` exit 0。
2. 视觉：受影响页面/状态实机截图，同主题/窗口尺寸/缩放/背景与透明度下与基准对照。
3. 动效：连续录屏核对触发、过程、终态与中断。
4. 回归：`npm run test:design-system`、`npm run test:theme-baseline`（后者当前因探针自身键过时在基线上即失败，见 `Dx-B2-RESULT` §6.4，UI 波不得据此宣布通过或失败）。
5. 边界：渲染层不得直连本机端口、不得 fetch、不得读凭据、不得写 localStorage；不新增 token；不改布局与导航（保留既有 appId 与 dock 结构）。
