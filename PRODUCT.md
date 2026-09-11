# OpenArc OS 产品范围

## 产品定位

运行在 Windows/macOS 上的完整独立桌面系统，提供自己的登录、桌面、窗口、文件管理、应用中心、统一设置、用户权限和局域网协作。用户已明确选择依赖宿主操作系统的方向，不要求替代 Windows/macOS 或开发操作系统内核。产品必须围绕完整桌面工作环境设计，不能简化为聊天窗口加应用入口。

用户通过自然语言让 AI 操作已授权的应用、设置、插件和 MCP，查看执行进度、结果与失败原因，并随时停止后续操作。

## 已确认的 UI 与交互动效方向

用户于 2026-09-09 确认：整体沿用 Apple 半透明磨砂玻璃质感，组件与交互动效采用 https://ui.spectrumhq.in/ 所示方向。这是后续设计与开发的统一要求。

- 桌面、应用栏、窗口、菜单和通知统一使用背景模糊、细边框、柔和阴影与分层透明度；内容编辑区域保持清晰可读。
- 动效覆盖窗口打开与收起、应用栏悬停、菜单展开、页面切换和 AI 任务状态变化，保持轻巧、连贯。
- 规范贯穿登录页、桌面、应用中心、文件管理、全局 AI、Skill 市场和系统设置。
- 内置应用运行在 OpenArc 窗口内；Photoshop、Illustrator 保持原生窗口，由系统统一启动并通过已验证的连接操控。

当前仅记录风格方向，尚未完成视觉稿、组件选型或动效实现。

## 全局 AI 后端与统一模型设置

需求纠正：用户说的“内核 AI”是持续执行任务的后端助手框架，不是指定某个大模型。后续讨论与实现必须区分助手运行框架和模型供应商，不把模型推荐当成后端选型。

DeepSeek Harness 作为优先验证的后端候选，其官方资料说明模型、工具、技能、会话、存储和调度均可通过插件组合。它仍是开发者预览版，尚未在本项目安装或验证。参考：https://www.deepseek.com/harness/ 。对接时保留独立适配层，用户权限、团队隔离、设备执行和市场管理由 OpenArc OS 补齐，不能假定框架已提供。

设置中统一管理服务商、API 地址、密钥、自定义模型及连接测试，并按对话、图像、视频等能力设置默认模型。所有接入 OpenArc OS 的应用通过后端统一调用，继承当前用户有效配置，不要求逐应用重复填写。个人配置优先于获授权的团队默认配置；个人修改不影响其他成员。新任务采用新配置，运行中任务保留启动时配置。

密钥由后端或系统凭据库保管，不下发给应用插件。全局模型配置不替代 Adobe 登录、应用许可或 MCP 服务自身的独立授权；这些连接同样在设置中集中管理。自定义地址需匹配支持的协议，模型能力须验证，不能假定任意模型均能调用工具或生成图片。

## 应用、MCP 与 Skill

- 应用提供工作界面，例如浏览器、无限画布、文件管理和 Adobe 应用入口。
- MCP 为 AI 提供可调用的工具，例如读取选区、创建图层或操作画板；可用能力以连接后实际发现的工具为准。
- Skill 描述完成任务的方法和步骤，可以组合应用与 MCP。安装 Skill 不会自动获得应用许可、工具连接或设备权限。
- 插件提供额外界面或功能，单独管理安装、版本和启停状态。

Photoshop 和 Illustrator 作为本机外部应用连接、启动和操控。入口不会自动把 Adobe 窗口嵌入 OpenArc OS；具体操作需要应用安装、兼容版本与有效 MCP 连接。

## 本地资源库、组织与访问控制

OpenArc OS 首版正式加入 **Local Resource Library（资源库）**。它是本地知识与资产层，不是单纯素材库，统一管理用户主动纳入 OpenArc 的 Memory、文本/文档、图片、视频、音频、代码、Prompt、AI 生成产物、普通文件及后续扩展资源类型。

资源默认 **LOCAL FIRST**：没有用户明确行为或组织策略，不自动上传、不自动同步、不自动把资源发送到远程模型建立索引。Resource 使用稳定 `ResourceRef`，不能用文件名、绝对路径或显示名称充当对象身份。资源支持 MANAGED 与 LINKED 两种存储语义；删除默认进入 Trash，已有引用不得静默改指向同名资源。

资源库是正式桌面 App，用户可以添加、导入、拖拽、粘贴、预览、编辑、重命名、分类、Tag、收藏、删除、恢复和永久删除。固定分类至少包括 Memory、Documents、Images、Videos、Audio、Code、Prompts、Generated、Favorites、Recent、Trash 与自定义 Collection。Memory 同样是用户可查看、编辑和删除的 Resource，不建立用户不可见的隐藏永久记忆库。

组织权限首版区分 **Super Admin / Department Admin / User**。Super Admin 可创建、启用、禁用子用户，建立和管理 Department，指定 Department Admin，管理用户/部门/Collection/Resource/App 的访问权限，转移资源所有权并查看权限审计；但“管理全部权限”不等于读取用户密码、个人 API Key、OAuth Token、Adobe/MCP 原始凭据。Department Admin 只能管理本部门被授权范围，不能跨部门或给自己提权。

Resource Scope 至少包含 PERSONAL / DEPARTMENT / ORGANIZATION。授权默认 `DEFAULT DENY + ADDITIVE ALLOW`，逻辑动作至少覆盖 view/search/preview/read/create/edit/delete/restore/permanentDelete/download/export/share/tag/move/useByAgent/manageAccess。Agent 没有超级权限，`resource.useByAgent` 必须独立授权。

**App 也是资源授权主体。** 每个 App 通过稳定 `appId` 参与权限判断。用户有资源权限不代表 App 自动拥有权限；App 有权限也不能替代用户权限。资源访问的有效条件为：Session 有效 ∩ User 授权 ∩ App 授权 ∩ Resource Scope 授权 ∩ Department Policy 授权 ∩ Action 授权；Agent 场景再要求 `resource.useByAgent`。普通 App 通过 OpenArc Resource Picker 获取授权 ResourceRef，不能先拿到全量资源库再自行过滤；Browser 网页环境不能直接访问 Resource DB/API。

详细数据模型、WBS、Agent/App 权限、验收矩阵见 `docs/plans/LOCAL_RESOURCE_LIBRARY.md`。

## 首版范围

| 模块 | 首版内容 |
| --- | --- |
| 桌面 | 磨砂玻璃桌面、应用栏、多窗口、全局搜索、通知和设置 |
| AI 总控 | 模型配置、任务对话、工具执行记录、进度、失败提示、停止后续步骤 |
| 应用 | 浏览器与无限画布的基础工作界面；Adobe 外部应用入口和连接状态 |
| 资源库 | 本地 Memory/文档/图片/视频/音频/代码/Prompt/生成产物管理；分类、Collection、Tag、搜索、预览、Trash、ResourceRef 与 App/Agent 授权 |
| 组织与权限 | Super Admin、Department Admin、子用户、Department、Resource/App 权限、授权审计与所有权转移 |
| MCP | 添加连接、配置、连接测试、工具列表、启停、调用记录；明确本机或局域网执行设备 |
| Skill 市场 | 浏览、搜索、详情、安装、卸载与更新；首版使用受管理的技能目录 |
| 自定义 Skill | 创建、编辑、导入、导出、版本记录、回退、启停、试运行及依赖检查 |
| 局域网协作 | 用户登录、管理员与成员角色、设备在线状态、共享项目、任务分配、局域网 Skill 分享 |

Skill 详情展示名称、用途、作者、版本、步骤、所需 MCP/应用与权限。导入与导出包不包含密钥；团队共享时共享技能内容，不复制个人凭据。更新后保留旧版本以便回退。

## 账号与执行边界

Super Admin 管理组织级账号、Department、设备加入、团队资源、Resource/App 权限与共享技能；Department Admin 只能管理本部门被授权范围；普通成员只访问分配给自己的项目、资源、应用、工具与设备。个人技能与 Personal Resource 默认私有，用户可明确分享到部门或组织；团队资源由明确授权策略控制。

局域网服务负责身份、对象授权、项目和任务协调，各设备执行端负责调用本机应用与工具。任务执行前明确目标设备、用户身份、App Context 与所用账号；设备离线时保留可见状态，不默默切换设备。授权按用户、部门、Resource、App、设备和工具限制，安装或启用 Skill 不扩大权限。记录谁在何时、以哪个 App/Agent Context、在哪台设备访问或调用了什么资源/工具及执行结果。

Agent 与手工 UI 必须进入同一授权与领域命令层。Agent 不可直接扫描任意本地文件系统；资源检索先经过 Session、User、App、Resource/Department 授权，写入、编辑、删除、移动等副作用还必须进入后续 Tool Gate。

停止意味着不再发起后续步骤；已完成的应用操作能否撤销取决于应用能力，界面不得承诺统一回滚。

## 真实连接与演示

真实接入完成的标准是：在目标设备发现工具、执行至少一个实际应用操作并验证结果，且覆盖连接失败、权限不足和设备离线提示。仅有图标、配置表单或模拟结果不算接入完成；演示内容必须标注“演示”。

本轮只确定产品方案，尚无应用、账号、MCP 或 Skill 功能实现。

Adobe Illustrator 官方文档介绍了 Beta 内置 MCP，支持约 40 项工具动作：[Adobe 官方说明](https://helpx.adobe.com/in/illustrator/desktop/connect-with-other-apps-and-tools/about-using-ai-tools-with-illustrator.html)。Photoshop 可评估 [社区 MCP 实现](https://github.com/marcoz93/photoshop-mcp)，目前尚未实际验证连接。[魔搭 MCP 市场](https://modelscope.cn/mcp)可作为连接来源候选，但本轮未确认其中具体 Photoshop/Illustrator 条目。

## 后续扩展

公开 Skill 投稿与审核、市场付费、复杂审批、多组织管理、跨互联网协作、更多专业应用连接以及多人实时画布协作，放在首版基础流程验证后评估。Adobe 原生窗口嵌入不是首版承诺。

## 首版验收方向

两个局域网账号在授权设备上共享项目并分配任务；Super Admin 能建立 Department、子用户并分配 Resource/App 权限；无权用户、无权 App 与无 `resource.useByAgent` 的 Agent 均不能检索或读取对应资源；资源删除/恢复与 ResourceRef 引用可验证；AI 使用获授权 Resource 与真实 MCP 执行动作且结果可验证；用户可安装或自建 Skill、试运行、编辑、导出导入、启停和分享；无权调用、连接失败和设备离线均有明确反馈。界面原型验收与真实功能验收分别记录。
