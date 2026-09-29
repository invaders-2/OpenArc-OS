# D5-03 第八批 · 独立验收报告（dsh 运行时 PIN）

- 工作区：`/Users/wepingli/Desktop/OpenArc OS-integration`
- 分支：`integration/ui-core` · HEAD = `3bbb34741f17039982f1390f9913f7a5ac64a38b`（`3bbb347`，被测提交）
- 验收时间：2026-09-29 04:57Z – 05:15Z
- 证据目录：`experiments/d5-03/batch8/`（附 `sha256-manifest.txt`）
- 未改任何产品代码 / 测试 / 断言；未 commit / push / 切分支
- 验收后 `git status --porcelain` 仅 `?? experiments/d5-03/batch8/`

## 结论

**PIN 本身成立，主要结论与交接说明一致。** 版本/来源、四元组、三条拒绝路径、不回退、4 条版本漂移失败修复、7/7 契约、5 个受影响门禁（211/211）全部通过。

**但全量 `npm test` 是 1383 / 1380 / fail 3 / exit 1**，比交接说明的"预存 2 条"多 1 条：多出来的是**环境型 flake**（`task-harness-cancel`，单跑 3/3 通过 ×3 次），不是回归。另有 1 条同类 flake 在 `tool-dsh-lifecycle` 上被我自己首次触发（复跑 + 3 次探针全过）。详见 §3.3 / §5。

**flake 归因已补做 A/B 实测（§八）**：0.1.5-rc.2 与 0.2.0-rc.1 的启动成本**同量级**（`--version` p50 40.9 vs 46.4 ms；真实 ACP boot p50 474.4 vs 445.2 ms，差异 ~±7%），而失败那次需 >30 s（约为正常启动的 40–65 倍）——**量级上版本差异无法解释，flake 与本批 PIN 无关**。超时预算的处置**留给单独批次裁决，本批不改任何超时/断言**。

---

## 一、独立复核

### 1.1 版本与来源（`01-version-provenance.txt` · sha256 `12eb3537…`）

| 项 | 实测值 |
|---|---|
| `node_modules/@deepseek-ai/dsh/package.json` version | `0.1.5-rc.2`（bin `{"dsh":"lib/bin.js"}`） |
| `node_modules/@agentclientprotocol/sdk/package.json` version | `1.4.0` ✔ 仍为 1.4.0 |
| `package.json` dsh 声明 | L91 `"@deepseek-ai/dsh": "0.1.5-rc.2"` — **精确版本，无 `^` / ``** |
| `package.json` SDK 声明 | L90 `"@agentclientprotocol/sdk": "1.4.0"` |
| 锁文件 resolved | `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.2.tgz` |
| 锁文件 integrity | `sha512-8Xc8hCQHcIWRmTCVU/xZdp6/qMsWMeAd2ObChKDEsfhUPJFXx6H0lgeb1DxUMD86HZrrVN+1bCvn1ppjZ/fOxw==` |
| `realpath node_modules/.bin/dsh` | `/Users/wepingli/Desktop/OpenArc OS-integration/node_modules/@deepseek-ai/dsh/lib/bin.js` |
| `ls -la node_modules/.bin/dsh` | `→ ../@deepseek-ai/dsh/lib/bin.js`（相对软链，落在项目内） |
| lockfileVersion | 3（root devDependencies 同 pinned 值） |

**`package.json` 中 dsh 为精确版本（无 `^` / `` 前缀）**，锁文件 resolved 指向 registry 的 `dsh-0.1.5-rc.2.tgz` 且 integrity 为 sha512 完整哈希。

### 1.2 解析器四元组（默认分支，无任何覆盖）（`02-resolvers-quadruple-and-rejections.txt` · sha256 `9bde0c55…`）

    runtime    = /Users/wepingli/Desktop/OpenArc OS-integration                        (=== 仓库根: true)
    bin        = /Users/wepingli/Desktop/OpenArc OS-integration/node_modules/.bin/dsh  (exists: true)
    dshVersion = 0.1.5-rc.2                                                            (=== PINNED_DSH_VERSION 常量: MATCH)
    sdkPath    = /Users/wepingli/Desktop/OpenArc OS-integration/node_modules/@agentclientprotocol/sdk/dist/acp.js
    sdkVersion = 1.4.0

### 1.3 不回退（对抗性）

| # | 用例 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| a | `OPENARC_DSH_RUNTIME=<空临时目录>` | `DSH_RUNTIME_MISSING` | `DSH_RUNTIME_MISSING: OPENARC_DSH_RUNTIME …/empty-runtime 内没有 @deepseek-ai/dsh` | ✔ |
| b | `OPENARC_DSH_RUNTIME=<假 package.json 0.2.0-rc.1>` | `DSH_VERSION_MISMATCH` | `DSH_VERSION_MISMATCH: … 需要 0.1.5-rc.2，实际 0.2.0-rc.1` | ✔ |
| c | `OPENARC_DSH_RUNTIME=<真实 DSH Desktop 共享运行时>` | `DSH_VERSION_MISMATCH` | `DSH_VERSION_MISMATCH: OPENARC_DSH_RUNTIME /Users/wepingli/Library/Application Support/DSH Desktop/runtime 需要 0.1.5-rc.2，实际 0.2.0-rc.1` | ✔ **未采用** |
| c' | 同上，另走 `resolveDshBin()` 与 `OPENARC_DSH_BIN=<共享 bin>` | 也拒绝 | 两者均 `DSH_VERSION_MISMATCH` | ✔ |
| d | 默认分支源码无 `DSH Desktop` 字面量（注释不算） | 0 条代码行 | 见下 | ✔ |
| e | `OPENARC_DSH_BIN=<不属于任何 dsh 安装的假可执行文件>` | 拒绝 | `DSH_RUNTIME_MISSING: OPENARC_DSH_BIN …/orphan/dsh 不属于任何 @deepseek-ai/dsh 安装` | ✔ |

**c 的存在性前提已实测**：共享运行时真实存在，其 `node_modules/@deepseek-ai/dsh/package.json` version = **`0.2.0-rc.1`**，且 `node_modules/.bin/dsh` 存在 —— 即"它可用"，解析器仍拒绝。契约测试也独立打印了 `# 回退目标真实存在（非空证明）：/Users/wepingli/Library/Application Support/DSH Desktop/runtime`。

**d 的判定方法**（`scan-dsh-desktop-literal.cjs`，`03-dsh-desktop-literal-scan.txt` · sha256 `6d3924ec…`）：逐字符把 709 个源文件（排除 node_modules/.git/dist/artifacts/build）标注为 `comment | string-literal | BARE-CODE`，再按行定位字面量。

| 上下文 | 条数 | 位置 |
|---|---|---|
| comment | 3 | `electron/harness-adapter.cjs:37`（块注释）、`tests/d5-03-dsh-runtime-pin.test.mjs:5`、本批扫描器自身 |
| string-literal | 6 | 本批探针 2 条、本批扫描器 1 条、`tests/d5-03-dsh-runtime-pin.test.mjs` 3 条 |
| **BARE-CODE** | **0** | — |

产品代码（`electron/`、`src/`）内**非注释命中 = 0**。唯一注释命中在 `electron/harness-adapter.cjs:37`（"绝不借用 DSH Desktop 共享运行时"），按"注释不算"规则不影响判定。契约测试自身必须在字符串里写共享运行时路径，才能断言"绝不返回它"——属正当引用。**判定：PASS。**

**e 的补充**（`probe-dshbin-b8.cjs`，`04-dshbin-rejection.txt` · sha256 `a00f1496…`）：

- e1 孤儿假 bin → `DSH_RUNTIME_MISSING` ✔
- e2 假 bin 自称归属一个 planted `9.9.9-fake` 安装 → `DSH_VERSION_MISMATCH` ✔
- e3 PATH 前置假 `dsh` → `resolveDshBin()` 仍返回项目内 bin，**未取 PATH 影子** ✔
- e4 **阳性对照**：真实项目内 bin（`node_modules/@deepseek-ai/dsh/lib/bin.js`）→ 正常接受 ✔（证明不是"一律拒绝"）
- e5 版本正确但无 `.bin/dsh` 的运行时 → 返回 `null`（代码约定的"缺 bin"语义，由调用方以 `NOT_STARTED` 区分；非静默采用外部 bin）✔

### 1.4 修复确认（`05-fix-confirm-3files.txt` · sha256 `64f3b10f…`）

    node --test tests/harness-acp-isolation.test.mjs tests/harness-acp-protocol.test.mjs tests/tool-dsh-facade.test.mjs
    # tests 12 / # pass 12 / # fail 0 / EXIT=0

**修前 vs 修后对照**（修前清单取自 `experiments/d5-03/baseline-before-pin.txt`）：

| 用例 | 修前 | 修后 |
|---|---|---|
| `D4-02B-I5 · dsh / SDK 版本来自冻结路径（PIN，不走用户 PATH）` | **not ok**（expected `0.1.5-rc.2` / actual `0.2.0-rc.1`） | ok |
| `D4-02B-P1 · initialize / session-new / prompt / update / close（ACP v1）` | **not ok**（同上版本漂移） | ok |
| `D4-02B-P2 · Model 链路：… Provider 收到 key` | **not ok**（`Fake Provider 必须收到请求` true≠false） | ok |
| `official dsh 0.1.5-rc.2 … exactly 2 个 READ_ONLY tool` | **not ok**（版本漂移） | ok |
| 合计 | tests 12 / pass 8 / fail 4 / exit 1 | **tests 12 / pass 12 / fail 0 / exit 0** |

与 W48 自报的"3 文件 12/8/4（I5/P1/P2/facade）"**逐条吻合**。

### 1.5 契约测试（`06-contract-pin.txt` · sha256 `22817f8a…`）

    node --test tests/d5-03-dsh-runtime-pin.test.mjs
    A 默认解析=项目本地根+PIN / B 无 dsh→MISSING / C 版本不符→MISMATCH 且与"缺失"可区分 /
    D 不回退证明 / E SDK 1.4.0 / F 源码级锁 / G OPENARC_DSH_BIN 校验且合法覆盖可用
    # tests 7 / # pass 7 / # fail 0 / EXIT=0

---

## 二、六类真实链路

运行时全部为固定 `node_modules/@deepseek-ai/dsh@0.1.5-rc.2`。**真实 dsh 进程**由 `harness-acp-protocol`（P1–P4）、`harness-acp-cancel`（C1–C3）、`harness-acp-lifecycle`、`tool-dsh-facade`、`tool-dsh-lifecycle`、`side-effect-c4-dsh-write`、`harness-acp-isolation`（I3）启动。
`harness-acp-permission` 与 `task-harness-fixture` 用 `dshBin: process.execPath` + 脚本化 agent（**但 `resolveDshRuntime()` 仍无条件校验 PIN**）。

| 类别 | 文件（证据 sha256 前缀） | 计数 | exit |
|---|---|---|---|
| **1 真实 ACP 启动** | `07-cat1-acp-protocol.txt` `4fcf9a41` | 4/4（P1 initialize / session-new / prompt / update / close） | 0 |
| | `08-cat1-cat6-tool-dsh-lifecycle.txt` `d9d085b6` | **1/2（首次 flake）** → 复跑 `14` `72677008` **2/2** + 探针 `15` `43d729fe` **2/2 ×3** | 见 §5 |
| **2 模型代理** | `07` P2：Harness→Adapter→Model Proxy→Fake Provider，`fp.state.requests >= 1`（Provider 收到请求/凭据） | ok | 0 |
| | `09-cat2-c4-dsh-write.txt` `6f17451e`（C4 WRITE 真实链路） | 5/5 | 0 |
| **3 只读工具** | `13-cat3-tool-dsh-facade.txt` `cac103af`：official profile bundle 加载 OpenArc Tool Plugin，**exactly 2 个 READ_ONLY tool** | 3/3 | 0 |
| **4 权限拒绝** | `10-cat4-acp-permission.txt` `dd700ddf`（`harness-acp-permission.test.mjs` 存在） | 1/1 | 0 |
| **5 取消** | `11-cat5-acp-cancel.txt` `3fd3c6d7`（`harness-acp-cancel.test.mjs`） | 3/3 | 0 |
| **6 进程清理** | `12-cat6-acp-lifecycle.txt` `7100edc5` | 3/3 | 0 |
| **7 密钥不外泄** | `07` P3 + `16-secret-scan.txt` `99b2271a` | 见 §4 | 0 |

**权限拒绝的真实计数**（`harness-acp-permission.test.mjs`，断言原文）：
`adapter.permissions.length === 1`（收到 **1** 次 permission request）、`permission.requested` 事件存在、`r.text` 含 `permission outcome: cancelled`（client reject）、`tool.proposed` 事件 = **false**（0 次已执行 tool）、`fx.fp.state.requests === 0`（**0** 次触达 Provider）。

**取消的真实计数**（`harness-acp-cancel.test.mjs`）：C1 `Provider 被请求次数差 === 1`（**0 retry**）+ `fp.state.closed >= 1`（Provider 连接被关）+ `dispose().exited === true`；C2 child crash → `HARNESS_PROCESS_EXITED`，无 respawn / 无 retry；C3 turn timeout 有界。

**进程清理实测**（`20-postrun-state.txt` `5e1bb8d7`）：跑完后 `ps` 中 **0 个** argv 含 `OpenArc OS-integration/node_modules/@deepseek-ai/dsh` 的进程（0 orphan）。同时存在的 `dsh` 进程只有宿主 GUI 自身的：`22841 dsh/lib/bin.js web --port 64392`（ppid 20242）及其 `dsh-ptc-runtime-node` 子进程——属**会话宿主**，非本任务产物，未触碰。

---

## 三、门禁与全量

### 3.1 受影响性分析表

判定依据：静态扫描 `experiments/*/run-all.mjs` 与 `tests/*.mjs` 是否 require `electron/harness-adapter.cjs`（唯一 dsh 入口）。

| 门禁 / 实验 | 是否启动 harness（用 dsh） | 处置 / 结果 |
|---|---|---|
| `npm run test:d4-02b`（harness-acp-* 5 文件） | **是**（真实 dsh） | **重跑** → 16/16 exit 0 |
| `npm run test:d4-02c`（task-harness-* 6 文件） | **是**（fixture 构造 HarnessAdapter，PIN 校验仍执行） | **重跑** → 22/22 exit 0 |
| `npm run test:d4-03b`（11 文件，含 tool-dsh-*） | **是** | **重跑** → 59/59 exit 0 |
| `npm run test:d4-03d`（9 文件，含 c4-dsh-write） | **是** | **重跑** → 52/52 exit 0 |
| `npm run test:d4-03d-closure`（10 文件） | **是** | **重跑** → 62/62 exit 0 |
| 全部 Electron UI 门禁（`test:*-ui`、`test:desktop`、`test:native`、`showcase`） | **否** —— `tests/*-ui.mjs` / `desktop.mjs` / `native-view.mjs` / `showcase.mjs` 无一 require harness-adapter | **未重跑**（复用既有证据；本轮无相关改动） |
| `experiments/d5-02/agent-canvas-probe.mjs` | 引用 harness-adapter，但**不是 npm 门禁**（package.json 无 `test:d5-02`） | 未重跑（非门禁） |

**因此不存在受影响的 Electron 门禁**，无需串行 Electron 运行、`acquirePort`、runId 目录或 `run-artifacts.cjs` 布局；本批未产生新的 Electron runId。

### 3.2 受影响门禁重跑（`19-affected-gates-summary.txt` `703a91a5`）

    test:d4-02b          16 tests / 16 pass / 0 fail   exit=0
    test:d4-02c          22 tests / 22 pass / 0 fail   exit=0
    test:d4-03b          59 tests / 59 pass / 0 fail   exit=0
    test:d4-03d          52 tests / 52 pass / 0 fail   exit=0
    test:d4-03d-closure  62 tests / 62 pass / 0 fail   exit=0
    合计 211 / 211 / 0

### 3.3 `npm test` 全量（`17-npm-test-full.txt` `f47491af`）

    npm test        # = node --test tests/*.test.mjs
    1..1377
    # tests 1383 / # pass 1380 / # fail 3 / # cancelled 0 / # skipped 0 / # todo 0
    # duration_ms 144273
    NPM_TEST_EXIT=1

**失败清单（3 条，逐条原因）**

| # | 用例 | 文件:行 | 原因 | 归类 |
|---|---|---|---|---|
| 1 | `P2 · 当前会话 = A（owner）：推送投递，载荷 = 白名单投影且与 getApprovalRequest 一致` | `tests/d4-03-approval-push-isolation.test.mjs:94` | `推送不得新增/泄露字段`：白名单投影多出 `targetRef`、`url`。确定性断言失败 | **预存 #1**（与 dsh PIN 无关） |
| 2 | `No Direct Domain Bypass：resource.trash 的唯一 Domain 调用点在 allowlisted adapter + controlled execution 内` | `tests/side-effect-c4-gates.test.mjs:444` | `主进程绝不 in-process 执行 write` expected true actual false。确定性断言失败 | **预存 #2**（与 dsh PIN 无关） |
| 3 | `Cancel 后不存在 Provider retry：abort 只发生一次` | `tests/task-harness-cancel.test.mjs:84` | `0 !== 1`，duration 51723ms。该用例先等 `fp.state.requests >= 1`（20s deadline），并行高负载下慢 Provider 请求未在窗口内到达 → 断言 0。**负载型 flake** | **非预存 / 非回归** |

**预存 2 条单列说明**：#1、#2 与交接说明一致，且均为确定性业务断言失败，与 dsh 版本无关（不涉及 harness/adapter）。

**4 条版本漂移失败确已消失**：修前清单为
`D4-02B-I5`、`D4-02B-P1`、`D4-02B-P2`、`official dsh 0.1.5-rc.2 … exactly 2 个 READ_ONLY tool`。
全量 1383 条中**无一命中**上述 4 个名字（失败仅 3 条，见上表）。✔

**第 3 条的独立性证明**（`18-task-harness-cancel-probe.txt` `31bfe261`）：

    node --test --test-concurrency=1 tests/task-harness-cancel.test.mjs
    probe 1: exit=0  3 tests / 3 pass / 0 fail
    probe 2: exit=0  3 tests / 3 pass / 0 fail
    probe 3: exit=0  3 tests / 3 pass / 0 fail

单独串行跑 3 次全过 → 失败由 `npm test` 默认并发（`tests/*.test.mjs` 全量并行 + 本机宿主高负载）触发，非代码回归。

### 3.4 跑完残留核对（`20-postrun-state.txt` / `21-final-integrity.txt` `19d55601`）

- `/var/folders/*/*/T/oa-d503*`：本批两个探针临时目录（`oa-d503-b8-probe-K0OpU0`、`oa-d503-b8-bin-kH62vB`，birth 12:57:49 / 12:59:06 = 本批所有）**已删除** → 复查 `(none — CLEAN)`（含 `/private/var/…` 等价路径）。`/tmp/oa-d503-b8*` 亦已清理。
- 其余 22 个 `/tmp/oa-d503*`（batch4/5/6/7/g/h…）属**更早批次**，非本批产物，未触碰。
- 残留进程：**0 个** OpenArc dsh 子进程（owner 判定见 §2）。未杀任何进程。
- 唯一在跑的 `OpenArc OS-integration` 相关进程是 2 个外部轮询 bash（`bash -c sleep 290; … ls -1t experiments/d5-03/batch8/`，ppid 22841，非本会话所发），与本任务无关。

---

## 四、密钥与不变性

### 4.1 密钥扫描（`16-secret-scan.txt` `99b2271a`）

对象：`experiments/d5-03/`（全目录）、`tests/d5-03-dsh-runtime-pin.test.mjs`、`package.json`、`package-lock.json` —— **63 个文件**。
模式：`sk-`、`Bearer `、`api[_-]?key` 赋值、`ANTHROPIC_API_KEY=`、`OPENAI_API_KEY=`、`DEEPSEEK_API_KEY=`、`x-api-key`、`-----BEGIN … PRIVATE KEY-----`、`aws_secret_access_key`、`["'](sk|pk)-…`。

    TOTAL raw secret-pattern hits: 0
    VERDICT: CLEAN

> 说明：首次运行报 3 条命中，全部是扫描器**自身的正则字面量**自匹配（`scan-secrets.cjs:12–14`）。已将扫描器源码与其输出加入排除集后复跑，得 0。此过程如实保留。
>
> 另：`harness-acp-protocol.test.mjs` P3 独立通过 —— Harness 侧 env / argv / stdout / stderr / DSH_HOME / workspace **0 Provider Secret**。

### 4.2 `~/.dsh` 未变（跑前 04:57:34Z / 跑后 05:12:36Z）

| 项 | 跑前 | 跑后 | 结论 |
|---|---|---|---|
| `stat -f "%m %N" ~/.dsh` | `1790647563` | `1790647563` | **未变** |
| 顶层条目（`ls -la`，未读内容） | 11 项：`.anonymous-user-id`、`.credentials.yaml`、`AGENTS.md→`、`attachments/`、`llm-deepseek/`、`profiles/`、`sessions/`、`settings.yaml.imported`、`storages/` | 逐条目同名、同 size、同 mtime | **逐条一致** |
| `~/.dsh/.credentials.yaml`（**仅元数据，未读内容**） | `mode=-rw------- mtime=1789091651 atime=1789091652 size=223` | 完全相同 | **未被读取**（atime 仍停在 9/11，早于本会话）；**未被复制** |

归属说明：本批所有 harness 运行都使用隔离 `DSH_HOME`（临时目录），未写入真实 `~/.dsh`。宿主 DSH 桌面端进程（PID 22841 及 `sessions/` 等）由会话自身维护，与本批无关；实测其 mtime 与顶层清单在本批前后**没有任何变化**，故本次连宿主写入都未观察到。

### 4.3 共享运行时未变

| 项 | 跑前 | 跑后 |
|---|---|---|
| `stat -f "%m %N"` 共享 runtime | `1789097644` | `1789097644`（**未变**） |
| 共享 runtime `@deepseek-ai/dsh` version | `0.2.0-rc.1` | `0.2.0-rc.1`（**未被改动 / 未被替换**） |

### 4.4 仓库完整性

- 被测仓 HEAD 仍 `3bbb34741f17039982f1390f9913f7a5ac64a38b`，分支仍 `integration/ui-core`。
- `git status --porcelain`：仅 `?? experiments/d5-03/batch8/`（本批证据目录，未提交）。产品代码 / 测试 / 断言零改动。
- 主工作树 `/Users/wepingli/Desktop/OpenArc OS`：`git status --porcelain` 仍 **17** 条（与任务下达时一致），HEAD `9119f85`，**未触碰**。

---

## 五、与"已完成"结论不符之处（如实报告）

**结论：PIN 相关的"已完成"结论逐条成立，无一处不符。** 仅在三处补充/修正事实：

1. **`tool-dsh-lifecycle.test.mjs` 首次运行失败（交接说明未提及）**
   - 现象：`not ok 2 - 5-run lifecycle：…0 orphan / 0 listener 累积`，run 0 → `HARNESS_TURN_TIMEOUT`，`duration_ms 59964`。
   - 根因：`DEFAULT_START_TIMEOUT_MS = 30000`（`electron/task-harness-orchestrator.cjs:32`），而 `task-harness-orchestrator.cjs:101` 把 `HARNESS_START_TIMEOUT` **映射为** `HARNESS_TURN_TIMEOUT`；dsh start 未在 30s 内完成 → 该错误码。**不是**版本 / 解析问题（见 §八 A/B 实测）。
   - 证据：复跑 `2/2 pass`（5-run 仅 3668ms，对比 W48 记录的 133648ms），再连跑 3 次探针 `2/2 pass`（`15-flake-probe…`）。合计 **4 通过 / 5 次**。
   - 判定：**环境（宿主）型 flake，与本批 PIN 无关** —— 补做 A/B 实测两版本启动同量级（§八）：失败那次的 >30s 约为正常 ACP boot 的 40–65 倍，而版本间差异仅约 ±7%，量级上无法解释。不阻塞本批结论。
   - 30s start 预算的处置见 §七 遗留 1 —— **留给单独批次的产品/测试裁决项，本批不实施**（不改超时、不改断言）。

2. **`npm test` 失败数是 3 而非 2**
   - 第 3 条 `task-harness-cancel` 同属负载型 flake（单跑 3/3 ×3）。交接说明只列了 2 条预存，未列这一条；本报告如实计入并给出独立性证明。

3. **W48 的 `tests-regression-sweep.txt` 是 29 条定向 sweep，不是全量 `npm test`**（`# tests 29 / pass 29 / fail 0`）。故"全量 1383 条"在本批之前**没有可比基线**；本批 `17-npm-test-full.txt` 是首个全量记录，可作为后续对照。

## 六、notVerified（未验证项）

| 项 | 原因 |
|---|---|
| Electron UI 门禁（`test:*-ui`、`test:desktop`、`test:native`、`showcase`）实机重跑 | 静态扫描证明其不 require `harness-adapter.cjs`，**不受本批影响**，按"只重跑受影响"要求未重跑；沿用既有证据 |
| `experiments/d5-02/agent-canvas-probe.mjs` | 引用 harness-adapter 但非 npm 门禁，且不在本批范围 |
| 视觉 / 动效验收 | 本批为运行时 PIN + 后端链路，无 UI 改动 |
| `~/.dsh` 各子目录（`sessions/`、`storages/` 等）内部内容 | 按要求**只记录顶层条目与 stat，不读文件内容** |
| `~/.dsh/.credentials.yaml` 内容 | 明确禁止读取（仅取元数据） |
| W48 其余 `npm run test:d4-*` 门禁（非 harness 相关） | 与 dsh PIN 无关，未重跑 |

## 七、遗留

1. **`tool-dsh-lifecycle.test.mjs` 的 30s start 预算 —— 留给单独批次的产品/测试裁决项（本批不实施、不改任何超时或断言）**
   - 现状：`DEFAULT_START_TIMEOUT_MS = 30000`（`electron/task-harness-orchestrator.cjs:32`）；`:101` 把 `HARNESS_START_TIMEOUT` 映射为 `HARNESS_TURN_TIMEOUT`，两者在错误码上不可区分。
   - 本批已判定：该次失败与本批 PIN **无关**（§八 A/B：两版本启动同量级；失败需 40–65× 于正常启动）。
   - **本批不实施的理由**：超时预算属于"会掩盖行为的阈值"，与断言同属"不为凑全绿而改动"的范围；用户已明令不为凑全绿改断言，本批一并沿用该口径，只上报不改动。
   - 若后续裁决，三个选项的利弊：
     - **调宽 start 预算** —— 利：消除宿主争用导致的假失败，降低本机/CI 噪声。弊：真实"启动卡死"会更晚暴露，且**掩盖了更值得修的"错误码被误映射"问题**。
     - **保留原始错误码（`HARNESS_START_TIMEOUT` 不再映射为 `HARNESS_TURN_TIMEOUT`）** —— 利：失败可被正确归因（本次正是靠人工读代码才发现是 start 而非 turn），诊断价值高、运行行为不变。弊：可能影响既有依赖 `HARNESS_TURN_TIMEOUT` 的调用方/断言，需先评估兼容面。
     - **维持现状** —— 利：零改动、零回归面。弊：本机高负载下仍会偶发假失败（实测 5 次中 1 次）。
2. `task-harness-cancel.test.mjs:84` 的 20s 等待窗口属**同类**问题（§八：同样与本批 PIN 无关），一并**留给单独批次裁决，本批不实施**。
3. `d4-03-approval-push-isolation` P2（投影多出 `targetRef` / `url`）与 `side-effect-c4-gates` "No Direct Domain Bypass" 两条预存失败仍在，**与本批 dsh PIN 无关**，需另案处理。
4. `/tmp/oa-d503*` 仍有 22 个更早批次的临时残留（batch4–h），非本批产物，未清理。

---

## 八、补做：启动延迟 A/B（flake 归因判定）

**目的**：判定 §五 偏差①（`tool-dsh-lifecycle` 30s start 超时）是否与"固定到 0.1.5-rc.2"有关。

**方法**：直接 exec 两个 bin（**不走产品解析器路径，纯测量**），N=10、严格 A/B 交替以抵消时间漂移；隔离 `DSH_HOME` / `HOME` 到临时目录，共享运行时安装目录**只执行、不写入**。测两个动作：

- Phase 1：`<bin> --version` —— 纯可执行冷启动成本
- Phase 2：`<bin> --profile acp` + ACP `initialize` stdio 握手 —— 真实 ACP boot 成本（侦察确认 `--version` **不 boot profile**，故不足以代表 ACP 启动，据此加测 Phase 2）

原始输出：`22-startup-latency-ab.txt`（sha256 `546cce1a…`）· 脚本 `probe-startup-latency-ab.cjs`（`78be962d…`）

| 相位 | project bin（0.1.5-rc.2） | shared bin（0.2.0-rc.1） |
|---|---|---|
| Phase 1 `--version` | n=10 · min 39.7 · **p50 40.9** · p90 46.1 · max 46.1 · mean 41.2 · sd 1.8 | n=10 · min 45.8 · **p50 46.4** · p90 47.6 · max 47.6 · mean 46.6 · sd 0.5 |
| Phase 2 ACP initialize | n=10 · min 454.6 · **p50 474.4** · p90 525.7 · max 525.7 · mean 478.3 · sd 17.2 | n=10 · min 431.2 · **p50 445.2** · p90 576.5 · max 576.5 · mean 458.0 · sd 40.2 |
| 失败 / 异常 | **0** | **0**（两侧均 `protocolVersion=1`，ACP 握手成功） |

**结论：0.1.5-rc.2 的可执行启动并不显著慢于 0.2.0-rc.1，两者同量级。**

- Phase 1：项目 bin 反而**更快**（p50 40.9 vs 46.4 ms，差 −5.5 ms，分布几乎不重叠且方向不利于"0.1.5-rc.2 更慢"）。
- Phase 2：项目 bin p50 慢 +29.2 ms（相对 +6.6%），但两组分布**大幅重叠**（项目 max 525.7 低于共享 max 576.5；项目 min 454.6 高于共享 min 431.2）。相对差异 ~7%，且方差（sd 17.2 / 40.2）与组间差同量级。
- 两相位均为**亚秒级**。产品真实路径（含 `--patch` 与 tool facade bundle）实测 ≈ **0.73 s/run**（3668 ms ÷ 5 run，见 `14-rerun-tool-dsh-lifecycle.txt`）。

**归因**：失败那次需要 **> 30 s**，约为正常 ACP boot（≈0.45–0.73 s）的 **40–65 倍**；而版本间差异仅约 ±7%。量级上，版本差异**无法**解释 40× 以上的偏差。故 **该 flake 与"固定到 0.1.5-rc.2"无关**，剩余解释只能是宿主环境（进程调度 / I/O 停顿 / 瞬时争用）。

**证据强度与保留（如实标注）**：

| 类别 | 内容 |
|---|---|
| 直接支持 | 上表 A/B 等价；4/5 次通过；失败那次**第 1 个子测试正常**（351 ms，与复跑的 353 ms 几乎一致）。 |
| 宿主负载旁证（**失败当刻未采集 loadavg —— 这是本批的证据缺口**） | 运行 08 的那条命令在跑 test **前几秒**打印了 `pgrep -fl "dsh|node"`，当时宿主同时运行 Adobe Illustrator 2026（含多个 CEPHtmlEngine helper）、Chrome、Claude、Cursor、WorkBuddy、Quark、WeChat、Eagle 及多个 MCP server。此为**同时段**观察，非精确负载指标。 |
| A/B 期间的负载参考（**非失败当刻**） | loadavg {5.08, 6.70, 8.65} → {4.82, 6.59, 8.59}，12 CPU，进程数 772 → 777。**即使在 loadavg ≈5–8.6 下，ACP boot 仍稳定在 0.43–0.58 s** —— 说明"中等负载"不足以解释 30 s 超时，需要远超此水平的**瞬时停顿**。 |
| **反向证据（不利于简单"负载"结论，如实列出）** | 复跑 14 的子测试只用 3668 ms，但该次**整轮** `duration_ms` 为 86571 ms —— 约 82 s 花在子测试之外的 fixture 建立/收尾上。即当时宿主**仍然偏慢**，却未触发 start 超时。故本批只能把归因定位到"**环境**"，**未能证明具体停顿机制**（可能是进程派生/调度停摆，也可能是一次性 I/O 停顿）。 |

**范围保留**：Phase 2 用 shipped `--profile acp`，比产品路径**更轻**（产品另加 `--patch` 与 tool facade bundle），故上表是产品启动成本的**下界**；但产品路径实测 0.73 s/run 与之同量级，不影响结论。

### 8.1 失败 vs 复跑：宿主负载差异证据（时间线）

来源：`23-flake-timeline.txt`（sha256 `a54ddd6b…`）+ 各证据文件 mtime。**推断成分已标注。**

| 时刻（本地） | 事件 | 子测试耗时 | 说明 |
|---|---|---|---|
| 12:59:26 | `07` ACP protocol 4/4 完成 | — | 同一命令串行执行下一项 |
| ≈12:59:29 → **13:00:29** | **`08` lifecycle 失败** | **59963.8 ms** | 同轮第 1 个子测试正常（**351.7 ms**）；run 0 start 未在 30 s 内完成 |
| 13:00:36 – 13:00:56 | `09–13` 全部通过 | 各 0.35–1.4 s | 同串行命令内其余文件均正常 |
| ≈13:01:06 → 13:02:33 | **`14` 复跑通过** | **3667.9 ms** | 第 1 个子测试 **353.3 ms**（与失败那次几乎一致） |
| 13:03:02 | `15` 探针 ×3 全通过 | 每次 ~6.3 s（整轮） | 5-run 均正常 |
| 13:05:34 | `17` 全量 `npm test` 结束 | 1383/1380/3 | 期间默认并发 |

**推断与保留**：
- 失败那次**整轮** 62718 ms，与子测试 59964 ms 基本相当 → 停顿发生在子测试内、即 start 阶段。
- 复跑那次**整轮** 86571 ms 却只有 3668 ms 在子测试内 → 宿主在复跑时**仍然偏慢**（收尾 82 s），但 start 未超时。这说明：**宿主慢 ≠ 必然触发该 flake**，触发需要 start 阶段的瞬时停顿，本批未采集到能定位该停顿的直接指标（未捕获失败当刻的 loadavg / vm_stat / spindump）。
- 同一命令内 `09–13` 五个文件均在 0.35–1.4 s 内通过 → 不是全局性持续劣化，更像**瞬态**。
- 我自己的运行在该时刻是**严格串行**的（`--test-concurrency=1`、单条命令顺序执行），故争用来自宿主其他进程，而非本批并行自扰。

---

### 证据清单

全部原始输出位于 `experiments/d5-03/batch8/`，逐文件 sha256 见 `sha256-manifest.txt`（由 `shasum -a 256` 生成）。

探针 / 扫描脚本：`probe-resolvers-b8.cjs` `b1cd619f`、`probe-dshbin-b8.cjs` `472d604d`、`scan-dsh-desktop-literal.cjs` `82577a2d`、`scan-secrets.cjs` `95ed3482`、`probe-startup-latency-ab.cjs` `78be962d`（§八 补做）。

补做证据：`22-startup-latency-ab.txt` `546cce1a`（A/B 原始输出与统计）、`23-flake-timeline.txt` `a54ddd6b`（失败 vs 复跑时间线）。
