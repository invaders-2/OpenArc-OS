# D5-03 第五批 · 安装重置同事务清授权 + 登录失败文案不再泄漏内部 detail（真机验收报告）

被测工作区：/Users/wepingli/Desktop/OpenArc OS-integration（分支 integration/ui-core，**HEAD = 09dccf9c2cba5f21e787160de376a166db61a38d**，即被测提交）
本报告时间：2026-09-28（UTC 06:56–07:09，本机本地 14:56–15:09）
运行方式：全程**串行**（同一时刻只有一个本脚本启动的 Electron），每次独立 runId 产物目录 + 只追加索引 + .sha256；CDP 端口独占探测；临时 userData 全部走 experiments/d5-03/userdata-ownership.cjs 的归属机制。

---

## 0. 结论（功能 / 视觉 / 动效 三轴分开判定）

| 轴 | 判定 | 依据（本条结论对应的唯一证据） |
| --- | --- | --- |
| 功能 | **通过** | 目标一 26/26（runId 20260928T070842Z-9cd0-mcp-reset-e2e，exit 0，sha256 17202b48…）；目标二四段门禁：center 38/38、stream 29/29、expiry-idle 26/26 全绿，policy 42/43（唯一失败 = 旧脚本 R3 的**陈旧 src-diff 白名单**，非产品行为，见 §3.4） |
| 视觉 | **部分通过** | 浅色向导卡上的 .auth-error 实测 **2.62:1 < 4.5:1（不通过）**；深色向导卡 5.31:1、浅色设置窗口面 5.19:1、深色+减少动态效果 5.16:1 均通过（runId 20260928T070627Z-27eb-auth-error-visual，16/17，唯一 FAIL 即浅色向导卡这一条）。文案本身正确（浅/深逐字一致、无内部标记） |
| 动效 | **通过** | 错误行在常规（浅/深）与减少动态效果下都是 animationName=none、transitionDuration=0s、元素作用域 --dur-quick=0ms；本批 81a211e→HEAD 的改动文件里没有任何 .css/动效文件；.auth-error 规则本身不含 transition/animation（V7a/V7b，同一 runId） |

**一句话**：本批两处产品改动在真机上都成立（重置把四张授权事实表清空且审计一行不删、重新初始化后新组织拿到完整 15/6 授权且无旧墓碑；登录失败文案只显示 code 那一句 + 4 条白名单 detail，内部标记与 [object Object] 都不进界面）。三轴里唯一不通过的是**浅色玻璃卡面上的红字对比度 2.62:1**，这是既有问题（本批未改任何样式），首次被实机量测暴露。

---

## 1. 被测内容、规范与基准

- 本批（HEAD 提交）改动文件（git show --name-only）：electron/identity-store.cjs、src/identity/types.ts、src/identity/AuthScreens.tsx + 三个测试文件（tests/app-policy-provisions-retention.test.mjs、tests/d5-03-reset-authorization-consistency.test.mjs、tests/identity-session-expired-ui.test.mjs）。
- 产品面改动：① resetInstallation 在既有 transactSync 内先删 RESET_AUTHORIZATION_DELETE_SQL 四表（app_policy_provisions / app_resource_grants / resource_grants / device_access），再删身份五表；② errorText 改为「code 那一句 + SHOWABLE_ERROR_DETAIL 白名单（4 条，全挂 INVALID_INPUT）」。
- 规范版本与行号（当前工作树实测）：
  - DESIGN_SYSTEM.md：**第 3 行**「版本：设计提案 0.2，2026-09-10」；**第 64 行** text.secondary = 浅 #6E6E73 / 深 #98989D；**第 153–154 行**「不使用 600 及以上字重…正文、按钮、导航、次级说明统一 400」；**第 164 行**「次级说明 12 / 18 px，400」；**第 248 行**「普通文本对比初始验收门槛为 4.5:1，大字为 3:1，必要控件边界和状态标记为 3:1」。
  - MOTION_SYSTEM.md：**第 3 行**「版本：动效提案 0.1，2026-09-10」；第 21 行 duration.instant = 0 ms；第 141–145 行「减少动态效果…映射为即时切换或不超过 100 ms 淡变」。
  - PLAN.md 第 4 节（全局视觉与动效规范，38–52 行）与第 42 节（设计语言与交互动效交付，801–806 行）。
- 基准（沿用第一/四批口径）：应用窗口 innerWidth/innerHeight = **1440×940**（electron/main.cjs:271-272 默认，未设缩放）、DPR 2、默认壁纸 oa-wallpaper=theme-dark、默认材质 data-glass=full、未开不透明；主题与减少动态效果都用**真实设置面板**切换。第四批 MCP 窗口截图基准为 1660×1140 设备像素（CSS 裁剪 830×570）；本批拍的是**整窗**（认证界面是全窗表面），截图 2880×1880 设备像素 = 1440×940 CSS × DPR 2，窗口/缩放/背景/透明度四项与基准同口径，截图范围不同（不是"逐像素同尺寸"，如实说明）。

---

## 2. 目标一：安装重置后的授权数据一致性（真机）

**有效证据**：runId \`20260928T070842Z-9cd0-mcp-reset-e2e\`，counts **26 / 26（fail 0）**，notVerified 3，exitCode 0；
产物 artifacts/d5-03/runs/20260928T070842Z-9cd0-mcp-reset-e2e/mcp-reset-e2e.json，sha256 **17202b482ffea7aa587f7fb0f9d0e6cd92342997b424852450fa6e00fee37766**。
脚本：experiments/d5-03/mcp-reset-e2e.mjs（新增）。隔离：userData oa-d503b-20260928T070842Z-9cd0-*（收尾已删）、CDP 端口独占探测、只杀自己的 pid 树（pkillUsed=false）。

### 2.1 逐条命令与返回（STEPS，原文）

| 步 | 命令 | 请求 | 返回 |
| --- | --- | --- | --- |
| A1 | 真实 UI 三步向导 + identity/login | admin@d503e-reset.test | gate=ready；向导三步都点到、submitted=ok |
| A1.status | identity/status | {} | ok=true；teamId=team_tnM0rkPP6WB8lKUKpUvscg9pC2Rf5whw；userId=usr_…；installationId=inst_… |
| A3 | resource/create（产品命令层，触发 resource 族播种） | {type:'resource/create', resourceType:'text', name:'D5-03E 播种触发'} | **ok=true**，resourceId=res_lasuAuCRRpCjTkngBWPh3jQVXmaMMA3E |
| B1 | governance/grantResourceAccess | USER × text × ['resource.read'] | ok=true，grantId=grant_uS_vv9BQbnp_Cf33pi91F1jWnOI-19Fm |
| B2 | governance/revokeAppAccess | mcp-center 的 mcp 授权 | ok=true，revokedGrantId=grant_6UCO6mRvizAVRlRxLMRVL_wMip0YZKMY |
| B3 | governance/revokeAppAccess | canvas 的 model 授权 | ok=true，revokedGrantId=grant_HIYYb1NFC0KCrFT6Hno377HgjGeJzzM- |
| B4 | mcp/list（撤权后） | {} | ok=false，error=MCP_UNAUTHORIZED（墓碑在行为上生效） |
| C1 | identity/reset-installation（缺 confirm） | {} | ok=false，error=INVALID_INPUT，detail=confirm-required |
| C2 | identity/reset-installation（confirm 大小写不符） | {confirm:'delete-all-identity-data'} | ok=false，error=INVALID_INPUT，detail=confirm-required |
| D1 | identity/reset-installation（正确 confirm） | {confirm:'DELETE-ALL-IDENTITY-DATA'} | ok=true；status={initialized:false,status:'UNINITIALIZED',installationId:null,userCount:0} |
| D6 | page.reload()（与重启同一条启动询问路径） | — | gate=uninitialized |
| E1.status | identity/status（新组织） | {} | ok=true；teamId=team_8GYXyRw-3BvUA3ibqp4uNiw_4PjqUcgw（≠ 旧 id） |
| E6 | mcp/list（新组织） | {} | ok=true（重置前被撤销的 mcp 授权在新组织是首次播种） |
| F1 | node --test tests/d5-03-reset-authorization-consistency.test.mjs | — | exitCode=0；# tests 9 / # pass 9 / # fail 0（含 T3） |

### 2.2 只读 DB 快照（DatabaseSync readOnly；探针没有任何写库）

| 快照 | app_policy_provisions | app_resource_grants | resource_grants | device_access | installations/teams/users/sessions | 墓碑 | audit_log 行数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A_seeded（首次播种后） | **15** | **16** | 0 | 0 | 1/1/1/1 | 无 | 2 |
| B_before_reset（撤两条授权后） | 15 | 14 | **1** | 0 | 1/1/1/1 | canvas\|model、mcp-center\|mcp | 2 |
| C_after_bad_confirm（两次错误 confirm 后） | 15 | 14 | 1 | 0 | 1/1/1/1 | 同上（逐行不变） | 4 |
| D_after_reset（正确重置后） | **0** | **0** | **0** | 0 | **0/0/0/0** | 无 | 6 |
| E_reseeded（重新初始化+登录后） | **15** | **16** | 0 | 0 | 1/1/1/1 | 无 | 8 |

- 首次播种逐条等于期望集合：resource 10（ai/browser/canvas/illustrator/image-generator/mcp-center/photoshop/resource-library/skill-runtime/video-generator）+ model 4（ai/canvas/resource-library/settings）+ mcp 1（mcp-center）= **15 提供记录**；app_resource_grants **16**（实测按 resource_type 分组：''=10 / memory=1 / model=4 / mcp=1，即 resource 族 11 = 10 个 App 的基线行 + resource-library 的 memory 定向行 1，加 model 4、mcp 1；两端逐行同形比对见 §2.3）。
- **等价只读自检**（invariantsEquivalentReadonly，与 identity-store invariants() 判定逐条等价）：A/B/C/D/E 五个快照全部为 **[]**。
- **审计**：authorization_audit / device_audit 在每个快照之间**逐行相等**（JSON 逐行比对）；audit_log **既有行一行不删**（前缀逐行相等）。行数变化如实记录：2（首播）→ 2（撤权不改 audit_log 行数，撤权写的是 authorization_audit）→ **4**（+2 条被拒留痕 reset-installation/DENY，error_code=INVALID_INPUT）→ **6**（+OK_REQUESTED、+OK）→ 8（重新初始化与登录的常规审计）。reset-installation 记录序列 = DENY, DENY, OK_REQUESTED, OK —— **不是"行数不变"**。
- 重置时四张授权表**都先有行**：app_policy_provisions 15、app_resource_grants 14、resource_grants 1（经 governance/grantResourceAccess 造出）→ 重置后全 0；**device_access 是 0 → 0**，不构成清理证据（见 §5 notVerified）。

### 2.3 复初始化后的新组织

- 新组织 id 与旧组织不同（team_8GYXyRw… ≠ team_tnM0rkPP…）。
- 提供记录 15 条，逐条等于期望集合；**全表 revoked_at 非空 = 0 条**；旧组织 id 在 app_policy_provisions 里 **0 行** → 没有任何旧墓碑残留，新组织首次播种不被压制。
- app_resource_grants 16 条，且与重置前那次首次播种的"组织无关形状集合"**逐行同形**（diff=[]）。
- 行为证据：重置前被撤销的 mcp 授权在新组织里首次播种 → mcp/list ok=true；governance/getAppAccess(mcp-center) 的 mcp grant revokedAt=null。

### 2.4 组织 ID 复用（真机不可构造）

- 真机**没有**"用指定 id 创建组织"的产品入口：identity/initialize 的组织 id 由产品随机生成；渲染层命令白名单（IDENTITY_COMMANDS ∪ ADMIN_COMMANDS）里没有创建组织入口，本批也没有新增"创建组织"入口。因此**不用改库构造**，按第四批惯例以 node 受控测试为证据。
- 现场重跑：node --test tests/d5-03-reset-authorization-consistency.test.mjs → 9/9 通过，其中 **T3「组织 id 复用不被旧墓碑压制」ok 4**；日志留档 artifacts/d5-03/runs/20260928T070842Z-9cd0-mcp-reset-e2e/node-reset-consistency.log。
- 真机侧可观测的等价面：重置后旧组织 0 行、全表 0 条墓碑（§2.2），所以"旧墓碑压住新播种"在真机上已无残留可压；同 id 的 A/B 对照只有 node 证据。

### 2.5 首轮产物与一个探针缺陷的披露

- 首轮 20260928T065649Z-d18e-mcp-reset-e2e（26/26，exit 0，sha256 495964b8ca826caf…）结论与最终轮一致；但它的 A3 步里 resource/create 返回 INVALID_INPUT：原因是**探针把命令写在 command 字段，而 resource:command 的信封字段是 type**（electron/resource-bootstrap.cjs:150），被 IPC 白名单挡在服务层之外 —— 是探针参数错误，不是产品缺陷。
- 该轮仍然验到了 15 条提供记录：resource 族的 provisioned_at 比 model/mcp 晚 192ms（1790578613146 vs …612954），由**渲染层自己的产品命令路径**（登录后桌面挂载时的资源查询）触发播种。
- 最终轮已把探针改成 type 字段：A3 现在同时断言 resource/create 本身 ok=true 且真的建出资源（resourceId=res_lasuAu…），resource 族播种由这条正式命令触发。两轮产物都保留在 runs/ 里。

---

## 3. 目标二：受影响性分析 + 既有门禁重跑

### 3.1 本批改动文件 ↔ 各门禁实际执行的代码路径（机械证据见 batch5-affectedness 产物）

| 门禁 | 是否落在改动路径上（判据） | 机械证据 | 处置 |
| --- | --- | --- | --- |
| mcp-policy-e2e | **是**：B 段撤权 / E 段重授 / F 段新组织首用 / R 段回读第一批都直接读 app_policy_provisions 与 app_resource_grants 的墓碑与授权行；本批改的正是 resetInstallation 对这两张表的删除集合，防删除守卫 R6/R6b 也盯同一组源码字面量 | 脚本内 app_policy_provisions/app_resource_grants 命中 26 次；resetInstallation 调用 0 次 | 必须重跑 → 42/43（见 §3.4） |
| mcp-center-e2e | **是**：走真实 UI 三步向导 + 登录 + 真实身份存储，本批改了 AuthScreens.tsx / types.ts；但它**不读**登录页 auth-error（authError 命中 0），所以没有依赖旧文案的期望需要更新 | authError 命中 0；authScreens 选择器命中 15 | 重跑 → 38/38，无需改期望 |
| mcp-stream-e2e | **不落在改动函数上**：resetInstallation 只经 identity/reset-installation 可达（ADMIN_COMMANDS 白名单），该脚本 0 命中；errorText 只在渲染层显示失败文案时用，该脚本不读 auth-error | resetInstallation 0；authError 0 | 按分析可复用第四批证据（runId 20260928T043657Z-8d65 / sha256 699aae6b216fd94c…），但本轮仍**重跑**取同提交新鲜证据 → 29/29 |
| mcp-expiry-e2e --scenario=idle | **是（断言面）**：1h 检查明文断言登录页 auth-error =「登录状态已过期，请重新登录。」 | authError 命中 2（脚本自有的 authError 变量） | 必须重跑 → 修后 26/26（见 §3.5） |

### 3.2 门禁重跑结果（同提交 09dccf9，串行）

| 门禁 | runId | counts | exit | 产物 sha256 | notVerified |
| --- | --- | --- | --- | --- | --- |
| mcp-policy-e2e | 20260928T065727Z-b56c-mcp-policy-e2e | 42/43（fail 1 = R3） | 1 | 34d9fdd8866128cf181b9d9bafa1b73133f072db77a6760c62f07ed2f132e233 | 2（与第四批口径一致） |
| mcp-center-e2e | 20260928T065801Z-c7ba-mcp-center-e2e | 38/38 | 0 | f40caac71cb5e8298b7659dde956775bc1a8ca31369c38ac83f467c7ebd85575 | 0 |
| mcp-stream-e2e | 20260928T065841Z-cce3-mcp-stream-e2e | 29/29 | 0 | 47ce54542391bd97806491c129077f63ce1a4ba225243c81eb6de4c1fa42960a | 0 |
| mcp-expiry-e2e idle（修前） | 20260928T065912Z-5288-mcp-expiry-e2e | 24/25（fail 1 = M1） | 1 | 0ed39614269dad2c12fb4a74a22a824b5698450063c06deba4ca8b639dd72259 | 0 |
| mcp-expiry-e2e idle（修后，最终有效） | 20260928T070551Z-f078-mcp-expiry-e2e | **26/26** | 0 | 37e9dbb9d93cbe2d662f981a70e18d3a5d13f4273950cf4e90c43d5e25955176 | 0 |
| 受影响性分析（静态） | 20260928T070745Z-e3b6-batch5-affectedness | 10/10 | 0 | 259d3dafa011e886714f604c45b564e0cc3250e8451df5b68d965e7f888c006f | — |

- 第四批链路在第五批代码上仍然全绿：expiry-idle 的 1h 检查给出 auth-error =「登录状态已过期，请重新登录。」（无内部枚举），1e 到期偏差 2ms、1f 收流 27ms、1g enabled 未改写 / revoked_reason=EXPIRED、6a 权威事件恰好 1 条。
- mcp-stream-e2e 按分析本可复用，仍重跑（成本 < 30s），复用口径与被复用 runId/sha256 已在上表前的 §3.1 写明。

### 3.3 policy R3 的失败定性（**未改**，交回决策）

- 失败项：R3 —「本批 c2e96c1→HEAD 的 diff 里 src/ 改动 ⊆ 白名单 ['src/mcp/McpCenter.tsx']」。实测 srcDiff = 4 个文件：src/mcp/McpCenter.tsx、src/identity/useIdentity.ts、src/identity/types.ts、src/identity/AuthScreens.tsx。
- 逐个可追到已验收批次：McpCenter.tsx / useIdentity.ts ← 第四批 7b75ea3；types.ts / AuthScreens.tsx ← 第五批 09dccf9。**按更新后的口径，白名单外文件 = 0**。
- 机制（对照第四批同一检查的 actual）：R3 用 git diff c2e96c1 HEAD（**提交历史**）取差；第四批运行时 HEAD 还是 8cbf8df，第四批自己的 src 改动还在工作树（gitDirtyLines=24）所以看不见；本批的改动提交后，同一条检查把第四/五批的 src 改动一并算进 diff。R3 的白名单是第三批写死的字面量数组（0aa4027），**是既有的、跨批不复位的 diff 白名单**。
- 结论：**功能行为零回归**；R3 是"对着第三批基线的陈旧白名单"。本批**不修改**它（改了就是改既有判定）。**建议**（未实施）：把 src-diff 腿改成「自白名单登记后新增的 src 改动才失败」或重定 R3_ALLOWED_SRC 为上述 4 个文件并保留每文件的引入提交/只增判据。

### 3.4 expiry M1 的口径修正（**已按指示修改既有门禁的一处判定逻辑，逐字披露**）

- 修前失败（20260928T065912Z-5288，M1 FAIL）：该检查最后一个合取项要求"工作树里对 src/mcp/McpCenter.tsx 的 diff 必须有一行文案改动"，写成 changed.length > 0 && every(文案)。第五批**没有改这个文件**，提交后工作树 diff 为空 → 它把"没有改动"判成 FAIL —— **验收脚本自己的假阳性，不是产品回归**。修前该检查的实质动效观测项（animationName=none、过渡 0s、reduced 下元素作用域 --dur-quick=0ms、说明行仍在且文案含"会话过期"）**全部通过**。
- 修法（选"等价语义"而不是"换基线 rev"，理由：换基线只把问题推迟到下一次提交，语义口径才是不依赖提交状态的）：**不存在"非文案改动行"**（空 diff 满足），另加两条非空转条件 —— (a) 该文件在 HEAD 里仍存在且确实带那句文案；(b) 与动效基线提交 8cbf8df（说明行文案定稿前）的差异里也没有非文案改动行。
- **未削弱实质断言**（机械证明）：补丁只新增 mcpCenterDiff 计算、期望文案与 M1b；motionNormal / motionReduced / isZeroDur / durQuick / animationName / transitionDuration / transitionProperty 等 9 个 token 在补丁的 +/- 行里 **0 处**出现。
- **负向自证（M1b，新增判定，不碰产品文件）**：用 git diff --no-index 在临时副本上做三种注入，判定必须翻成 FAIL —— ①注入一条样式改动 → FAIL；②把文案改写 → FAIL；③HEAD 缺那句文案时的空 diff → FAIL；空 diff + 文案在 → 通过。临时副本验完即删（tmpRemoved=true，临时目录扫描 0 残留）。
- 修后重跑：20260928T070551Z-f078-mcp-expiry-e2e → **26/26 全绿**（25 条 + 新增 M1b）。补丁留档：artifacts/d5-03/runs/20260928T070551Z-f078-mcp-expiry-e2e/m1-fix.patch（88 行，sha256 b375050f6bf08a05ceebfa0bded5d089ee0320e8603c97556f063ac62605b123；补丁全文也内嵌在 batch5-affectedness 产物 evidence.patch.patchText）。
- 同类排查（D4）：四段门禁里**参与判定**的 git-diff 子条件只有 2 处 —— 本处（已修）与 policy R3（未改，§3.3）。其余 git 调用只是 rev-parse / status --porcelain 的元数据留档，不参与判定。

---

## 4. 目标三：登录失败文案的视觉与动效验收

**有效证据**：runId \`20260928T070627Z-27eb-auth-error-visual\`，counts **16/17**（唯一 FAIL = 浅色对比度），exitCode 1，产物 sha256 **506f2a48ad42f906591487583f17a0162eef57d4940d24866509a2fcc41759a8**；脚本 experiments/d5-03/auth-error-visual.mjs（新增）。

### 4.1 截图（浅/深实机，窗口 1440×940 / DPR 2 / 默认壁纸 theme-dark / 材质 full / 主题走真实设置面板）

| 文件（runs/20260928T070627Z-27eb-auth-error-visual/visual/） | 状态 | 尺寸（设备像素） |
| --- | --- | --- |
| light-01-setup-password-mismatch.png | 浅色 · 向导两次密码不一致 | 2880×1880 |
| light-02-auth-error-row.png | 同上，错误行裁切（含 6px 边距） | 736×64 |
| light-03-settings-error.png / light-04-auth-error-row.png | 浅色 · 设置「显示名太长」 | 2880×1880 / 1164×64 |
| dark-01-setup-password-mismatch.png / dark-02-auth-error-row.png | 深色 · 同一条向导失败（重置后重新初始化） | 2880×1880 / 736×64 |
| dark-reduced-01-settings-error.png / dark-reduced-02-auth-error-row.png | 深色 + 减少动态效果 · 设置错误行 | 2880×1880 / 1164×64 |
| dark-03-login-invalid-credentials.png | 深色 · 登录页错误口令 | 2880×1880 |
| dark-04-login-rate-limited.png | 深色 · 登录连续失败到限流 | 2880×1880 |

实测文案（逐字）：
- 向导两次密码不一致 → **「输入不合法。两次输入的密码不一致。」**（浅/深一致；不出现旧括号形态「（两次输入的密码不一致）」、不出现标记 password-mismatch）。
- 设置「显示名太长」→ **「输入不合法。显示名太长了。」**
- 错误口令 → **「账号或密码不正确。」**；连续失败第 9 次 → **「尝试过于频繁，请稍后再试。」**（RATE_LIMITED 的 detail 是对象 {retryAfterMs}；旧实现会把 String(detail) 括注成「（[object Object]）」，现在被白名单过滤 —— 实测界面无 object/方括号字样）。

### 4.2 对比度量测（.auth-error 首次实机量测；12px/400 → 普通文本 4.5:1，DESIGN_SYSTEM.md:248）

方法（与第四批 §3 同法）：裁取错误行（含 6px 边距）→ 在页面内用 canvas 解码截图 → 背景取区域内出现次数最多的颜色（合成后的真实表面）→ 文字取与背景亮度差最大的像素 → WCAG 2.x 相对亮度 (L1+0.05)/(L2+0.05)。

| 面 | 主题 | 计算样式（元素自身） | 实测合成背景（占比） | 实测字形像素 | 对比度 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| **向导卡 .auth-error** | **浅色** | color rgb(215,0,21)；--failed = rgb(215 0 21 / 1)；12px / 400 / 行高 20.4px | **rgb(181,181,181)（92.3%）** | rgb(215,2,21) | **2.62:1** | **不通过** |
| 向导卡 .auth-error | 深色 | color rgb(255,69,58)；--failed = rgb(255 69 58 / 1)；12px / 400 | rgb(22,22,22)（69.5%） | rgb(255,69,57) | 5.31:1 | 通过 |
| 设置窗口面 .auth-error | 浅色 | 同浅色 token | rgb(251,251,251)（46.3%） | rgb(215,2,21) | 5.19:1 | 通过 |
| 设置窗口面 .auth-error | 深色 + 减少动态效果 | 同深色 token；--dur-quick 元素作用域 0ms | rgb(25,25,25)（29.6%） | rgb(255,69,57) | 5.16:1 | 通过 |

- **失败定性**：同一个 --failed 值在浅色**窗口面**（近白 251,251,251）上实测 5.19:1，说明**不是文字色本身不达标**；向导卡是玻璃卡片，浮在**默认深色壁纸**（theme-dark）之上，合成后成为中灰 181,181,181，红字在上面对比度掉到 2.62:1。要在这个面上达到 4.5:1，合成背景亮度需要 ≥ 约 #EBEBEB（L≈0.83），实测只有 L=0.462。
- **是否本批引入**：否。本批 81a211e→HEAD 的改动文件里没有任何 .css；.auth-error 规则（src/styles.css:2465-2470，只有 margin/font-size/color）本批一字未动。这是**既有缺口首次被实机量测暴露**（.auth-error 此前从无量测记录）。
- 建议（未实施，属产品/设计决策）：浅色玻璃卡面提高材质不透明度（或对卡片内的语义红改用更高对比的深红档 / 加 1px 深色描边不计入），并把"默认深色壁纸 + 浅色主题"列入 DESIGN_SYSTEM.md §10 的合成背景量测矩阵。

### 4.3 内部 detail 不进界面（真机 DOM 全文为证）

- 扫描 11 个内部标记：idle-expiry、absolute-expiry、session-missing、not-locked、no-stored-session、confirm-required、password-mismatch、password-too-short、identifier-taken、display-name-too-long、expired:idle/expired:absolute；以及旧括号形态「（kebab-case）」。
- 五个界面状态（浅色向导 / 深色向导 / 深色设置 / 深色登录页错误口令 / 深色登录页限流）全部 **0 命中**，bracketHits=[false×5]。
- 未在本次真机构造到的同类路径：idle-expiry（由第四批 mcp-expiry-e2e --scenario=idle 真机覆盖登录页文案，本轮已重跑）、session-missing / not-locked（产品 UI 不可达：restore 失败时渲染层只回登录页、不显示错误行；unlock 只在锁屏可用）→ 见 §5。
- 功能侧同一改动的 node 证据（W37 口径）也在本批测试里：tests/identity-session-expired-ui.test.mjs 对 253 个内部标记做了全量断言（本批提交自带；本次未改它）。

### 4.4 动效（本批未新增）

- 错误行元素自身的计算样式：常规（浅/深）transitionProperty=all、transitionDuration=**0s**、transitionDelay=0s、animationName=**none**、animationDuration=0s；减少动态效果下同样 animationName=none / 过渡 0s，且元素作用域 --dur-quick=**0ms**（.reduced 已压掉；:root 仍是 .16s，所以必须读元素作用域）、错误文案仍完整显示（信息不丢）。
- 代码级：本批改动文件集不含 .css；.auth-error 规则不含 transition/animation → 结论沿用第一至四批（错误行本来就没有过渡/动画，本批没有新增）。
- 迭代披露：本脚本前两轮 0cf1（脚本缺陷 textOf 未定义，V0 后中止）与 8298（V7 读取已卸载的设置元素时 getComputedStyle(null) 抛错，V1–V6 已跑出结果）都如实留在 runs/ 与 index 里；最终有效产物 = 27eb。

---

## 5. notVerified 清单（全部如实标注，不用推断替代）

| # | 条目 | 理由 | 现有替代证据 |
| --- | --- | --- | --- |
| 1 | 组织 ID 复用的**真机**对照（同一 org id 上「旧墓碑压制 → 重置后不压制」） | 产品没有"用指定 id 创建组织"的入口（identity/initialize 的组织 id 由产品随机生成；本批不新增创建组织入口）；不用改库构造 | node 受控测试 T3（现场重跑 exit 0，9/9），日志 runs/20260928T070842Z-9cd0-mcp-reset-e2e/node-reset-consistency.log；真机侧等价面：旧组织 0 行、全表 0 墓碑 |
| 2 | device_access 的重置清理证据（真机） | 重置前该表 0 行（0 → 0 不构成清理证据）：device_access 由 deviceService.grantDeviceAccess 写入，而 consumePairing 需要**另一台设备**带服务身份消费配对密钥；产品 IPC 只暴露 device/pairing.create\|list\|revoke 与 device/disable\|enable\|revoke\|rename\|audit，没有授权入口 | node 受控测试 T1/T2 在四表都非空（含 device_access）下验证了清理与同事务回滚；真机其余三表都做到"有行 → 0 行" |
| 3 | 产品侧 invariants() 的**原生**可读入口 | identity-store.cjs invariants() 只被 node 测试直接调用，identity:command 白名单里没有对应命令（本轮不新增产品入口，也不改判定） | 真机用同一判定的只读复算 invariantsEquivalentReadonly（脚本内，逐条等价），五个快照全部为空 |
| 4 | session-missing / not-locked 等内部 detail 的"界面不显示"真机构造 | 渲染层在这些路径上不显示错误行（restore 失败只回登录页；unlock 只在锁屏可用），真机不可构造 | 本批的五处真机 DOM 扫描 0 命中 + node 测试对 253 个内部标记的全量断言（tests/identity-session-expired-ui.test.mjs） |
| 5 | 浅色向导卡对比度达标 | 实测 2.62:1 < 4.5:1，**判定不通过**（不是未验收；如实记为视觉轴的部分通过） | 同 token 在浅色窗口面 5.19:1（定位为合成背景问题） |
| 6 | 第四批 MCP 窗口 1660×1140 与本批整窗截图"逐像素同尺寸" | 认证界面是全窗表面，第四批基准是 830×570 的 MCP 窗口裁剪；两者窗口/缩放/背景/透明度设置同口径，截图范围不同 | 窗口度量 V0：innerWidth/innerHeight=1440×940、DPR 2、data-glass=full、data-wallpaper=theme-dark、未开不透明 |

---

## 6. 边界声明

- 不接真实第三方服务；不发用户数据；不运行任意第三方本地程序；不声称插件隔离通过（D5-04 范围）。
- 探针对数据库**只读**（DatabaseSync readOnly）；所有授权状态的产生/撤销/重置都由产品自己的命令路径完成（identity/resource/governance/mcp 命令层），没有任何"改库代替主路径"。
- 工具调用入口仍未开放（MCP_TOOL_INVOCATION_NOT_ENABLED）；协议仍 2025-06-18（fixture 参照握手）；没有新增"创建组织"入口。
- 串行：同一时刻只有一个本脚本启动的 Electron；每次运行独立 runId 产物目录、只追加索引、独占 CDP 端口；收尾只清自己的 pid 树（pkillUsed=false）与自建临时目录；运行结束 /var/folders/*/*/T/oa-d503b-* 残留 = **0**。
- 工作树：产品代码未改；唯一的已跟踪修改是**按指示**对既有门禁 experiments/d5-03/mcp-expiry-e2e.mjs 的口径修正（§3.4 逐字披露 + 补丁留档）；其余为本批新增脚本/报告（未跟踪）。

---

## 7. 产物索引（runId / sha256 / 路径）

| 用途 | runId | counts / exit | 产物 sha256（JSON） |
| --- | --- | --- | --- |
| 目标一 真机重置一致性 | 20260928T070842Z-9cd0-mcp-reset-e2e | 26/26 · exit 0 | 17202b482ffea7aa587f7fb0f9d0e6cd92342997b424852450fa6e00fee37766 |
| 目标一 首轮（含探针缺陷披露） | 20260928T065649Z-d18e-mcp-reset-e2e | 26/26 · exit 0 | 495964b8ca826caf078dd542e9d88af027f2d4e6b07292fa32c38ad8d913d315 |
| 目标二 policy | 20260928T065727Z-b56c-mcp-policy-e2e | 42/43 · exit 1 | 34d9fdd8866128cf181b9d9bafa1b73133f072db77a6760c62f07ed2f132e233 |
| 目标二 center | 20260928T065801Z-c7ba-mcp-center-e2e | 38/38 · exit 0 | f40caac71cb5e8298b7659dde956775bc1a8ca31369c38ac83f467c7ebd85575 |
| 目标二 stream | 20260928T065841Z-cce3-mcp-stream-e2e | 29/29 · exit 0 | 47ce54542391bd97806491c129077f63ce1a4ba225243c81eb6de4c1fa42960a |
| 目标二 expiry idle（修前） | 20260928T065912Z-5288-mcp-expiry-e2e | 24/25 · exit 1 | 0ed39614269dad2c12fb4a74a22a824b5698450063c06deba4ca8b639dd72259 |
| 目标二 expiry idle（修后·有效） | 20260928T070551Z-f078-mcp-expiry-e2e | 26/26 · exit 0 | 37e9dbb9d93cbe2d662f981a70e18d3a5d13f4273950cf4e90c43d5e25955176 |
| 目标三 视觉/动效 | 20260928T070627Z-27eb-auth-error-visual | 16/17 · exit 1 | 506f2a48ad42f906591487583f17a0162eef57d4940d24866509a2fcc41759a8 |
| 目标二 受影响性分析 | 20260928T070745Z-e3b6-batch5-affectedness | 10/10 · exit 0 | 259d3dafa011e886714f604c45b564e0cc3250e8451df5b68d965e7f888c006f |
| M1 口径修正补丁 | （20260928T070551Z-f078 目录内） | — | m1-fix.patch sha256 b375050f6bf08a05ceebfa0bded5d089ee0320e8603c97556f063ac62605b123 |

每个 run 目录内均有：<script>.json + .sha256 + .log；视觉/动效 run 另有 visual/ 截图；reset run 另有 node-reset-consistency.log；索引 artifacts/d5-03/runs/index.json（只追加）。
本次新增脚本：experiments/d5-03/mcp-reset-e2e.mjs、experiments/d5-03/auth-error-visual.mjs、experiments/d5-03/batch5-affectedness.mjs。
本次修改脚本（披露）：experiments/d5-03/mcp-expiry-e2e.mjs（仅 §3.4 所述口径修正 + 新增 M1b）。

---

## 8. 遗留

1. **浅色向导卡 .auth-error 对比度 2.62:1（既有缺口，本批首次量测暴露）**：需要产品/设计决策（提高卡面材质不透明度，或浅色下用更高对比的红档，或把该行放到不透明表面上）。本批未改样式。
2. **policy R3 的陈旧 src 白名单**：本轮保持原样（42/43），建议按 §3.3 重定基线；重定后 policy 门禁会回到 43/43。
3. 减少动态效果设置**不跨重启持久**（main.tsx:473 只读 localStorage 的 oa-motion，未发现写入点）—— 与本批无关的既有观察，如实记录，未改动。
4. 登录连续失败到限流需要 8 次失败（RATE_LIMIT.MAX_FAILURES=8）后第 9 次才回 RATE_LIMITED；真机实测第 9 次命中，可作后续限流类验收的口径参考。

---

## 9. R3 门禁重基线（第五批补跑 · 本机 2026-09-28 15:17–15:18 / UTC 07:17）

> **本节为追加**，上面任何一行都没有改动。它取代 §0 结论表的「policy 42/43」、§3.2 表的 policy 行、§3.3「R3 未改，交回决策」与 §8 遗留第 2 条。
> **定性：这是门禁基线更新（旧基线写死的白名单对新提交已过期），不是判定削弱。** R3 要证明的那件事（K 段那些失败来自「授权已撤的空态上下文」而不是本批代码回归）与 kAllCascade 那套判据一字未动；放行面也没有变宽成「有改动就算过」—— 登记表之外的任何 src/ 改动照样 FAIL（负向自证见 §9.4）。

### 9.1 旧口径 → 新口径（逐字）

| 项 | 旧口径（0aa4027 第三批写入，本轮之前） | 新口径（本轮） |
| --- | --- | --- |
| 基线 | R3_BASE_REV = "c2e96c1" | 同左（不变） |
| 放行集合 | R3_ALLOWED_SRC = ["src/mcp/McpCenter.tsx"]：一个写死的文件数组 | R3_REGISTRY：4 条登记项，每条带 batch（哪一批 · 什么改动）、why（为什么允许改）、requireAdded（必含标记）、forbidCode（禁含形态）、addOnly（是否要求只增不删） |
| 逐条判据 | 只增不删（numstat 全部形如 N TAB 0 TAB）+ 补丁任意位置出现 MCP_SESSION_ENDED | 见 §9.2 逐条表：必含标记按词边界匹配、HEAD 不变量必须成立；禁含形态在「新增行代码」与「HEAD 代码行」两处都必须 0 命中 |
| 表外 src 改动 | FAIL | FAIL（不变） |
| 取不到 git | FAIL（srcDiff = "git-diff-failed" → 表外集合非空） | FAIL（diffOk=false；逐个文件的 patch / numstat / blob 任一为 null 也 FAIL） |
| 判定式 | srcDiffOutsideWhitelist.length === 0 && srcWhitelistAddOnly && (kFails.length === 0 \|\| kAllCascade) | r3Src.ok && (kFails.length === 0 \|\| kAllCascade) |
| kFails / kCascadePattern / kAllCascade | K1–K4/L2/L4 + 空态正则 | **原样未动**（同一段代码、同一个正则、同一个选取集合） |

新增的两条「防蒙混」细节（都是**加强**，不是放宽）：

1. 必含标记按**词边界正则** \bMARKER\b 匹配（旧实现是 String.includes）：把 SHOWABLE_ERROR_DETAIL 改名成 SHOWABLE_ERROR_DETAIL_OFF 这类带前后缀的串**不算命中**。
2. 必含标记在 **HEAD 里必须真的存在**（git show HEAD:<file> 去掉注释后的代码行）；本区间改了这个文件时，还必须同时出现在新增行里。理由：某个文件若被**整段回退**，它就不再出现在 c2e96c1→HEAD 的 diff 里，只按 diff 判会放行 —— 这一点是负向自证 (c1) 第一版抓出来的我自己的漏洞（见 §9.4）。

### 9.2 新登记表逐条（每条为什么允许改 + 机械判据 + 本轮实测）

| 文件 | 对应批次 · 为什么允许改（why） | 机械判据 | 本轮实测（HEAD 09dccf9，区间 c2e96c1→HEAD） |
| --- | --- | --- | --- |
| src/mcp/McpCenter.tsx | 1b78953 · 第三批（流式收口 + 生命周期收尾接线）：会话被撤 / 自然过期后活连接、GET 流与在途请求都已收掉，界面必须给出「会话已结束」的说明，否则用户把 DISABLED 误读成连接故障 | addOnly=true：numstat 必须全部 N TAB 0 TAB；requireAdded: MCP_SESSION_ENDED（词边界，新增行） | numstat=8 TAB 0（**只增不删仍成立**，第三批那条判据原样保留）；MCP_SESSION_ENDED 命中 HEAD=2 / 新增行=2 → PASS |
| src/identity/types.ts | 09dccf9 · 第五批：errorText 改成「code 那一句 + SHOWABLE_ERROR_DETAIL 白名单」，detail 只有进表才换成一句人话，表外一律丢弃；同时删掉 detail 原样括注给用户的旧形态 | requireAdded: SHOWABLE_ERROR_DETAIL；forbidCode: R3_DETAIL_LEAK（见下方正则）在「新增行代码」与「HEAD 代码行」都必须 0 命中（注释不算：先去掉块注释与整行注释） | numstat=112 TAB 3（**不是**只增改动，所以没有硬套只增判据，改用等价强度的标记+禁含判据，由 §9.4 的 (c1)/(c2) 证明有牙）；标记 HEAD=2 / 新增行=2；禁含形态 新增 0 / HEAD 0 → PASS |
| src/identity/useIdentity.ts | 7b75ea3 · 第四批（会话自然过期收流 + 策略收口）：身份事件收敛抽成纯函数 identityEventConvergence（自然到期与登出走同一条路），并去掉把事件 reason 当 detail 传给 absorb 的写法 —— 那个 detail 会经 errorText 括注给用户 | requireAdded: identityEventConvergence；forbidCode: R3_EVENT_REASON_DETAIL（见下方正则）两处都必须 0 命中 | numstat=18 TAB 18；标记 HEAD=2 / 新增行=3；禁含形态 新增 0 / HEAD 0 → PASS |
| src/identity/AuthScreens.tsx | 09dccf9 · 第五批（渲染层只发标记、不写第二份人话）：向导两次密码不一致只发 password-mismatch 标记，人话交给 types.ts 的白名单，渲染层不再自己写第二份文案（两份会各自漂移） | requireAdded: password-mismatch | numstat=2 TAB 1；标记 HEAD=1 / 新增行=1 → PASS |

```js
R3_DETAIL_LEAK          = /\$\{[^}\n]*\bdetail\b[^}\n]*\}|\bString\(\s*detail\s*\)/
R3_EVENT_REASON_DETAIL  = /\bdetail\s*:\s*event\s*\.\s*reason\b/
```

### 9.3 未削弱的机械对照

- **表外不放行**：outsideRegistry 非空即 FAIL（(a1)/(a2) 实跑证明，见 §9.4）。
- **fail-closed 更严**：旧版只有一处「git diff 取不到」的兜底；新版对每个登记项还要查 patch / numstat / HEAD blob 三样，任一取不到即该项 FAIL。
- **只增不删没有丢**：McpCenter.tsx 仍要求 N TAB 0 TAB（本轮实测 8 TAB 0）。三条非只增的登记项改用「必含本批标记 + 禁含被修掉的旧形态 + HEAD 不变量」，并用负向自证逐条证明判据会翻 FAIL。
- **K 段语义没动**：kFails 的选取集合、kCascadePattern 正则、kAllCascade 及其在 R3 判定式里的位置逐字符未变；R3 的检查文案与 expected 仍写明「下游失败的实际值全是列表空 / 没有行可采样 / 删除即时 / NO_MCP_GRANT 的授权已撤上下文」。

### 9.4 负向自证（实跑输出，副本已删）

手段（原仓库零写入）：git clone --shared 建副本 → 副本上开 5 条分支各注入一处 → 用**同一份** r3SrcDiffEvaluation 判定。判定入口是本轮新增、**默认关闭**的自证模式：只在显式给 OA_D503_R3_SELFTEST_ROOTS 时生效，不启动 Electron、不建 run 目录、不写副本；正常门禁不设这个变量，走的是同一个函数。

```bash
git clone --shared --quiet "<workspace>" "$TMP/repo"
cd "$TMP/repo"
# a1：白名单外新增
git checkout -B mut-a-new <HEAD>   && printf "export const R3_SELFTEST_EXTRA = true;\n" > src/identity/r3-selftest-extra.ts && git commit -am a1
# a2：白名单外修改既有文件
git checkout -B mut-a-mod <HEAD>   && (首行插入一行注释到 src/main.tsx) && git commit -am a2
# b：把第四批修掉的根因塞回去
git checkout -B mut-b-reason <HEAD> && sed -i '' 's/absorb({ ok: false, error: intent.errorCode }, "unauthenticated")/absorb({ ok: false, error: intent.errorCode, detail: event.reason }, "unauthenticated")/' src/identity/useIdentity.ts && git commit -am b
# c1：白名单机制整段退回
git checkout -B mut-c-revert <HEAD> && git checkout c2e96c1 -- src/identity/types.ts && git commit -am c1
# c2：只把标记改名（隔离「必含标记」这一条腿）
git checkout -B mut-c-rename <HEAD> && sed -i '' 's/SHOWABLE_ERROR_DETAIL/SHOWABLE_ERROR_DETAIL_OFF/g' src/identity/types.ts && git commit -am c2

# 判定（6 个用例：1 个对照 + 5 个注入；expect 是预先写死的期望）
OA_D503_R3_SELFTEST_ROOTS='[{"root":"$TMP/repo","headRev":"mut-a-new","expect":"fail"}, …]' node experiments/d5-03/mcp-policy-e2e.mjs
```

注入补丁（副本内 git diff <base> <branch> --numstat + 关键行）：

| 用例 | 注入补丁 |
| --- | --- |
| a1 mut-a-new | 1 TAB 0 TAB src/identity/r3-selftest-extra.ts · +export const R3_SELFTEST_EXTRA = true; |
| a2 mut-a-mod | 1 TAB 0 TAB src/main.tsx · +// r3 selftest：白名单外修改既有 src 文件 |
| b mut-b-reason | 1 TAB 1 TAB src/identity/useIdentity.ts · -absorb({ ok: false, error: intent.errorCode }, "unauthenticated"); +absorb({ ok: false, error: intent.errorCode, detail: event.reason }, "unauthenticated"); |
| c1 mut-c-revert | 3 TAB 112 TAB src/identity/types.ts（整个文件退回 c2e96c1） |
| c2 mut-c-rename | 2 TAB 2 TAB src/identity/types.ts · -export const SHOWABLE_ERROR_DETAIL: … +export const SHOWABLE_ERROR_DETAIL_OFF: … |

判定输出（脚本 JSON 输出的**决定性字段逐字摘录**；完整行用上面的命令可复现）：

| 用例 | headRev | head | 期望 | 实测 | 决定性证据 |
| --- | --- | --- | --- | --- | --- |
| (0) 对照：副本未改动（显式 sha） | 09dccf9…（全 sha） | 09dccf9 | pass | **PASS** | outsideRegistry=[]；4 条登记项 ok=true（numstat 8/0 · 112/3 · 18/18 · 2/1） |
| (a1) 白名单外**新增** src/identity/r3-selftest-extra.ts | mut-a-new | b57bd73 | fail | **FAIL** | outsideRegistry=["src/identity/r3-selftest-extra.ts"] |
| (a2) 白名单外**修改**既有 src/main.tsx | mut-a-mod | f442855 | fail | **FAIL** | outsideRegistry=["src/main.tsx"] |
| (b) 把 detail: event.reason 塞回 useIdentity.ts | mut-b-reason | 12f285b | fail | **FAIL** | failedEntries=["src/identity/useIdentity.ts"]；forbidden hitsInHeadCode=1 / hitsInAddedCode=1；样例行 = absorb({ ok: false, error: intent.errorCode, detail: event.reason }, "unauthenticated"); |
| (c1) types.ts 整段退回 c2e96c1 | mut-c-revert | d417bff | fail | **FAIL** | failedEntries=["src/identity/types.ts"]；markers SHOWABLE_ERROR_DETAIL：HEAD=0 / 新增=0；forbidden：HEAD=2 / 新增=0；numstat=""（该文件已不在 diff 里，靠 HEAD 不变量抓到） |
| (c2) 只把 SHOWABLE_ERROR_DETAIL 改名 | mut-c-rename | af6b6c2 | fail | **FAIL** | failedEntries=["src/identity/types.ts"]；markers SHOWABLE_ERROR_DETAIL：HEAD=0 / 新增=0（词边界匹配，_OFF 后缀不算命中） |

harness 末行（逐字）：`R3 负向自证：全部符合预期（6 个副本）`，进程退出码 **0**。

**首轮抓到我自己的两处漏洞（如实披露，均已修并复跑）**：

- (c1) 第一版实现「登记项不在 diff 里 → 直接跳过」放过了整段回退，实测 verdict=PASS、matched=false（与期望 fail 不符）。修法：必含标记改成 HEAD 不变量（§9.1 第 2 条）。
- (c2) 第一版用 String.includes 匹配标记，SHOWABLE_ERROR_DETAIL_OFF 含该子串 → 实测 verdict=PASS、matched=false。修法：改成词边界正则（§9.1 第 1 条）。
- 中间还有一轮对照 FAIL：那是**自证用例写错**（对照组的 headRev 用了副本的 HEAD，而副本已被 checkout 到 mut-c-rename 分支），改用显式 sha 后对照 PASS —— 工装问题，不是判定问题，一并记录。
- 副本跑完即删：/var/folders 下 oa-d503-r3-selftest.* 残留 = 0；原仓库未新增分支（无 mut-*）、HEAD 仍 09dccf9。

### 9.5 重跑结果（串行：同一时刻只有一个本脚本启动的 Electron）

| 项 | 值 |
| --- | --- |
| 命令 | node experiments/d5-03/mcp-policy-e2e.mjs |
| runId | **20260928T071705Z-db3d-mcp-policy-e2e** |
| counts | **pass 43 / fail 0 / total 43** |
| notVerified | **2**（与第四批口径一致，条目未变） |
| exitCode | **0** |
| 产物 | artifacts/d5-03/runs/20260928T071705Z-db3d-mcp-policy-e2e/mcp-policy-e2e.json |
| artifact sha256 | **18fe75ba8a651b1427632ef2134955dc9af73bda593d988951912e147c0efa2f**（与同目录 .sha256 文件逐字一致） |
| 脚本 sha256 | 5577b18ea90301e5ee0aacfbf053450d264ea59c3c23b70b625279e3686f7635 |
| 起止 / 耗时 | 2026-09-28T07:17:05.199Z → 07:17:41.244Z（36.0s） |
| 收尾 | 8 个实例的 pid 树 leftovers 全空、pkillUsed=false、5 个自建 userData 目录全部 REMOVED |

R3 本轮记录（checks[].actual 受 2600 字上限，这里给决定性字段；完整逐条证据在产物 observations 的「R3 登记表逐条证据（完整）」里）：status=PASS，srcDiffOutsideRegistry=[]，diffOk=true，4 条登记项 ok=true；McpCenter numstat=8 TAB 0、MCP_SESSION_ENDED 新增行 ×2；types.ts 标记新增行 ×2、禁含形态 新增 0 / HEAD 0；useIdentity.ts 标记新增行 ×3、detail: event.reason 新增 0 / HEAD 0；AuthScreens.tsx password-mismatch 新增行 ×1。

### 9.6 与上一轮 42/43 的差异（机械比对两次产物）

- checks 条数：43 = 43；notVerified：2 = 2；首轮产物 (20260928T065727Z-b56c) 与本轮按位置逐条比对 → **唯一差异 = R3：FAIL → PASS**。
- 其余 42 条（R1/R2 与全部 A–L、Z 段）状态一字未变 —— 本轮只翻了一面门，没有连带改动任何别的判定结果。

### 9.7 索引 / 产物 / 临时目录核对

- 索引 artifacts/d5-03/runs/index.json：schema=1，runs **44** 条（本轮新增 1 条，只追加）。
- 历史证据未被改写：对索引里全部 44 个 runId 的 artifactPath 重算 sha256，与索引里的 artifactSha256 逐一比对 → **checked=44 / mismatch=0 / missing=0**。
- 临时目录：ls -d /var/folders/*/*/T/oa-d503b-* → **空**（0 残留）。
- 前置披露（不是本轮产生、也没有删）：/var/folders/…/T/oa-d503e-probe-YebU49（前缀 oa-d503e 属 experiments/d5-03/mcp-expiry-e2e.mjs 的探针，mtime 14:35，早于本轮）。按「只清理自己的 pid 树 / 目录」原则**未删除**，如实记录。

### 9.8 本轮改动（只改一个文件，未 commit / 未 push / 未切分支）

| 文件 | diff stat | 说明 |
| --- | --- | --- |
| experiments/d5-03/mcp-policy-e2e.mjs | 1 file changed, **160 insertions(+), 18 deletions(-)** | ① 白名单换成登记表 + 逐条机械判据（模块级 R3_REGISTRY / r3SrcDiffEvaluation / r3MarkerRegex / r3CodeLines / r3StripBlockComments）；② main() 的 R3 段改成调用它，完整证据进 observations、判定摘要进 checks[].actual；③ 新增默认关闭的负向自证入口（OA_D503_R3_SELFTEST_ROOTS） |

- 未改：产品代码、其余门禁脚本的判定（experiments/d5-03/mcp-expiry-e2e.mjs 的工作树修改是 W39 遗留，不是本轮）；HEAD 仍 09dccf9，分支仍 integration/ui-core。
- R3 之外的三段（R1 读第一批产物、R2 分类、Z 收尾）与 K 段级联判据均未动。

### 9.9 遗留

1. **登记表是跨批不复位的**：第六批若合法改到这 4 个文件之外，或改掉任一条的必含标记 / 引入禁含形态，R3 会 FAIL —— 这是设计意图（fail-closed），届时按同一形态新增或更新登记项，并重跑 §9.4 的负向自证即可。
2. 浅色向导卡对比度 2.62:1（§4 / §8 第 1 条）与本轮无关，仍然遗留。
3. §8 遗留第 2 条（policy R3 陈旧白名单）**已由本节关闭**。

