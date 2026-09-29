# D5-03 第六批 · App 授权组织隔离（含安全修复）+ 登录错误行不透明内容底

状态：**已实现并完成真机（Electron）验收** —— 2026-09-28 串行重跑：安装重置门禁 **26/26**、center **38/38**、stream **29/29**、policy **43/43**（R3 登记表 4 → 5 项后）、视觉 / 布局 / 焦点 / 动效矩阵门禁 **43/43**（10 格 × 2 面全部 ≥4.5:1），**全部 exit 0**；`d4-04-closure2` **9/9**；全量 `npm test` **1363/1365**（两条既有失败与本批无关，见 §9.3）。

* **判定：D5-03 第六批 = PASS（限定范围）；D5-03 整体仍 = PARTIAL**（剩余缺口见 §10）。
* 被测内容 = 提交 **`d1ba058`**（产品修复）+ **`2944e45`**（门禁脚本与报告，只改 `experiments/`）；**artifact 记录的 `testedCommit` = `d1ba058bdfb6b7d7cdb0d9e2c4115317a74adf7b`**（本批全部 artifact 同值）—— 逐条披露见 §1。
* 真机报告：`experiments/d5-03/D5-03-BATCH6-MATRIX-REPORT.md`；tracked 证据：`docs/D5-03-GATE-EVIDENCE.json` 的 `batch6` 段；证据根：`artifacts/d5-03/runs/<runId>/`。
* 被测工作区：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`）。未 push、未合并 main、未切分支。
* 规范版本：`DESIGN_SYSTEM.md` 第 3 行「设计提案 0.2，2026-09-10」；`MOTION_SYSTEM.md` 第 3 行「动效提案 0.1，2026-09-10」。

## 1. 被测内容、提交链与证据口径披露

| 项 | 值 |
| --- | --- |
| 分支 | `integration/ui-core` |
| 产品修复（被测提交） | `d1ba058`：**27 个文件** = 7 个 `electron/*.cjs`（`authorization-store` / `authorization-domain` / `authorization-service` / `governance-service` / `model-service` / `mcp-service` / `identity-store`（**仅注释**））+ `src/styles.css` + 2 个 `experiments/` 旧单参调用修正 + 17 个 `tests/` 测试/夹具文件（含 2 个新增）；`+833 / −83` |
| 门禁脚本与报告（HEAD） | `2944e45`：**9 个文件，全部在 `experiments/d5-03/`**（新增 `auth-error-css-audit.cjs` / `auth-error-matrix.cjs` / `batch6-gate-rebase-proof.mjs` / `batch6-matrix-diag.mjs` / `batch6-matrix-diag2.mjs` / `batch6-r3-rebase-proof.mjs` + 报告；改 `auth-error-visual.mjs` / `mcp-policy-e2e.mjs`），`+1897 / −16` |
| 提交链 | `d4a3516`（第五批文档定稿）→ **`d1ba058`（产品修复 = 被测内容）** → **`2944e45`（本批门禁脚本与报告 = 交付 HEAD）**；`2944e45` 的父提交就是 `d1ba058`，`git diff d1ba058 2944e45 --stat` = **只改 `experiments/` 9 个文件、产品代码零改动** |
| artifact 记录的 testedCommit | `d1ba058bdfb6b7d7cdb0d9e2c4115317a74adf7b`（本次会话新增的 20 个索引 run 全部同值） |
| **区分（如实披露，不含糊）** | 真机运行发生在**门禁脚本改动已写入工作树、尚未提交**时：两个 policy artifact 分别记 `gitDirtyLines=6`（`20260928T091621Z-74ec`，R3 重基线前）与 `8`（`20260928T095113Z-2780`，重基线后）；随后这些 `experiments/` 改动才提交成 `2944e45`。所以「产品修复 = `d1ba058`」「门禁脚本/报告 = `2944e45`」与 artifact 的 `testedCommit=d1ba058` 不矛盾。**不写成「测试提交 = 2944e45」，也不写成「产品修复与测试无关」。** |
| 汇总 JSON | **本批没有机器可读汇总 JSON**：当前有效证据 = 真机报告 §6 的 runId / sha256 表 + `artifacts/d5-03/runs/index.json` + 各 run 的 artifact；第五批的 `d5-03-batch5-summary.json` 与本批无关。 |
| 索引完整性（本岗复核） | `index.json` **64 条**、`index.jsonl` **64 行**（只追加）；64 个 artifact 逐条重算 sha256 = **64 一致 / 0 不一致 / 0 缺失**，旁挂 `.sha256` **64/64 一致**，`runId` 无重复。会话前 44 条 + 本次会话 20 条 = 64。 |
| **口径差异（如实登记，报告原文不改）** | 报告 §8 记「索引 61 条」「`index.jsonl` 60 行」；本岗复核 = **64 条 / 64 行**，以复核值为准（报告同时写「会话前已有的 44 个 run 目录」，44 + 20 = 64 与复核一致）。 |
| 未入索引的目录（如实登记） | 会话新增目录共 **22 个** = 20 个入索引 + **`20260928T084553Z-f364-auth-error-visual`**（报告 §6.3 已登记：冒烟中止、未 finalize、只有 `visual/` 截图）+ **`20260928T092533Z-cf4e-batch6-r3-rebase-proof`**（**空目录，报告未登记** —— 本岗如实登记，不含任何 artifact，不影响任何判定）。 |
| 工装迭代轮次（如实登记） | `auth-error-visual` 本会话除正式轮 `c729`（43/43）外另有 6 轮：`5720` 26/31、`0bde` 26/32、`f1b8` 38/41、`6234` 38/43、**`fcfa` 39/40（报告 §6.3 未列，本岗补登）**、`8fcf` 41/43，全部留在 runs/ 与索引里。 |
| 边界 | 不连真实第三方、不发用户数据、不运行任意第三方程序；不声称插件隔离通过（D5-08）；工具调用入口仍 `MCP_TOOL_INVOCATION_NOT_ENABLED`；协议仍 `2025-06-18`；**本批未新增「创建组织」入口**；串行（同一时刻只有一个 Electron）、独立 runId 目录、独占 CDP 端口、只清自己的 pid 树（`pkillUsed=false`、`leftovers: []`）。 |

## 2. 决策一：App 授权取数层改为按 `(app_id, organization_id)`，组织缺失 fail-closed

背景（第四批登记、第五批实测的**安全漏洞**）：`app_resource_grants` 的取数 `appGrantsForApp(app_id)` **只按 `app_id` 过滤、完全不看 `organization_id`**；判权 `evaluateAppAuthorization` 只比对 `grant.app_id` + 目标覆盖，没有任何组织判断；MCP 域更把空组织行当通配（`!g.organization_id || g.organization_id === actor.organizationId`）。后果：**指向别的组织（甚至已删除组织）的同形 grant 能让本组织已撤销的权限复活**（第五批 T5/T5b 实测：孤儿行 → ALLOW，删行 → DENY）。

* `electron/authorization-store.cjs:80`：`appGrantsForApp` SQL 由 `WHERE app_id = ?` 改为 **`WHERE app_id = ? AND organization_id = ?`**。
* `electron/authorization-store.cjs:478`：`appGrantsForApp(appId, organizationId)` —— **组织是必需输入**：`organizationId == null` 或空串时**直接返回空集**（`if (!organization) return []`），绝不退化成「只按 app_id」的全表取数。这是 fail-closed：拿不到组织 = 一行都不给，而不是不过滤。
* **三处漏掉的调用点补组织**（这是漏洞的根因面，逐个可核）：
  * 通用判权主路径 `electron/authorization-service.cjs:114`：`appGrantsForApp(app.appId, user.team_id)`；
  * 模型域 `electron/model-service.cjs:27`：`appGrantsForApp(appId, actor.organizationId)`；
  * MCP 域 `electron/mcp-service.cjs:91`：`appGrantsForApp(appId, actor.organizationId)`，并**删掉 `!g.organization_id` 这个把空组织当跨组织通配的分支**（全仓复核：`grep -rn "!g.organization_id" electron/ src/` = **0 命中**）。
* **治理面行为逐行不变**（`electron/governance-service.cjs:294 / :312 / :337`）：原来就是 `appGrantsForApp(appId).filter((g) => g.organization_id === gate.organizationId)`，本批只把组织补进取数、**那个显式过滤原样保留**，所以过滤结果逐行相同（O9 有行为级对照）。
* **产品语义只改「看哪些行」**：本组织内的播种 / 撤权 / 正式重授 / scope 与资源覆盖 / `User ∩ App ∩ Scope` 交集一律不动；`SCHEMA_VERSION` **仍 21**。

## 3. 决策二：判权层纵深防御（取数层过滤之外再挡一道）

* `electron/authorization-domain.cjs:554` `evaluateAppAuthorization({ resource, app, grants, organizationId })`：
  * `organizationId` 为空/缺失 → **一行都不放行**（`:566` `if (!organization) return result;`，返回默认 DENY）；
  * 逐条 `:568` `if (String(grant.organization_id ?? "") !== organization) continue;` —— **异组织行一律跳过**，`organization_id = ''` 的历史无主行**不是通配**。
* 组织在同一份判定里只传一次、三处调用点全补（本岗按当前源码复核）：
  * `authorization-domain.cjs:606`（`evaluatePolicy` 内部调用 `evaluateAppAuthorization`）；
  * `authorization-service.cjs:153` 与 `:998`（两个 `evaluatePolicy` 调用点，都传 `organizationId: prepared.organizationId`）；
  * `authorization-service.cjs:336`（`evaluateAppAuthorization` 的另一个直接调用点，同样补传）。
* **为什么要两道**：取数层过滤保护的是「本次取数」，判权纯函数保护的是「将来有人把全表喂进来」——例如新增调用点又用了不带组织的取数、或旁路直接调用纯函数。O7 就是按这个形态立据：**把全表直接喂进纯函数，异组织行与空组织行都不放行**（不经 store）。

## 4. 决策三：期望值订正**仅 2 处**（逐字披露）+ 其余 16 个测试/夹具文件的性质

**唯一被改期望值的文件 = `tests/d5-03-reset-authorization-consistency.test.mjs`，仅 T5 / T5b 两处**（第五批留下的旧期望正是**本轮要修的漏洞**，不订正就会「测出漏洞算通过」）：

| 用例 | 旧期望（第五批当时的事实） | 新期望（本批，逐字） | 补的阳性对照 |
| --- | --- | --- | --- |
| T5 | 往**不存在的组织** id 写同形 grant → **ALLOW**，`allowSources` 含 `APP_GRANT` | **DENY + `APP_ACTION_NOT_GRANTED` + `allowSources` 不含 `APP_GRANT`** | 同形授予**落在本组织** → **ALLOW** |
| T5b | 同上（产品级后果：种回旧组织残留行 → 撤销失效 → ALLOW） | 同上（DENY） | **本组织撤销 → DENY**（撤销本身仍生效） |

* **除这 2 处外，其它测试文件一个产品语义都没有放宽**：其余 **16 个** `tests/` 测试/夹具文件（含 3 个探针 fixture）只是「夹具/读取口径补组织」或「改用全表语义」，且每处都写明理由；**无兼容后门**（`appGrantsForApp` 没有任何「不传组织就走全表」的兜底分支：`:480-481` 空组织直接 `return []`）。
* 两个新增测试文件（本批的新证据）：`tests/d5-03-app-grant-org-isolation.test.mjs`（§5）、`tests/d5-03-auth-error-contrast.test.mjs`（§6）。
* **收尾两处旧单参调用修正（逐字披露）**：
  * `experiments/d3-04d/02-picker.mjs:24`：取 fixture 管理员会话的组织（`f.orgId = admin.team_id`）——注释写明「漏传组织会 fail-closed 返空集，撤销循环会空转成什么都没撤」；
  * `experiments/d5-03/mcp-policy-legacy-v20-driver.cjs:31`：**明确改用全表语义** `allAppGrants()` 并写明理由（L1 证的是「整库再没有 mcp-center 的 mcp 行」，要能抓到「行落到别的组织/无主行」这种形态，按组织取反而会漏）。
* `electron/identity-store.cjs` 的重置注释同步当前事实（**仅注释**）：**证明方式** = 剥掉块注释后两版逐字节相同（剥 `/* */` 后 old == new，**True**），且 diff 的 **12 增 7 删全部是注释行**（本岗复核）。
* `SCHEMA_VERSION` **仍 21**。

## 5. 证据：`tests/d5-03-app-grant-org-isolation.test.mjs`（O1–O9，**9/9**）与先红后绿 2×2

同一库里构造 **A / B 两个真实组织**（node 层允许；真机没有第二个组织入口 —— 见 §10），两组织各自的 resource / model / mcp baseline 都**按产品播种路径**写入（不是手写行）：

| 用例 | 内容 |
| --- | --- |
| O1 | 取数按 `(app, organization)`：每个组织只看到自己的行；**空/缺失组织退化为空集**（含 `organization_id=''` 的行不得出现在任何真实组织的取数里） |
| O2 | 通用资源域：A 获权 / 撤权都不改变 B（B 无自己的 grant 时始终 DENY） |
| O3 | 模型域：A / B 各自的 canvas `model.use` 互不影响（获权与撤权都不越界） |
| O4 | MCP 域：A 的 mcp-center 授权不改变 B；B 撤权不影响 A（**原 `!g.organization_id` 通配分支已删**） |
| O5 | **异组织同形行不能使 B 已撤销的权限复活**（资源 / 模型 / MCP 三域各一条 —— 这是本批要修的核心漏洞） |
| O6 | `organization_id = ''` 的行**不构成通配**：三域都不得放行任何真实组织（**+ 阳性对照**） |
| O7 | **判权层纵深防御**：把**全表**喂进纯函数，异组织行与空组织行都不放行 |
| O8 | 本组织行为不变：A / B 各 **15 对**播种、唯一键含组织、撤权与正式重授权互不影响 |
| O9 | 治理视图**逐行不变**：行集合与字段 == 旧实现（全表 + 按组织过滤）的逐行结果 |

**先红后绿 2×2（本批改动前实测，逐字记录在 `d1ba058` 的提交信息里）**：全还原 **7 fail**、只恢复判权层 **5 fail**（证明模型 / MCP 两域**不走**判权层，只走取数层）、只恢复取数层 **1 fail**（只有「全表喂纯函数」那条需要判权层）。**本岗未复跑该 2×2**（复跑需要临时还原产品代码，超出本交付「只改文档」的边界），数值引自产品提交信息与第六批实施记录。

## 6. 决策四：`.auth-error` 不透明内容底 + **规范例外集中登记**

背景（第五批真机实测，runId `20260928T070627Z-27eb`，**16/17，唯一 FAIL**）：浅色主题 + 初始化向导的玻璃卡（`full` 档）浮在默认深色壁纸上时，`.auth-error` 的**合成背景**实测 `rgb(181,181,181)`，文字 `--failed` = `rgb(215,0,21)` → **2.62:1 < 4.5:1**（12px/400 = 普通文本，`DESIGN_SYSTEM.md:248`）。同一 `--failed` 落在浅色**窗口面**上实测 5.19:1 → 失败来自「错误行自己没有底」，不是文字色本身。

* `src/styles.css:2471` 的 `.auth-error` 规则体新增 **`background: rgb(var(--content-rgb) / 1)`**（alpha 字面为 1），并沿用既有圆角 / 内边距 token `--radius-md` + `--space-2` / `--space-3`；保留错误文字、`role="alert"`、`--failed` 色、`:empty` 不渲染、12px/400；**未改任何全局状态色或 token**（`--failed-rgb` 浅 `215 0 21` / 深 `255 69 58` 仍在 `tokens.css` 原样）。
* 效果：该行的合成背景与**壁纸、玻璃档解耦**，只随主题变 —— 浅 `rgb(255,255,255)`、深 `rgb(23,23,23)`、深色实色档 `rgb(14,14,14)`（`.dark[data-glass="solid"]` 覆写 `--content-rgb`，`tokens.css:283-284`）。它不再是「压过门槛」的运气，而是结构性成立。
* 静态契约 `tests/d5-03-auth-error-contrast.test.mjs`（C1–C5，**5/5**）：C1 只有一条规则且仍用 `--failed` 当文字色；C2 必须有不透明底（通道来自 token、alpha 字面为 1、不得引用 `--content-alpha` / `--surface-alpha`、不得回退半透明）；C3 全局状态色未动；C4 底 × `--failed` 在浅/深 × full/reduced/solid 三档都 ≥4.5:1（真 token 值现算）；C5 三个 DOM 入口仍挂 `role="alert"`、挂 `.auth-error` 的元素没有新增。含反向自证：改半透明底 / 改深色红 / 退回无底三种变异都被抓住。
* 真机复测（runId `20260928T094556Z-c729`，**43/43，exit 0**）：**10 格矩阵 × 2 面全部 ≥4.5:1**，每格底 = **该行自身 token 底**；浅 **5.372**、深 **5.261**、深色实色 **5.665**；四个第五批基准点对照：**2.620 → 5.372、5.192 → 5.372、5.310 → 5.261、5.159 → 5.261**；**登录页两条错误行首次量到对比度**（各 5.372）。布局 / 焦点 / 动效全绿（行高 36.40 ≥ line-height 20.40；无错误行时整段不在 DOM；出现后 `.auth-actions` 下移 48.4px = 行高 + margin；8 组缩放 × 长文案无溢出；焦点环 2px + offset 2px 与错误行不相交，输入框按产品设计不用焦点环已留档）。

### 6.1 规范例外集中登记（`AGENTS.md` + `DESIGN_SYSTEM.md:262` 要求）

`DESIGN_SYSTEM.md:262`：「组件例外集中登记，不让页面局部修补成为默认规范。」按此把本批的组件级例外登记如下：

| 项 | 内容 |
| --- | --- |
| **例外对象** | `.auth-error` 的**不透明内容底** `background: rgb(var(--content-rgb) / 1)`（`src/styles.css:2471-2478`） |
| **原因** | 该行浮在玻璃卡上、玻璃卡又压在壁纸上，合成背景随壁纸与玻璃档浮动（浅色 full + 深壁纸实测 `181,181,181` → `--failed` 只有 2.62:1）。给该行一个**自己的**不透明内容面，让合成背景只随主题变 |
| **影响状态** | **4 个状态 / 3 个 DOM 入口**：登录页与初始化向导（同一组件 `src/identity/AuthScreens.tsx:99`，两种状态）、设置页（`src/main.tsx:2887`）、头像选择（`src/identity/AvatarPicker.tsx:130`） |
| **复用的 token** | `--content-rgb`（浅 `255 255 255` / 深 `23 23 23` / 深实色 `14 14 14`）、`--radius-md`、`--space-2` / `--space-3` —— **不新增 token、不写字面色值、不复用 `--content-alpha` / `--surface-alpha`（半透明档会重新被壁纸拖低）** |
| **证据** | 真机矩阵门禁 `auth-error-visual` **43/43 · exit 0**（runId `20260928T094556Z-c729`，sha256 `1e87ced41e3b9c453e206d2b63e44290e244f06d8dcbe50fd27a9340778ca86b`）+ 五条静态断言 C1–C5（`tests/d5-03-auth-error-contrast.test.mjs` 5/5） |
| **取舍（如实记录）** | `DESIGN_SYSTEM.md:33` 的口径是「透明度降低、高对比和密度模式同样通过映射覆盖，**避免各页单独修补**」。本批按工单边界做的是**组件级局部修补**（只动 `.auth-error` 一条规则），没有在规范层新增「浮在可变背景上的文本行」这一材质档 / 语义 token。代价：将来若有**别的**浮在可变背景上的文本行出现同样问题，需要各自再处理一次；**token 级 / 映射级解法留给后续**（见 §10 残留）。 |

## 7. 决策五：门禁假阳性修正（逐字披露 + 先红后绿）与 R3 登记表 4 → 5

### 7.1 假阳性①：`.auth-error` 规则体由**行号硬切**改为**按选择器提取**

* **旧口径（逐字）**：读 `src/styles.css` 全文后 `.split("\n").slice(2464, 2472).join("\n")`，再断言「该切片不含 `transition|animation`」。
* **为什么是假阳性**：第六批把规则体从 2465 挪到 **2471–2478**，切片固定取第 2465–2472 行 → 实际只覆盖「5 行注释 + 空行 + `.auth-error {` + `margin-top`」，**6 条声明里只看得到 1 条**，「不含动效」于是**恒真**（半空断言）。第五批看着正常只是运气（规则体正好落在切片里）。
* **新口径**：新增 `experiments/d5-03/auth-error-css-audit.cjs`，按**选择器**提取规则体（剥块注释 → 花括号配对 → 逗号选择器列表逐项精确匹配），行号只用于报告描述、不参与判定；新增判定 **V7c**（命中 1 条规则、≥6 条声明、必含 `background: rgb(var(--content-rgb) / 1)`、不含 `:empty` 的 `display`、不含 `transition|animation`），并**同轮记录旧切片只覆盖 1 条声明且不含 `background`** 作为反证留痕。
* **变异自证（真跑，`experiments/d5-03/batch6-gate-rebase-proof.mjs`）**：M2 末尾追加 `transition` → 旧口径 **PASS（假绿）** / 新口径 **FAIL（抓住）**；M4 追加 `animation` → 同样「旧假绿、新抓住」；M3 不透明底退回 `/ 0.5` → 新口径 FAIL；真实工作树 → 旧口径 PASS（但只覆盖 1/6 声明）、新口径 PASS（6/6 无动效、底正确）。运行 `20260928T084047Z-866c`（**11/11，exit 0**，sha256 `019a14032fafcd0a9caebdaef299c3df79964a3127bb24c3f6beabe4486c7def`）；首轮 `20260928T084038Z-e7c9`（9/11）留档。

### 7.2 假阳性②：`!cssChanged` 判据重基线为「本批新增动效声明数 = 0 + 运行时 V7a 全绿」

* **旧口径（逐字）**：`const cssChanged = batchDiffFiles.some((f) => f.endsWith(".css")); … !cssChanged && …`（基线 `81a211e`）。
* **为什么必然 FAIL**：本批的修复**本身就是改 `src/styles.css`** —— 旧判据要求「本批 diff 不含任何 .css」，只要本批修的是 CSS 就恒 FAIL。**这是 fail-closed 设计问题，不是产品缺陷**（与第五批 R3 同形）。
* **新口径**：基线改为 `d4a3516`（脚本断言它必须是 HEAD 祖先），判据 = `git diff <base> -- '*.css'` 的**新增行**里 `transition` / `animation` 声明数 **= 0**，且运行时 **V7a 仍全绿**；同轮把旧判据结果作为反证记录（`legacy.cssChanged.wouldFail = true`）。
* **未改动部分**：V1–V7a、Z1、Z2 与第一至第五批的所有断言**一字未改**；本批对 `auth-error-visual.mjs` 的改动只有上述两处 + 新增 V7c / V8–V12。

### 7.3 R3 登记表 4 → 5 项（经总经理逐条授权）

**这是门禁基线更新，不是判定削弱**：新增 `src/styles.css`（`d1ba058 · 第六批`），前 4 项一字未改。

| 判据 | 内容 |
| --- | --- |
| 必含 | `.auth-error` 规则体内出现 `background: rgb(var(--content-rgb) / 1)`（去空白精确匹配） |
| 禁含① | 规则体内 `transition` / `animation` 声明数 = 0（与 V7a / V7b 运行时同口径） |
| 禁含② | 新增行不得出现 `--failed-rgb` / `--failed-alpha` |
| 禁含③ | `src/design-system/tokens.css` 的浅 `215 0 21` / 深 `255 69 58` 必须原值在（token 定义地，不是 `styles.css`） |
| 范围 | 本批 `styles.css` 的**新增内容行**（剥块注释后）必须全部落在 `.auth-error` 规则体内；新增行不得出现 `{` / `}`、不得新增自定义属性 → `:root` / `.dark` 令牌块动不了 |
| 保持 | 表外 `src/` 改动一律 FAIL；`git diff` 取不到 → fail-closed FAIL；`addOnly`（只增不删）保持 |

* **负向自证（真跑，仓库副本，验完不留痕）**：`experiments/d5-03/batch6-r3-rebase-proof.mjs` 用最小 git 仓库副本跑**同一个** `r3SrcDiffEvaluation` —— 对照组 PASS；case-i 去掉不透明内容底 → FAIL；case-ii 深色 `--failed-rgb` 改成 `255 69 59` → FAIL；case-iii 规则体加一条 `transition` → FAIL；harness 末行「R3 负向自证：全部符合预期（4 个副本）」。最终运行 `20260928T092753Z-e537`（**4/4，exit 0**，sha256 `9c7f00e904a2fe6d08635a7525e76e70c10e9f8c5b4657e9dab10d595a835966`）；中途两次（`3e07` / `7871`，3/4）一并留档；另有空目录 `cf4e`（未登记，见 §1）。
* **case-iii 抓出了审计自身的真漏洞**（如实披露）：规则体第一条声明会和选择器粘在一起，导致「第一条就是 transition」漏检；已修为只取花括号内部再按分号切，修前它确实放过了 case-iii。
* **重跑对比**：`74ec`（42/43，exit 1）→ **`2780`（43/43，exit 0，notVerified 2）**；本岗按位置逐条比对 43 条（runId 归一化后）：**状态不同的只有 1 条 = R3 FAIL → PASS**，其余 42 条状态与 notVerified 2 条一字未动。

## 8. 总经理裁定（本批，写进本文件即生效）

1. **R3 登记表新增 `src/styles.css`（4 → 5 项）**：条件如 §7.3（必含不透明内容底、规则体 0 条 `transition|animation`、深浅 `--failed-rgb` 原值必须在 `tokens.css`、新增内容行必须全落在 `.auth-error` 规则体内、表外 src 改动仍 FAIL、git 取不到仍 fail-closed），并含负向自证 4/4。**第五批裁定 ② 的「登记表式基线、跨批不复位」继续有效** —— 本批正是按同一形态新增登记项并重跑负向自证。
2. **`auth-error-visual` 的 V7b 口径重基线**：定性为**假阳性修正（fail-closed 设计问题），不是产品缺陷**；旧判据在本批「修复本身就是改 CSS」下必 FAIL，因此重基线为「本批新增 `transition`/`animation` 声明数 = 0 + 运行时 V7a 全绿」，并保留旧判据结果作为反证。
3. **任务书 `--dur-quick` 口径与实现不符 → 按实现记录、不改成通过**：`--dur-quick` 的 0ms 只在 `.reduced` 作用域（`tokens.css:358`），常规档是 160ms（`:170`）。该行两档都无 `transition`/`animation` 声明、帧序列已证两档都即时出现，但「两档都 0ms」这句话**不作为通过项登记**。

## 9. 三轴判定与当前有效证据

### 9.1 当前有效证据 = 第六批 runId 清单

| 用途 | runId | counts / exit | artifact sha256 |
| --- | --- | --- | --- |
| 安装重置一致性 | `20260928T091457Z-f559-mcp-reset-e2e` | **26/26 · exit 0 · notVerified 3** | `9c2c91a1eb5e9dc4b33d134ea377fa7c43511338ea133f5270a56de26133e254` |
| center（第一批回归） | `20260928T091508Z-967d-mcp-center-e2e` | **38/38 · exit 0 · notVerified 0** | `6726b742034d49c1f4bb09d252e6e8585339b94e1af567859421e26d6c070b1e` |
| stream（第三批回归） | `20260928T091545Z-23e3-mcp-stream-e2e` | **29/29 · exit 0 · notVerified 0** | `8df59d5277f10d1034f75a21a1ed953266f9057715752476fe99386edd044b34` |
| policy（第二批回归；**R3 重基线后**） | `20260928T095113Z-2780-mcp-policy-e2e` | **43/43 · exit 0 · notVerified 2** | `79483f1db9cb8b7b4ec7a2bde9ed4f711fc2d3858c7ef2b3f1fc1eab4d76631e` |
| ↳ policy 重基线前（仅留档对照） | `20260928T091621Z-74ec-mcp-policy-e2e` | 42/43 · exit 1 · notVerified 2 | `95ae1de005e2a8695156630028f6be7eea6df0dd3df3152f82955f704f8201fe` |
| 视觉 / 布局 / 焦点 / 动效矩阵 | `20260928T094556Z-c729-auth-error-visual` | **43/43 · exit 0 · notVerified 2** | `1e87ced41e3b9c453e206d2b63e44290e244f06d8dcbe50fd27a9340778ca86b` |
| 门禁假阳性先红后绿反证 | `20260928T084047Z-866c-batch6-gate-rebase-proof` | 11/11 · exit 0 | `019a14032fafcd0a9caebdaef299c3df79964a3127bb24c3f6beabe4486c7def` |
| R3 新增项负向自证 | `20260928T092753Z-e537-batch6-r3-rebase-proof` | 4/4 · exit 0 | `9c7f00e904a2fe6d08635a7525e76e70c10e9f8c5b4657e9dab10d595a835966` |
| 状态机诊断（reset 后必须 reload 才回向导） | `20260928T085957Z-9d2a` / `090057Z-6571` / `090142Z-1ff2` | — | 见索引 |

**计数不得低于上一轮**：reset 26 ≥ 26、center 38 ≥ 38、stream 29 ≥ 29、policy 43 ≥ 43（重基线前那一轮 42/43 按「如实报告并停下说明」处理，经总经理逐条授权后重基线）。

### 9.2 仍然有效的早期证据（哪些复用、为什么）

| 复用的证据 | 出处 | 为什么仍然有效 |
| --- | --- | --- |
| 第五批 expiry-idle `20260928T070551Z-f078-mcp-expiry-e2e` **26/26** | `docs/D5-03-RESULT.md` 第五批 §2.1 | 本批**未重跑** expiry；第六批改动集中在 App 授权取数（3 个调用点补组织 + 判权纯函数加组织参数）与 `.auth-error` 样式，**不落在 expiry 的断言面上**（`mcp-expiry-e2e.mjs` 断言会话到期 / 收流 / 连接状态与 `detail=expired:*`，不读 app grant 取数）。**口径如实说明：这是结构判断；第六批没有跑受影响性分析工具、也没有重跑 expiry 六场景**（见 §10 登记）。 |
| 第四批 expiry 其余五场景：extend / absolute / relogin / regress / override-deny | 第四批 §2（第五批 §2.2 复用） | 同上；且本批对 `governance-service.cjs` 的改动是「调用点补组织、显式组织过滤原样保留、行为逐行不变」（§2、O9 有行为级对照）。 |
| 第五批 R3 登记表前 4 项（`McpCenter.tsx` / `types.ts` / `useIdentity.ts` / `AuthScreens.tsx`） | 第五批 §2.7 / §9 | 本批**只新增第 5 项**，前 4 项的必含 / 禁含 / 只增判据一字未改（`git diff d1ba058 2944e45 -- experiments/d5-03/mcp-policy-e2e.mjs` 可核）。 |
| 第五批 `SHOWABLE_ERROR_DETAIL` / `errorText` 收口 | 第五批 §2.6 | 本批一字未改（`d1ba058` 的 diff 不含 `src/identity/types.ts`）；且 `c729` 43/43 里 V1–V6 仍在真机上复验文案与内部标记。 |
| 第四批临时目录归属机制（`userdata-ownership.cjs`） | 第四批 §6（第五批 §2.2 复用） | 本批未改该脚本；本批每次运行的 `cleanup.leftovers` 都是 `[]`、`pkillUsed=false`，自建 userData 目录建后即清。 |
| 第五批登记的残留（`device_pairing_credentials` 未清 / `app_principals.status` / `RATE_LIMITED` 对象 detail / `invariants()` 无孤儿行检查） | 第五批 §4 | 本批未处理这些项，结论继续有效（见 §10）。【**第七批已更新**：已随安装重置**同事务**清空 —— 真机证据 = 设备三表 **1 / 1 / 2 → 0**、旧未使用密钥 `PAIRING_TOKEN_UNKNOWN` 且 **0 新设备 / 0 新凭据**、旧指纹 `DEVICE_CREDENTIAL_UNKNOWN`；第五批 / 第六批的历史结论不变（详见 `docs/decisions/D5-03G-install-reset-device-identity.md`）。】 |

**不再作为当前证据**：第五批的 reset `9cd0` / center `c7ba` / stream `cce3` / policy `db3d` / 视觉 `27eb` —— 前四者已由**同提交新鲜重跑**取代；`27eb` **16/17 保留为「修复前」的历史失败证据**（2.62:1 的失败历史必须留，不能顶替成当前值）。

### 9.3 三轴判定

* **功能 = 通过**：四段 MCP 门禁 **26/26 + 38/38 + 29/29 + 43/43** 全 exit 0；`node --test tests/d4-04-closure2-boot.test.mjs` **9/9**；`npm test` **1363/1365**（两条既有失败：`tests/side-effect-c4-gates.test.mjs`、`tests/d4-03-approval-push-isolation.test.mjs`，与本批无关）；产品提交自证（提交信息）：`node --test` 206/206 与 382/382 全绿、新测试 9/9 与 5/5、`npm run build` exit 0。
* **视觉 = 通过**：矩阵 **10 格 × 2 面全部 ≥4.5:1**，每格底 = 该行自身 token 底 —— 浅 **5.372**（`255,255,255`）、深 **5.261**（`23,23,23`）、深实色 **5.665**（`14,14,14`）；四个基准点对照第五批 `27eb`：**2.620 → 5.372、5.192 → 5.372、5.310 → 5.261、5.159 → 5.261**；登录页两条错误行**首次**量到对比度（各 5.372）。布局 / 焦点 / 动效全绿（行高 36.40 ≥ line-height 20.40；无错误行时整段不在 DOM；出现后 actions 下移 48.4px 精确等于行高 + margin；8 组缩放 × 长文案无溢出；焦点环 2px + offset 2px 与错误行不相交，输入框按产品设计不用焦点环已留档）。**第五批 16/17 的失败历史保留**（修复前证据）。
* **动效 = 通过（含 1 条口径不符的如实登记）**：两档帧序列 **0 中间帧**、末帧与首现帧矩形一致、`animationName=none` / `transitionDuration=0s`；`.reduced` 档元素作用域 `--dur-quick=0ms`。**如实登记一条口径不符**：任务书说「normal 与 reduced 都 0ms」，实现里 0ms 只在 `.reduced`（`tokens.css:358`），常规档 160ms（`:170`）；该行两档都无过渡 / 动画声明、帧序列已证两档都即时出现 —— **按实现记录，不写成通过**。

## 10. 未闭合项、notVerified 与残留（如实登记，不美化）

**notVerified（真机报告 §7 的 8 条，逐条）**：

1. **「normal 与 reduced 下元素作用域 `--dur-quick` 都是 0ms」** —— 任务书口径与实现不符，按实现记录、不改成通过（§8 裁定 ③）。
2. **设置面错误行消失后的空间释放量精确等于「行高 + margin」** —— 实测释放 61px，行高 + margin = 48.4px，**残余 12.6px 成因未查明**；同一判据在向导面已精确成立（48.4 = 48.4）。不作为产品缺陷登记。
3. **产品 Zoom 的「真实入口」** —— 产品没有缩放 UI / API，四档缩放的布局效果由 CDP 设备度量覆写复现，不是按了产品的缩放快捷键。
4. **缩放矩阵里的长文案** —— 126 字是注入错误行 DOM 的排版压力测试，不是产品真实文案（真实文案 7–13 字也各自在四档缩放下量过）。
5. **动效证据是连续帧序列而不是视频文件** —— 帧间隔中位 73 / 82ms，对「有无淡入 / 位移」逐帧可判；未做视频编码、未做人工节奏评审。
6. **`mcp-policy-e2e` 的两条既有 notVerified**（与本批无关，第二次重跑仍为 2 条）：同一安装内第二个组织无法用产品入口构造；跨组织**行为级**不互相覆盖。
7. **`governance-ui` / `model-keychain-restart` 两条探针门禁本身在当前提交上不通过**（**既有失败**，A/B 已证，见下）—— 需要单独的修复排期；本批不改 `tests/**`。
8. **`.auth-error` 在「减少透明度（产品实色档 solid）」下的浅色 token** —— `light × solid` 的 `--content-rgb` 仍是 `255 255 255`，与 `light × full` 同值，这一格只证了「等于自身 token」，没有额外区分度；深色实色档有区分度（`14 14 14` ≠ `23 23 23`）。

**两条探针门禁的既有失败（登记待单独排期）**：`governance-ui` **1/5**（失败点：探针 `main.cjs:91-92` 的 `userByIdentifier` 返 null → `u2.id` 抛错，发生在改动行 104/106/108 **之前**；stderr 全是 `No handler registered`，是该探针只注册部分 IPC 的固有形态）、`model-keychain-restart` **3/15**（失败点：`appById("settings")` 为 `null` → `createProvider` 直接 `PROXY_UNAUTHORIZED`，发生在改动的第 97 行**上游**的 `!app` 检查；`settings` 这个 App Principal 由 `electron/model-bootstrap.cjs:44` 的 `seedModelAppPolicy` 在**拿到会话时**补种，而该探针的 `boot()` 从未调用它；`git show 81a211e:electron/identity-store.cjs` 的内置种子表里本来就没有 `settings`）。**一次性授权 A/B 实测**：把两个 fixture 临时回退到本批之前（`d4a3516`）→ 跑 → 立刻恢复，结果**完全相同**（governance-ui 1/5 exit 1、model-keychain-restart 3/15 exit 1，**同计数、同失败点**）；恢复后 `shasum -a 256` 与回退前一致（`b8cfbd089c9a5a8b…` / `cf71d77a018d286f…`）、`git status --porcelain -- <两个 fixture>` 为空 ⇒ **既有失败，与本批改动行无关**。

**本批新登记的残留**：

* `experiments/d3-04d/02-picker.mjs:26` 的 `qApp.total===0` 断言**本身不敏感**（baseline 存在时该查询也是 0）—— **既有弱化，非本批引入**；本批只把撤销循环的取数补上组织（否则会空转），断言强度未变也未加强。
* `.auth-error` 是**组件级局部补**；规范级解法（token 层新增「浮在可变背景上的文本行」材质档 / 语义映射）**未做**（§6.1 取舍）。
* 第六批**未跑受影响性分析工具、也未重跑 expiry 六场景**：expiry 的复用是结构判断（§9.2），不是本批机械证据。
* 索引口径：报告 §8 的「61 条 / 60 行」与复核值「64 条 / 64 行」不一致；未入索引目录 `cf4e` 未在报告登记（§1）。
* 工装迭代轮 `fcfa` 未列入报告 §6.3（§1）。

**继续单列（不并入本批）**：**OAuth**（仅 `NONE` / `BEARER`）、**设备配对凭据重置**（第五批登记残留：`device_pairing_credentials` 未清）【**第七批已更新**：已随安装重置**同事务**清空 —— 真机证据 = 设备三表 **1 / 1 / 2 → 0**、旧未使用密钥 `PAIRING_TOKEN_UNKNOWN` 且 **0 新设备 / 0 新凭据**、旧指纹 `DEVICE_CREDENTIAL_UNKNOWN`；第五批 / 第六批的历史结论不变（详见 `docs/decisions/D5-03G-install-reset-device-identity.md`）。】、**插件隔离（D5-08）**、**D5-02 重命名受 Electron 不支持 `prompt()` 限制**、**SIGKILL 边界**（`kill -9` 靠 `cleanOrphans` 事后按三条件清理、默认 dry-run）、第五批登记的其余残留（`app_principals.status` / `RATE_LIMITED` 对象 detail / `invariants()` 无孤儿行检查）。**本批未新增「创建组织」入口**。

**跨组织真机 2 条（policy，继续保留）**：同一安装内第二个组织无产品入口 → 跨组织行为级只到 schema + node 级。

## 11. 相关代码与测试

* `electron/authorization-store.cjs`：`appGrantsForApp` SQL 按 `(app_id, organization_id)`（`:80`）+ `appGrantsForApp(appId, organizationId)` 空组织 fail-closed 空集（`:478`）+ `allAppGrants()`（`:484`，全表语义，供需要的旁证用）；
* `electron/authorization-domain.cjs`：`evaluateAppAuthorization`（`:554`，逐条组织比对 `:568`、空组织 `:566` 直接不放行）+ `evaluatePolicy` 加 `organizationId`（`:586`）并透传（`:606`）；
* `electron/authorization-service.cjs`：`:114` 取数补 `user.team_id`；`:153` / `:998` 两个 `evaluatePolicy` 调用点、`:336` 直接 `evaluateAppAuthorization` 调用点都补 `prepared.organizationId`；
* `electron/model-service.cjs:27` / `electron/mcp-service.cjs:91`：补 `actor.organizationId`；后者删掉 `!g.organization_id` 通配分支；
* `electron/governance-service.cjs:294 / :312 / :337`：调用点补组织，既有显式组织过滤原样保留（行为逐行不变）；
* `electron/identity-store.cjs`：重置注释同步当前事实（仅注释，剥块注释后逐字节相同）；
* `src/styles.css:2471-2478`：`.auth-error` 不透明内容底 + 既有圆角/内边距 token；
* 测试：`tests/d5-03-app-grant-org-isolation.test.mjs`（新增，O1–O9 = 9）、`tests/d5-03-auth-error-contrast.test.mjs`（新增，C1–C5 = 5）、`tests/d5-03-reset-authorization-consistency.test.mjs`（T5 / T5b 期望值订正 + 阳性对照）、`tests/d4-04-closure2-boot.test.mjs`（9/9）、`tests/authorization-app-grant-scope.test.mjs` 等其余夹具/读取口径改动；
* 验收脚本：`experiments/d5-03/auth-error-css-audit.cjs`、`auth-error-matrix.cjs`、`batch6-gate-rebase-proof.mjs`、`batch6-r3-rebase-proof.mjs`、`batch6-matrix-diag.mjs` / `batch6-matrix-diag2.mjs`（新增），`auth-error-visual.mjs`（两处假阳性修正 + V7c/V8–V12）、`mcp-policy-e2e.mjs`（R3 登记表 4 → 5）。

**状态机诊断（对后续门禁脚本有用）**：`identity/reset-installation` 会让**正在运行的渲染层立刻落到登录页**（主进程发 `LOGGED_OUT` → `gate=unauthenticated`），此时 `identity/status` 已经是 `UNINITIALIZED` 但页面上还没有向导 —— **只有 reload 之后才会出现向导**。任何门禁在 reset 之后必须 **reload 并按「gate=uninitialized 且 `[data-d3-id=setup-name]` 在」双条件判定**（登录页也有同一条 `.auth-error`，光看 gate 会把两个面混成一个）。

## 12. 判定

* **D5-03 第六批（App 授权组织隔离 + 登录错误行不透明内容底）= PASS（限定范围）**：四段 MCP 门禁 **26/26 + 38/38 + 29/29 + 43/43** 全 exit 0；App 授权取数层按 `(app_id, organization_id)` 且空组织 fail-closed 空集，判权层逐条挡（O1–O9 9/9，先红后绿 2×2 全还原 7 fail / 只恢复判权层 5 fail / 只恢复取数层 1 fail）；`.auth-error` 不透明内容底使矩阵 **10 格 × 2 面全部 ≥4.5:1**（浅 5.372 / 深 5.261 / 深实色 5.665），第五批 2.62:1 的失败闭合；门禁两处假阳性修正 + R3 登记表 4 → 5 项（含 4/4 负向自证）；`npm test` 1363/1365（两条既有失败）、`d4-04-closure2` 9/9、`SCHEMA_VERSION` 仍 21。
* **D5-03 整体仍 = PARTIAL**，剩余缺口 = §10 逐条（跨组织真机 2 条 / 两条探针门禁既有失败待排期 / OAuth / 设备配对凭据重置 / 插件隔离 D5-08 / D5-02 `prompt()` / SIGKILL 边界 / 本批新登记残留）。
* **本批闭环的旧缺口**：第五批视觉唯一失败（浅色 `.auth-error` 2.62:1，本批修复并真机复测 5.372:1）；第四批登记的「App 侧孤儿授权行可复活权限」（第五批订正、第六批从**取数 + 判权两层**彻底闭合）；第五批「取数 `appGrantsForApp(app_id)` 不带组织过滤」的口径（第六批已修，第五批的历史结论与取证价值不变）。
* tracked 证据：`docs/D5-03-GATE-EVIDENCE.json` 的 `batch6` 段；本批决策 = 本文件；真机报告 `experiments/d5-03/D5-03-BATCH6-MATRIX-REPORT.md`；第三 / 四 / 五批决策 `docs/decisions/D5-03C-streamable-http.md` / `D5-03D-session-expiry-and-policy-retention.md` / `D5-03E-install-reset-authorization-consistency.md`（含【第六批已更新】就地标注）。
