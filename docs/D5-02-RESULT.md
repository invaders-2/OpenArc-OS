# D5-02 · NOVAI 无限画布集成（唯一口径 · 2026-09-20）

**基线 \`fe6c9bf\`（完整 HEAD 核对一致、工作树干净）→ 代码提交 \`d875558\` → 门禁补断言提交 \`9b47463\`**；分支 \`feature/d4-03-tool-proxy\`；
未 push、未合并 main、未进入 D5-03；只操作本任务专用工作树（\`OpenArc OS-d4-01\`）与本任务实例，
其他工作区（含另一个正在运行的 OpenArc 实例）全程未触碰。

**NOVAI 源**：\`github.com/invaders-2/NOVAI-Infinite-Canvas\` @ **\`6ce1a64680b669b31c2ac3b32418b54decd404f2\`**。
只提取**无限画布**（画布编辑器页 + 其依赖），上游的 Python 后端、桌面壳、智能画布、素材库、提示词库、
ComfyUI / Midjourney / RunningHub / 即梦等**都没有进来**（见 \`public/novai-canvas/SOURCE.md\`）。

---

## 1. 集成决策（复用与接线位置）

| 问题 | 决定 |
| --- | --- |
| 哪些画布功能直接复用 | **画布本体全部复用**：节点/连线/拖拽/平移/缩放/框选/分组/复制/撤销/左右面板/底部缩放条/图片编辑/导出/自动保存，一律用上游 \`canvas.js\`+\`canvas.css\` 原样代码 |
| 怎么装进 OpenArc 应用窗口 | 应用 \`canvas\`（无限画布）窗口内容换成 \`src/canvas/CanvasHost.tsx\`：工具条（项目选择/新建/版本/只读/模型状态）+ **sandbox iframe**（\`sandbox="allow-scripts"\`，opaque origin），页面经自定义协议 \`openarc-canvas://\` 提供（只读白名单扩展名、无目录穿越、无 file://） |
| 项目数据/资源文件/保存恢复由谁管 | 画布文档由 OpenArc 存（\`canvas_boards\` 文档层，v17 迁移）；**不建第二套画布**：board 身份与资源引用沿用 D3-04D 的 \`canvas_boards\`/\`canvas_resource_nodes\`；资源文件仍由资源库（D3-04）持有，画布只存**稳定 ResourceRef**；上游原本的 \`/api/canvases*\` 全部由宿主接到 \`canvas:command\` |
| 现有模型调用从哪些入口发出 | 上游只有两处：\`POST /api/canvas-llm\`（文本）与 \`POST /api/canvas-image-tasks\`+\`GET /api/canvas-image-tasks/:id\`（图片任务）。两者都由 \`openarc-bridge.js\` 拦下 → 宿主 → \`model:command\`（\`canvas/chat\`、\`canvas/image\`）→ **OpenArc ModelService** |
| 哪些地方需要适配 OpenArc 身份/权限/任务 | ① 身份：宿主/主进程注入 sessionRef，画布**看不到** userId；② 权限：\`canvas-domain.evaluateCanvasAccess\` 一份规则（owner / 共享角色 / 组织可见 / 无授权），手工与 AI 两条路径共用；③ 任务：AI 编辑走受控工具 \`canvas.edit\`（审批 + plan 固定 revision + READ_AFTER_WRITE），与手工同一命令层 |
| 对上游代码的改动 | 只有两处注入（\`openarc-bridge.js\`、\`canvas.js\` 末尾适配层 + \`openarc-adapter.js\`），**没有重写任何画布逻辑**；路径改写与 i18n 清单收窄见 SOURCE.md |

---

## 2. 模型配置只有一个来源（§三）

* 画布**没有**密钥、服务地址、隐藏默认供应商：\`/api/config\` 由宿主用 OpenArc 已配置模型**合成**
  （\`chat_models\`/\`image_models\` + 能力 + 默认值；\`api_providers: []\`，**不含 baseUrl / 凭据 / credentialRef**）。
  门禁 C6b 直接断言投影里没有 provider、没有密钥字段。
* 用户只能在 OpenArc 已配置且**声明了对应能力**的模型里选。
* 凭据由主进程持有（\`credentialStore\` 内部解析），只用于最后一跳 HTTP；画布页面永远拿不到。
* 缺配置 / 能力不支持 / 权限不足一律**明确报错**，不静默改用别的服务。

| 能力 | 本轮状态 | 说明 |
| --- | --- | --- |
| 文本（chat） | ✅ 真实打通 | \`ModelService.chat\`（capability \`chat\`）；门禁 C6：provider 收到 OpenArc 的 Bearer 凭据与 remote model id |
| 图片（image-generation） | ✅ 真实打通（本轮新增传输） | 同一条 openai-compatible 协议新增 \`/images/generations\`（\`provider-adapter.generateImage\` + \`ModelService.generateImage\` + \`model:command canvas/image\`）。**没有新增供应商或付费服务**：只有用户已配置且模型能力包含 \`image-generation\` 时才会走到；能力不支持的模型在 \`resolveModel\` 就返回 \`CAPABILITY_UNAVAILABLE\`，绝不用文本接口顶替 |
| 视频（video-generation） | ❌ **缺项（明确报错）** | OpenArc 模型服务没有视频传输；画布的 \`/api/canvas-video\` 被宿主以 \`501 OPENARC_UNSUPPORTED\` 拒绝（门禁 C9），节点显示失败原因，不回落 |
| ComfyUI / Midjourney / RunningHub / 即梦 / 在线素材 | ❌ 范围外 | 属于上游其它产品能力，桥直接拒绝（\`501\`），UI 入口点击被拦截并提示 |
| 视觉输入（vision-input） | ⚠️ 未接入 | 域名里已声明该能力，但画布图片输入本轮只走文本提示（不假装支持） |

---

## 3. 真实产品路径（真实 \`electron .\` + 真实画布 + 本地确定性 provider）

门禁：\`node experiments/d5-02/canvas-e2e.mjs\`（**16/16 PASS，exit 0**，见 §5）。

| # | 交付要求 | 实测 |
| --- | --- | --- |
| C2 | 打开 NOVAI 画布，实际可见、可操作 | 宿主窗口 + \`openarc-canvas://bundle/index.html?id=…\` iframe；上游画布 \`#board\`/\`#nodes\` 渲染完成；命令适配器与宿主桥就绪（\`readOnly=false\`） |
| C4 | 创建并编辑一个真实画布项目 | 命令层 \`node.add ×2\` + \`edge.connect\` + \`node.move\` → 画布自动保存 → 存储里 2 节点 + 1 连线、坐标 520 一致、revision 前进（≥2） |
| C4b | 撤销与重做 | 真实命令入口：\`move\` 到 520 → \`undo\` 回 420（\`canRedo=true\`）→ \`redo\` 回 520，且结果重新落库 |
| C5 | 保存、关闭、重新打开：节点/连线/资源正确恢复 | 关窗 → 重开 → 画布状态 2 节点/1 连线，\`n_llm.x=520\` 一致（来自 OpenArc 存储，不是上游后端） |
| C6 | 从 OpenArc 模型配置选一个已有能力完成真实调用链 | LLM 节点 ▶（与 UI 同一入口）→ \`/api/canvas-llm\` → 宿主 → \`ModelService.chat\` → 本地 provider（**provider 侧看到 \`d502-chat\` 与 OpenArc 的 Bearer 凭据**）→ 文本回到节点（\`OPENARC-CANVAS-LLM:…\`） |
| C7 | 同上（图片能力） | generator 节点 ▶ → \`canvas/image\` → \`ModelService.generateImage\` → \`/v1/images/generations\` → 输出节点拿到 data URL 图片 |
| C8 | 失败、停止与预算状态如实展示 | provider 500 → 节点 \`runStatus=failed\` + \`runError\`（不假装成功）；停止是上游级联停止按钮（\`runNodeCascade\` 的 abort 路径），本轮未单独断言（见 §6） |
| C10 | 切账号后不能读取或修改另一账号的私有画布与资源 | admin 建的用户 B：列表不含 A 的画布、\`canvas/get\` 返回 \`NOT_FOUND\` |
| C11 | A28 只读成员（手工与 AI 同一规则） | 共享 VIEWER → B 打开同一画布：页面 \`readOnly=true\`；手工命令 \`READ_ONLY\`；保存 \`READ_ONLY\`；AI 命令 \`READ_ONLY\`；A 侧节点数前后一致（没有任何东西被改） |
| C3 | 画布页面不能获得原始 IPC / 文件任意访问 / 凭据读取 | iframe 里 \`window.openarc / require / process / ipcRenderer / fs\` 全部 \`undefined\`；白名单外端点 \`501 OPENARC_UNSUPPORTED\`；白名单端点经宿主返回（不能直连、不能出网：\`fetch\` 被桥接管） |

---

## 4. 范围与验收映射（PLAN D5-02 原始必需项）

| PLAN 要求 | 状态 | 证据 |
| --- | --- | --- |
| §7 无限画布支持拖拽、平移、缩放、内容块、连线、选择、撤销和保存 | ✅ 复用上游画布（本轮未重写） | C2（画布真实渲染）+ C4/C5（命令/保存/恢复）；拖拽/平移/缩放/框选是上游交互，随画布一同可用 |
| §7 内容块覆盖文本、图片、文件引用及 AI 生成结果，保留来源与任务关联 | ✅（文本/图片/AI 结果/文件引用） | C4（prompt/llm 节点、文本内容）、C6（AI 文本结果回节点）、C7（AI 图片结果回输出节点）、单测 A08（\`openarc-asset:<ResourceRef>\` 文件引用） |
| §7 保存采用版本检查；两人修改同一文档提示冲突并保留可恢复副本 | ✅ | 单测「保存走版本检查」+「A38 冲突」；上游 409 处理路径保留（宿主把冲突翻译回它认识的形状） |
| §7 重新打开后节点位置、连线和资源引用保持一致 | ✅ | C5；资源引用是稳定 ResourceRef（A08 单测：改名仍可用） |
| §22 左侧资源、中央画布、右侧属性、底部缩放 | ✅ | 上游画布自带这些区域（同一次渲染里可见，见 C2 与截图 artifacts/d5-02） |
| §22 只读禁用修改 | ✅ | C11（页面只读 + 手工/AI 两条路径都被拒） |
| §24 画布命令覆盖添加、编辑、移动、复制、删除、分组、连线、断开、撤销和重做 | ✅（命令层全覆盖） | \`canvas-domain.COMMANDS\` 10 条：单测覆盖 add/edit/move/copy/delete/group/connect/disconnect + 账本撤销；帧内撤销/重做由适配层提供（上游只有撤销，本轮补 redo 栈 + Cmd/Ctrl+Shift+Z） |
| §24 鼠标、快捷键与 AI 工具调用共用同一命令处理层，统一校验、版本检查和撤销记录 | ✅ | 同一 \`canvas-domain.applyCommand\` + 同一 \`canvas-service\` 版本检查 + 同一 \`canvas_commands\` 账本；单测「命令层」「AGENT 白名单」与工具测试（plan/execute/verify） |
| §24 AI 修改使用节点标识及基准版本，不能绕过只读权限直接改存储 | ✅ | 工具 \`canvas.edit\`：plan 里固定 \`revision\` + 命令指纹，execute 只用 plan；只读成员 plan 直接为 null、execute 拒绝（单测）；C11 产品路径 |
| §24 批量操作原子性 / 状态分别显示 | ⚠️ 部分 | 单条命令写入是单事务（\`transactSync\`）；**批量**（一次多条命令）本轮未做——AI 工具一次一条命令，画布多选批量是上游行为；生成任务/保存状态由上游 pending 卡片与宿主状态条分别显示 |
| 依赖行「共用命令层的画布 / 手动与 AI 修改遵守同一规则」 | ✅ | 同上；A28 两条路径同一规则 |
| **A08** 文件被画布引用：重命名引用仍可用；删除后明确不可用 | ✅ | 单测：\`openarc-asset:<ref>\` 稳定引用；改名后 \`AVAILABLE\`；删除后 \`UNAVAILABLE\`（节点保留 ref，不静默变空） |
| **A28** 画布只读成员：鼠标修改及 AI 修改两条路径均被同一权限规则拒绝 | ✅ | 单测（手工保存/AI 命令/撤销三路都 \`READ_ONLY\`）+ C11 产品路径 |
| **A38** 自然语言和手工操作并发修改同一画布节点，统一版本检查保留冲突信息与用户内容 | ✅ | 单测（AI 过期基准 → \`REVISION_CONFLICT\`，用户内容保留，重试成功）+ 工具测试（批准后用户先改 → execute 明确 \`knownNoEffect\`） |

**明确缺项（不冒充完成）**：
1. **视频生成**：OpenArc 模型服务没有视频传输，画布视频节点明确失败（\`501\`）；不新增供应商或付费服务。
2. **批量命令的原子提交**：域层只保证单条命令的原子性；一次提交多条命令的 all-or-nothing 未实现。
3. **停止/预算的细粒度断言**：级联停止是上游行为，本轮只断言了失败如实展示；"按预算截停"属于 D4 任务层（\`test:d5-01-control\` 已覆盖任务预算，不在画布路径上）。
4. **视觉输入（vision-input）**：画布不解析图片内容喂给模型。
5. **多组织共享 / 团队实时协作**：PLAN 已声明实时协作为后续扩展；本轮只有 owner + 共享角色（VIEWER/CONTRIBUTOR/EDITOR）+ 组织可见三档。

---

## 5. 干净导出树单轮结果（不拼接）

\`\`\`
git archive d875558 → /tmp/oa-d502-clean（软链 node_modules）
+ experiments/d5-02/canvas-e2e.mjs 取自 9b47463（sha256 3c2f9f5199d6af5a…，与提交内容一致；其余文件与 d875558 逐字相同）
\`\`\`

| # | 门禁 | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- | --- |
| G0 | 构建（tsc + vite） | \`npm run build\` | 通过 | 0 |
| G1 | D5-02 单测 | \`node --test tests/d5-02-canvas-service.test.mjs tests/d5-02-canvas-tool.test.mjs\` | 12 PASS / 0 FAIL | 0 |
| G2 | **D5-02 真实产品门禁** | \`node experiments/d5-02/canvas-e2e.mjs\` | **16 PASS / 0 FAIL** | **0** |
| G3 | D5-01 基础门禁（回归） | \`npm run test:d5-01\` | 64 PASS / 0 FAIL / 1 NOT VERIFIED | 0 |
| G4 | 受控浏览器产品链门禁（回归） | \`npm run test:d5-01-control\` | 46 PASS / 0 FAIL / 2 NOT VERIFIED | 0 |
| G5 | 完整可见性门禁（回归） | \`npm run test:d5-01-visibility\` | 25 PASS / 0 FAIL / 1 NOT VERIFIED | 0 |
| G6 | 受影响单测（schema/identity/授权/浏览器） | \`node --test tests/device-migration.test.mjs tests/identity-store.test.mjs tests/d5-01-browser-*.test.mjs\` | 65 PASS / 0 FAIL | 0 |

证据：\`artifacts/d5-02/d5-02-canvas-e2e.json\`（15 条逐项）+ 单测输出；回归门禁 JSON 沿用 \`artifacts/d5-01/\`。
