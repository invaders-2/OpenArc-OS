# D5-03 第八批 · DSH 运行时 PIN（项目专用可复现运行时 + 解析器只认项目安装）

状态：**已实现并完成独立验收（node-only 链路；本批无界面改动）** —— 2026-09-29 独立验收（报告 `experiments/d5-03/batch8/D5-03-BATCH8-VERIFICATION-REPORT.md`，证据目录 `experiments/d5-03/batch8/` 附 `sha256-manifest.txt`）：修前 3 个测试文件 **tests 12 / pass 8 / fail 4（exit 1）** → 修后同 3 文件 **12 / 12 exit 0**；新增解析器契约测试 **7/7 exit 0**；六类真实链路全绿；5 个受影响门禁 **211/211 exit 0**；全量 `npm test` **1383 tests / 1380 pass / 3 fail / exit 1**（2 条预存失败 + 1 条已证负载 flake，逐条列名）；**改动面不含任何 `.tsx` / `.css`**（视觉 / 动效 = 通过，本批无界面改动）。

* **判定：D5-03 第八批（DSH 运行时 PIN）= PASS（限定范围：PIN 成立、4 条版本漂移失败已闭环；1 条负载 flake 与 2 条预存失败如实单列）；D5-03 整体仍 = PARTIAL**（剩余缺口见 §9 / §10 / §12）。
* 被测内容 = 提交 `3bbb34741f17039982f1390f9913f7a5ac64a38b`（`3bbb347`，父提交 `186e2e0f00eb2375ccda85350b2681094608c28e`）：产品 / 依赖 / 解析器 + 契约测试 + 安装与基线证据。
* **当前有效证据 = 第八批证据清单**：`experiments/d5-03/EVIDENCE.md`（交接方证据索引，**随被测提交 `3bbb347` 跟踪**）+ `experiments/d5-03/batch8/`（独立验收的 28 个原始输出文件 + `sha256-manifest.txt`，**未跟踪**）。更早批次（第一至第七批）的 runId / sha256 / 计数只作历史对照。
* tracked 证据：`docs/D5-03-GATE-EVIDENCE.json` 的 `batch8` 段（**纯插入**：旧段逐字节 / 逐键未改）；本批决策 = 本文件；独立验收报告见上；结果正文 = `docs/D5-03-RESULT.md` 第八批节；进度 = `PROGRESS.md` 第八批节。
* 被测工作区：`/Users/wepingli/Desktop/OpenArc OS-integration`（分支 `integration/ui-core`）。未 push、未合并 main、未切分支；被测提交后工作树干净，唯一未跟踪 = `experiments/d5-03/batch8/`。

## 1. 被测内容、提交链与证据口径披露（必读）

| 项 | 值 |
| --- | --- |
| 分支 / HEAD | `integration/ui-core`，HEAD = `3bbb34741f17039982f1390f9913f7a5ac64a38b`（`3bbb347`） |
| 提交链 | `186e2e0`（起点）→ **`3bbb347`（被测提交，单个提交）**；`git log --oneline 186e2e0..3bbb347` = **1 行**；未 merge main |
| 被测提交的文件面（17 个） | 3 个产品 / 依赖文件：`electron/harness-adapter.cjs`（`+43 / −14`，解析器收紧）、`package.json`（`+1`，第 91 行精确版本）、`package-lock.json`（`+9915 / −1069`，口径见下）；1 个新增契约测试 `tests/d5-03-dsh-runtime-pin.test.mjs`（198 行）；13 个证据文件全部在 `experiments/d5-03/`（`EVIDENCE.md`、`install-evidence.txt`、`npm-install-log.txt`、`env-before-install.txt`、`baseline-before-pin.txt`、`resolvers-before.txt` / `resolvers-after.txt`、`tests-after-pin.txt`、`tests-d5-03-pin-contract.txt`、`tests-extra-after-pin.txt`、`tests-regression-sweep.txt`、`immutability-proof.txt`、`probe-resolvers.cjs`）；合计 `+11279 / −1083` |
| **锁文件口径（两层，如实分列）** | **依赖条目层**（交接方口径）：HEAD 177 条 → 现 737 条，**added 560 / removed 0 / modified 0**；项目直接依赖版本逐条未变。**文本行层**（本岗复核）：`git diff --stat` 显示 `+9915 / −1069` —— 这 1069 条「删除」是 npm 重排（把既有条目移到新位置）造成的；逐行**多重集比对**：旧锁文件 2697 行中 **0 行**在新锁文件里找不到（新锁文件 11543 行，新增 8846 行）→ **没有任何旧行被真正丢弃**。**不得把 `git diff --stat` 读成「只增不改」，也不得把条目层的「0 删除」写成文本层无删除。** |
| package.json 精确版本 | 第 91 行 `"@deepseek-ai/dsh": "0.1.5-rc.2"` —— **精确版本，无 `^` / `~` 前缀**；第 90 行 `"@agentclientprotocol/sdk": "1.4.0"`（未变） |
| ACP SDK | **仍 1.4.0**：`npm ls` 显示 `dsh → dsh-acp-app → dsh-acp → @agentclientprotocol/sdk@1.4.0 deduped`；`node_modules/@agentclientprotocol/sdk/package.json` = `1.4.0`，锁文件条目与 resolved / integrity 与安装前逐字相同（未被挪走 / 降级 / 升级） |
| 证据口径 | **本批没有 runId、没有机器可读汇总 JSON**：独立验收以直接命令取证，原始输出集中在 `experiments/d5-03/batch8/`（**37 个文件** = 36 个收录进 `sha256-manifest.txt` 的原始输出 / 报告 / 探针脚本（含 §7 的 A/B 补做 `22-startup-latency-ab.txt` / `23-flake-timeline.txt` / `24-post-ab-final-integrity.txt` 与 `probe-startup-latency-ab.cjs`）+ 清单本身），**逐文件 sha256 可复核**；计数一律取真实 TAP 输出与 exit code，未实测的进 §9 notVerified |
| 跑前 / 跑后边界 | 跑前 `04:57:34Z` / 跑后 `05:12:36Z` 两次状态快照（`00-prerun-state.txt` / `20-postrun-state.txt`）逐项一致，见 §8 |

## 2. 决策一：项目专用、可复现的运行时（依赖 PIN + 锁文件）

安装命令：`npm install --save-dev --save-exact @deepseek-ai/dsh@0.1.5-rc.2` → `added 498 packages, and audited 604 packages in 34m`，exit 0（`install-evidence.txt` / `npm-install-log.txt`）。

| 项 | 实测值 |
| --- | --- |
| registry | `https://registry.npmjs.org/` |
| 锁文件 resolved | `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.2.tgz` |
| 锁文件 integrity | `sha512-8Xc8hCQHcIWRmTCVU/xZdp6/qMsWMeAd2ObChKDEsfhUPJFXx6H0lgeb1DxUMD86HZrrVN+1bCvn1ppjZ/fOxw==` |
| `node_modules/@deepseek-ai/dsh/package.json` version | `0.1.5-rc.2`（bin `{"dsh":"lib/bin.js"}`） |
| 启动路径 | `node_modules/.bin/dsh` → 相对软链 `../@deepseek-ai/dsh/lib/bin.js` → realpath `/Users/wepingli/Desktop/OpenArc OS-integration/node_modules/@deepseek-ai/dsh/lib/bin.js`（**落在项目内**） |
| 锁文件版本 | `lockfileVersion: 3`；root `devDependencies` 为同一 pinned 值 |

**为什么这么做**：此前运行时来自 DSH Desktop 共享安装，而该共享安装在本批**跑前跑后都是 `0.2.0-rc.1`**（本批未改动它），与写死 `0.1.5-rc.2` 的断言不符 → 4 条断言全红。项目自持精确版本 + 完整 integrity 后，**同一代码在任意机器上解析到同一个 tarball**，不再随宿主桌面端的版本漂移。

**可复现安装的口径**：锁文件带 `resolved` + 完整 `integrity`（sha512），具备 `npm ci` 可复现安装的依据；**本批未实跑 `npm ci`**（不写成已实测）。

## 3. 决策二：ACP SDK 保持 1.4.0，`resolveAcpSdk()` 删除「回退运行时副本」的分支

* SDK 版本与来源未被本批搅动：`@agentclientprotocol/sdk@1.4.0` 仍由项目自己的 `node_modules` 提供（`npm ls` 去重链见 §1），`init` 返回 `protocolVersion: 1`。
* `resolveAcpSdk()` **删掉了「回退到运行时副本」的分支**：只认项目那一份（`node_modules/@agentclientprotocol/sdk/dist/acp.js`），实测 sdkVersion `1.4.0` 与锁文件一致。
* 理由：SDK 是 ACP 契约的**唯一实现来源**；允许它从解析出的 dsh 安装里回退，会让「项目锁了 1.4.0、实际跑别的副本」成为可能 —— 与版本 PIN 的目的相反。

## 4. 决策三：解析器只认项目安装；缺失 / 不符显式失败；绝不回退

默认解析（无任何环境变量覆盖，`02-resolvers-quadruple-and-rejections.txt`）：

```
runtime    = /Users/wepingli/Desktop/OpenArc OS-integration                        (=== 仓库根: true)
bin        = /Users/wepingli/Desktop/OpenArc OS-integration/node_modules/.bin/dsh  (exists: true)
dshVersion = 0.1.5-rc.2                                                            (=== PINNED_DSH_VERSION: MATCH)
sdkPath    = .../node_modules/@agentclientprotocol/sdk/dist/acp.js                  (sdkVersion 1.4.0)
```

拒绝路径（对抗性，逐条实测）：

| # | 用例 | 期望 | 实测 |
| --- | --- | --- | --- |
| a | `OPENARC_DSH_RUNTIME` = 空临时目录 | `DSH_RUNTIME_MISSING` | `DSH_RUNTIME_MISSING: OPENARC_DSH_RUNTIME …/empty-runtime 内没有 @deepseek-ai/dsh` |
| b | `OPENARC_DSH_RUNTIME` = 假 package.json `0.2.0-rc.1` | `DSH_VERSION_MISMATCH` | `DSH_VERSION_MISMATCH: … 需要 0.1.5-rc.2，实际 0.2.0-rc.1` |
| c | `OPENARC_DSH_RUNTIME` = **真实存在的** DSH Desktop 共享运行时 | `DSH_VERSION_MISMATCH` | 同码；**未采用**。非空证明：共享运行时真实存在、`dsh 0.2.0-rc.1`、`node_modules/.bin/dsh` 存在，仍被拒 |
| c' | 同 c，另走 `resolveDshBin()` 与 `OPENARC_DSH_BIN` = 共享 bin | 也拒绝 | 两者均 `DSH_VERSION_MISMATCH` |
| d | 默认分支源码无 DSH Desktop 字面量（注释不算） | 0 条代码行 | **BARE-CODE 0**；产品代码（`electron/`、`src/`）非注释命中 **0**（见 §5） |
| e1 | `OPENARC_DSH_BIN` = 不属于任何 dsh 安装的孤儿假可执行文件 | 拒绝 | `DSH_RUNTIME_MISSING: … 不属于任何 @deepseek-ai/dsh 安装` |
| e2 | 假 bin 自称归属一个 planted `9.9.9-fake` 安装 | 拒绝 | `DSH_VERSION_MISMATCH … 实际 9.9.9-fake` |
| e3 | PATH 前置假 `dsh` | 不取 PATH 影子 | `resolveDshBin()` 仍返回项目内 bin（**未取 PATH 影子**） |
| e4 | **阳性对照**：真实项目内 bin | 正常接受 | `OK → .../node_modules/@deepseek-ai/dsh/lib/bin.js`（证明不是「一律拒绝」） |
| e5 | 版本正确但无 `.bin/dsh` 的运行时 | 返回 `null` | `null`（由既有调用方语义以 `HARNESS_NOT_STARTED` 区分，**不静默采用外部 bin**） |

语义要点：

* 默认运行时 = **仓库根**；`OPENARC_DSH_RUNTIME` / `OPENARC_DSH_BIN` 覆盖**同样校验**（缺失 → `DSH_RUNTIME_MISSING`；版本不符 → `DSH_VERSION_MISMATCH`）；**绝不回退**到 DSH Desktop 共享运行时、用户 PATH 或任何未知版本。
* `resolveDshBin()` 只在解析出的运行时内找 bin，并做 **realpath 归属校验**（反查所属 `@deepseek-ai/dsh` 安装根）→ 孤儿 / planted 假 bin 一律拒绝。
* 错误码**可区分**「缺失」与「不符」（契约测试 D5-03-C 专测二者可区分）。

## 5. 决策四：保留精确版本断言，不改成「读自报版本与自身比较」

* 既有 3 个测试文件里的 `0.1.5-rc.2` / `1.4.0` **字面量断言一行未改**（`git diff` 未见改动；契约测试也断言源码里仍有这些字面量）；**没有**把断言改成「读运行时自报版本再与它自己比较」这种恒真写法。
* 契约测试 `tests/d5-03-dsh-runtime-pin.test.mjs` **7/7**（`06-contract-pin.txt`）：A 默认解析 = 项目本地根 + PIN；B 无 dsh → `MISSING`；C 版本不符 → `MISMATCH` 且与「缺失」可区分；D 不回退证明（共享运行时真实存在也不采用，TAP 里独立打印非空证明）；E ACP SDK 只认项目那份 1.4.0；F 源码级锁；G `OPENARC_DSH_BIN` 覆盖同样校验、合法覆盖仍可用。
* **源码级锁**（`03-dsh-desktop-literal-scan.txt`）：逐字符把 **709 个源文件**（排除 `node_modules` / `.git` / `dist` / `artifacts` / `build`）分层标注为 `comment | string-literal | BARE-CODE` 后按行定位「DSH Desktop」字面量 —— comment 3 条、string-literal 6 条、**BARE-CODE 0 条**；**产品代码内唯一命中在注释**（`electron/harness-adapter.cjs:37`「绝不借用 DSH Desktop 共享运行时」）。契约测试自身必须在字符串里写共享运行时路径，才能断言「绝不返回它」—— 属正当引用。

## 6. 决策五：总经理裁定（本批，写进本决策文档即生效）

1. **不调宽任何超时 / 等待窗口**（`DEFAULT_START_TIMEOUT_MS`、`HARNESS_START_TIMEOUT`、20s 等待窗口等一律不动）。【第九批已更新：本条约束在第九批继续成立 —— 超时预算与等待窗口一律未调宽（`DEFAULT_START_TIMEOUT_MS = 30000` / `DEFAULT_TURN_TIMEOUT_MS = 180000` 未改，`SCHEMA_VERSION` 仍 21）；「保留原始错误码」按 §6 裁定 3 的加注已于第九批实施，见本文件 §6 裁定 3 / §10 遗留 1 加注与 `docs/decisions/D5-03I-harness-timeout-attribution.md`】
2. **不改任何断言去凑绿**：全量 `npm test` 的 `exit 1` 如实呈现为「**2 条预存失败 + 1 条已证负载 flake**」，不隐藏、不重跑刷绿。
3. **超时预算与错误码映射登记为单独批次的产品 / 测试裁决项，本批不实施**：`DEFAULT_START_TIMEOUT_MS = 30000`（`electron/task-harness-orchestrator.cjs:32`）在高负载下偏紧，且 orchestrator（`:101`）把 `HARNESS_START_TIMEOUT` **映射成** `HARNESS_TURN_TIMEOUT` 导致错误码不精确 —— 两项都需要改产品 / 测试代码，超出本批「只改文档 / 只做 PIN」的范围。【第九批已实施：分类器（`electron/task-harness-orchestrator.cjs:101`）不再把 `HARNESS_START_TIMEOUT` 改写成 `HARNESS_TURN_TIMEOUT`，而是**原样保留**该码，并新增领域枚举 `ERROR.HARNESS_START_TIMEOUT`（`electron/task-domain.cjs`）；`DEFAULT_START_TIMEOUT_MS` 仍 **30000**（预算未动，§6 裁定 1 的约束同时成立）、`SCHEMA_VERSION` 仍 **21**；界面可见文案由 `· HARNESS_TURN_TIMEOUT` 变为 `· HARNESS_START_TIMEOUT`（`src/desktop/components.tsx:1010` 原样渲染错误码，`src/**` 0 行改动），已通过浅 / 深主题 + 布局 + 对比度实机验收（浅 8.208:1 / 深 16.62:1 ≥ 普通文本门槛 4.5:1）；反向验证（副本改回旧映射 → 启动用例按预期变红）成立；判定与证据见 `docs/decisions/D5-03I-harness-timeout-attribution.md`】
4. 本批**只做**：运行时 PIN、解析器收紧、契约测试、证据记录；**不新增任何功能**，不改工具（`run-artifacts.cjs` 等）、不改既有门禁脚本。
5. 版本一致性口径：全文 `0.1.5-rc.2` / `1.4.0` 一律指**项目内安装**的版本；DSH Desktop 共享运行时的 `0.2.0-rc.1` 只作为「被拒绝的回退目标」出现。

## 7. 数字（分列，全部来自真实 TAP 输出与 exit code）

| 面 | 结果 | 证据 |
| --- | --- | --- |
| **修前基线（必须保留）** | 3 个文件 `tests 12 / pass 8 / fail 4`，exit 1；失败 = `D4-02B-I5`、`D4-02B-P1`、`D4-02B-P2`、`official dsh 0.1.5-rc.2 … exactly 2 个 READ_ONLY tool` | `experiments/d5-03/baseline-before-pin.txt` |
| **修后（同 3 个文件）** | `tests 12 / pass 12 / fail 0`，exit 0 | `batch8/05-fix-confirm-3files.txt` |
| **契约测试** | `tests 7 / pass 7 / fail 0`，exit 0 | `batch8/06-contract-pin.txt` |
| 六类真实链路 ①真实 ACP 启动 | protocol `4/4` exit 0；tool-dsh-lifecycle 首跑 `1/2`（负载 flake）→ 复跑 `2/2` + 探针 `2/2 ×3` | `07` / `08` / `14` / `15` |
| ②模型代理 | protocol P2（Harness→Adapter→Model Proxy→Fake Provider，Provider 收到 key）ok；c4-dsh-write `5/5` exit 0 | `07` / `09` |
| ③只读工具 | tool-dsh-facade `3/3` exit 0（official profile bundle 注册 **exactly 2 个 READ_ONLY tool**） | `13` |
| ④权限拒绝 | permission `1/1` exit 0：**1** 次 permission request / client reject（`cancelled`）/ **0** 执行 / **0** 触达 Provider | `10` |
| ⑤取消 | cancel `3/3` exit 0：C1 **0 retry** + Provider 连接关闭（`closed ≥ 1`）+ `dispose().exited === true`；C2 child crash 无 respawn；C3 turn timeout 有界 | `11` |
| ⑥进程清理 | acp-lifecycle `3/3` exit 0；跑完 `ps` 中 argv 含项目 dsh 路径的进程 **0 个** | `12` / `20-postrun-state.txt` |
| **受影响门禁（5 个，node-only、无 Electron）** | `test:d4-02b` 16/16、`test:d4-02c` 22/22、`test:d4-03b` 59/59、`test:d4-03d` 52/52、`test:d4-03d-closure` 62/62 → **211/211，全部 exit 0** | `19-affected-gates-summary.txt` + 5 个 `19-gate-*.txt` |
| Electron UI 门禁 | **未重跑**：静态扫描证明 `tests/*-ui.mjs` / `desktop.mjs` / `native-view.mjs` / `showcase.mjs` **无一 require `electron/harness-adapter.cjs`** → 不受本批影响（理由写清，不宣称跑过） | 报告 §3.1 |
| **全量 `npm test`** | `1..1377`；**tests 1383 / pass 1380 / fail 3 / cancelled 0 / skipped 0 / todo 0**，duration `144273ms`，**exit 1** | `17-npm-test-full.txt` |
| ↳ 失败 1（预存） | `P2 · 当前会话 = A（owner）：推送投递，载荷 = 白名单投影且与 getApprovalRequest 一致`（`tests/d4-03-approval-push-isolation.test.mjs:94`）：白名单投影多出 `targetRef` / `url`，确定性断言失败 | 同上 |
| ↳ 失败 2（预存） | `No Direct Domain Bypass：resource.trash 的唯一 Domain 调用点在 allowlisted adapter + controlled execution 内`（`tests/side-effect-c4-gates.test.mjs:444`）：`主进程绝不 in-process 执行 write` expected true actual false，确定性断言失败 | 同上 |
| ↳ 失败 3（**本批新增观察到的负载 flake**） | `Cancel 后不存在 Provider retry：abort 只发生一次`（`tests/task-harness-cancel.test.mjs:84`，断言在 `:96`）：`0 !== 1`，duration `51723ms`；该用例先等 `fp.state.requests >= 1`（20s deadline），全量并行高负载下请求未在窗口内到达 | 同上；独立性证明 `18-task-harness-cancel-probe.txt`：单跑 `--test-concurrency=1` **3/3 ×3 全过 exit 0** |
| **4 条版本漂移失败全部消失** | 全量 1383 条中 `not ok` **恰好 3 条**（上表三条），**无一**为 `D4-02B-I5` / `D4-02B-P1` / `D4-02B-P2` / `official dsh … exactly 2 个 READ_ONLY tool` | `17-npm-test-full.txt` 逐条核对 |

**另有一处同类 flake（如实计入）**：`tool-dsh-lifecycle` 首跑 `1/2`，失败 run 0 报 `HARNESS_TURN_TIMEOUT`、`duration_ms 59964`；复跑 `2/2`（5-run 本次 3668ms）+ 探针 `2/2 ×3` → 合计 **4 通过 / 5 次**。

**flake 归因（补做 A/B 实测，`22-startup-latency-ab.txt` `546cce1a` / `23-flake-timeline.txt` `a54ddd6b`）**：直接 exec 两个 bin（N=10、严格 A/B 交替、隔离 `DSH_HOME` / `HOME`、共享安装只执行不写入）——Phase 1 `--version`：项目 bin p50 **40.9 ms** vs 共享 bin p50 **46.4 ms**（项目反而更快）；Phase 2 `--profile acp` + ACP `initialize`：项目 p50 **474.4 ms** vs 共享 p50 **445.2 ms**（相对 +6.6%，两组分布大幅重叠，两侧 **0 失败**、均 `protocolVersion=1`）。失败那次需 **> 30 s**（约为产品真实路径实测 **0.73 s/run** 的 **40–65 倍**），而版本间差异仅约 **±7%** → **量级上版本差异无法解释该 flake，判为宿主环境型，与本批 PIN 无关**（具体停顿机制未定位，见 §9）；超时预算处置留给单独批次（§6 裁定 3）。【第九批已更新：预算处置维持「不调宽」（30000 / 180000 未改）；「保留原始错误码」已由第九批实施，见 §6 裁定 3 加注与 `docs/decisions/D5-03I-harness-timeout-attribution.md`】

## 8. 边界与不变性（跑前 04:57:34Z / 跑后 05:12:36Z 两次快照逐项一致）

| 项 | 跑前 | 跑后 | 结论 |
| --- | --- | --- | --- |
| `~/.dsh` 目录 mtime | `1790647563` | `1790647563` | **未变** |
| `~/.dsh` 顶层条目（只记顶层与 stat，**不读子目录内容**） | 11 项（`.anonymous-user-id`、`.credentials.yaml`、`AGENTS.md→`、`attachments/`、`llm-deepseek/`、`profiles/`、`sessions/`、`settings.yaml.imported`、`storages/` …） | 逐条目同名、同 size、同 mtime | **逐条一致** |
| `~/.dsh/.credentials.yaml`（**仅元数据，内容明确禁读**） | `mode=-rw------- mtime=1789091651 atime=1789091652 size=223` | 完全相同 | **未被读取**（atime 仍停在 9/11，早于本会话）、**未被复制** |
| 共享运行时目录 mtime / 版本 | `1789097644` / `0.2.0-rc.1` | `1789097644` / `0.2.0-rc.1` | **未变、未被替换** |
| 主工作树 `/Users/wepingli/Desktop/OpenArc OS` | 未提交 **17** 条、HEAD `9119f85` | 17 条、HEAD `9119f85` | **未触碰** |
| 被测仓状态 | 干净 | `?? experiments/d5-03/batch8/`（仅本批证据目录） | 产品 / 测试 / 断言零改动 |
| 密钥扫描 | — | `experiments/d5-03/`（全目录）+ 契约测试 + `package.json` + `package-lock.json` = **63 个文件**，`TOTAL raw secret-pattern hits: 0`，`VERDICT: CLEAN` | `16-secret-scan.txt`（首次 3 条命中是扫描器自身正则自匹配，加排除集后复跑得 0，过程如实保留） |
| 残留进程 | — | argv 含 `OpenArc OS-integration/node_modules/@deepseek-ai/dsh` 的进程 **0 个**（唯一在跑的 dsh 属会话宿主）；**未杀任何进程** | `20-postrun-state.txt` |
| 临时目录 | — | 本批两个探针临时目录已删除（复查 CLEAN，含 `/private/var/…` 等价路径）；`/tmp/oa-d503*` 仍有 **22 个更早批次**残留（非本批产物，未触碰） | 同上 |

## 9. notVerified（未验证项，以 batch8 报告 §6 为准）

| 项 | 原因 |
| --- | --- |
| Electron UI 门禁（`test:*-ui`、`test:desktop`、`test:native`、`showcase`）实机重跑 | 静态扫描证明其不 require `harness-adapter.cjs`（不受本批影响），按「只重跑受影响」要求未重跑，沿用既有证据 |
| `experiments/d5-02/agent-canvas-probe.mjs` | 引用 harness-adapter 但**不是 npm 门禁**，不在本批范围 |
| 视觉 / 动效验收 | 本批为运行时 PIN + 后端链路，改动面不含界面文件，**无 UI 改动** |
| `~/.dsh` 各子目录（`sessions/`、`storages/` 等）**内部内容** | 按要求**只记录顶层条目与 stat，不读文件内容** |
| `~/.dsh/.credentials.yaml` 内容 | **明确禁止读取**（只取元数据） |
| W48 其余非 harness 门禁 | 与 dsh PIN 无关，未重跑 |
| `npm ci` 实跑 | 锁文件具备可复现依据，但本批**未实跑** `npm ci` |
| 失败当刻的宿主负载指标（loadavg / `vm_stat` / spindump） | **未采集**（本批证据缺口，报告 §八 如实标注）：A/B 期间 loadavg 5.08–8.65 / 12 CPU、进程数 772–777 下 ACP boot 仍稳定在 0.43–0.58 s，**"中等负载"不足以解释 30 s 超时**，但本批未能证明具体停顿机制；另有反向证据：复跑那一轮整轮 86571ms、子测试只占 3668ms（约 82 s 花在子测试之外的 fixture 建立 / 收尾），宿主当时仍偏慢却未触发 start 超时 |

## 10. 遗留与建议

1. **超时预算 / 错误码映射**（`DEFAULT_START_TIMEOUT_MS = 30000` 偏紧；orchestrator（`:101`）把 `HARNESS_START_TIMEOUT` 映射成 `HARNESS_TURN_TIMEOUT`，两者错误码不可区分）→ **单独批次的产品 / 测试裁决项**，本批不实施（见 §6 裁定 3）。A/B 已判定该 flake 与 PIN 无关（§7）；报告 §七 列出三个选项的利弊：**调宽 start 预算**（消除宿主争用导致的假失败，但真实"启动卡死"会更晚暴露，且掩盖更值得修的错误码误映射）/ **保留原始错误码**（失败可正确归因、运行行为不变，需先评估既有依赖 `HARNESS_TURN_TIMEOUT` 的调用方兼容面）/ **维持现状**（零改动零回归面，但本机高负载下仍偶发，实测 5 次中 1 次）。【第九批已实施：三选项中采纳「**保留原始错误码**」—— 分类器原样保留 `HARNESS_START_TIMEOUT`（不再冒充执行超时），`DEFAULT_START_TIMEOUT_MS` 仍 **30000**（预算未动）；界面可见文案由 `· HARNESS_TURN_TIMEOUT` 变为 `· HARNESS_START_TIMEOUT`，已通过浅 / 深主题与对比度验收（浅 8.208:1 / 深 16.62:1 ≥ 4.5:1）；反向验证（副本改回旧映射）启动用例按预期变红（真实链路得到 `HARNESS_TURN_TIMEOUT`）；详见 `docs/decisions/D5-03I-harness-timeout-attribution.md`】
2. `tests/task-harness-cancel.test.mjs:84` 的 **20s 等待窗口**同为环境型 flake（单跑 3/3 ×3 全过），一并留给单独批次裁决，本批不实施。【第九批已更新：**已实施** —— `tests/task-harness-cancel.test.mjs` 不再用固定 20s 魔数窗，改为等待**产品可观察阶段**（provider 请求已发起；期间记录 child-spawned / session-created / harness-running），上界 = 产品启动预算 30000 + 余量 15000 且与产品常量成对；判据一字未放宽（`requests === 1` / `calls === 1` / `CANCELLED` / capability `REVOKED`），未 skip / 未删除；5 次单跑 + 6 路并发 + 3 轮全量均未再出现该 flake，W49 的「0 次请求」未复现；见 `docs/decisions/D5-03I-harness-timeout-attribution.md` §5】
3. 两条**预存失败**仍在（`d4-03-approval-push-isolation` P2、`side-effect-c4-gates` No Direct Domain Bypass），与本批 dsh PIN 无关，**需另案处理**。
4. `/tmp` 下 **22 个更早批次 `oa-d503*` 残留**未清（非本批产物）。
5. 首次 `npm install` 耗时 **34 分钟**（498 个包，含各平台二进制）→ 首次安装 / CI 需预留时间。
6. `npm ls --depth=0` 有 2 个 `extraneous`（`@emnapi/runtime@1.11.3`、`@img/sharp-wasm32@0.35.5`）：二者本就在新锁文件里且标记 `optional: true`（dsh→sharp 的跨平台 WASM 回退包被 npm 标注为 extraneous），**非依赖漂移**。
7. 契约测试 D5-03-D 的非空证明在**本机**成立；换到没有 DSH Desktop 的机器会退化为 diagnostic 提示而非变红 —— 刻意如此，避免「项目本地可复现」反而依赖桌面端共享运行时。

## 11. 相关代码、测试与证据

* `electron/harness-adapter.cjs`：`PinnedDshRuntime`（`resolveDshRuntime()` / `resolveDshBin()` / `dshVersion()`，默认 = 仓库根、覆盖同校验、realpath 归属校验、绝不回退）+ `resolveAcpSdk()`（只认项目那份）；`:37` 注释显式写明「绝不借用 DSH Desktop 共享运行时」。
* `package.json`（第 90 / 91 行精确版本）、`package-lock.json`（resolved + integrity）。
* `tests/d5-03-dsh-runtime-pin.test.mjs`（**新增契约测试，D5-03-A…G，7/7**）。
* 验收证据：`experiments/d5-03/EVIDENCE.md`（交接方索引）+ `experiments/d5-03/batch8/`（36 个原始输出 / 脚本 + `sha256-manifest.txt`）；报告 `experiments/d5-03/batch8/D5-03-BATCH8-VERIFICATION-REPORT.md`（**§八 = 启动延迟 A/B 补做**，含 §8.1 时间线）。
* 被本批订正的旧口径（就地加注、原文保留）：`docs/D4-02B-RESULT.md`（§2 Harness Version 一行）与 `docs/decisions/D4-02B-harness-acp-adapter.md`（§官方来源与版本 PIN 的「启动不依赖全局 PATH」一行）—— 两处仍写「运行时来自冻结的 DSH Desktop managed runtime / 回退链 → 冻结 runtime」，均已就地加【第八批已更新】写明新解析顺序；**原文一字未删**。

## 12. 判定

* **D5-03 第八批（DSH 运行时 PIN）= PASS（限定范围）**：项目专用可复现运行时（`0.1.5-rc.2` 精确版本 + resolved / integrity + 项目内 bin）；ACP SDK **仍 1.4.0** 且不再回退运行时副本；解析器默认 = 仓库根、覆盖同校验、缺失 / 不符显式失败（`DSH_RUNTIME_MISSING` / `DSH_VERSION_MISMATCH`）、绝不回退共享运行时 / PATH / 未知版本、孤儿与 planted 假 bin 一律拒绝（含阳性对照）；修前 4 条版本漂移失败 → 修后 **12/12 exit 0**，新增契约 **7/7**；六类真实链路全绿；5 个受影响门禁 **211/211 exit 0**；**4 条版本漂移失败在全量失败名单里已全部消失**；负载 flake 已用 A/B 实测归因为**宿主环境型**（两版本启动同量级、差异约 ±7%，与失败那次的 40–65× 偏差量级不符），与本批 PIN 无关。
* **全量 `npm test` = exit 1**（1383 / 1380 / 3）：**2 条预存 + 1 条已证负载 flake**，逐条列名给因，**未调宽超时、未改断言**。
* **D5-03 整体仍 = PARTIAL**，剩余缺口 = §9 / §10 逐条（超时 / 错误码映射待单独批次；cancel 20s 窗口；2 条预存失败另案；`/tmp` 22 个更早批次残留；CI 首次安装时间）。【第九批已更新：其中「超时 / 错误码映射」与「cancel 20s 窗口」两项已由第九批实施（保留原始错误码 + 取消测试按可观察阶段等待；预算未调宽、判据未放宽），本批剩余缺口逐条见 `docs/decisions/D5-03I-harness-timeout-attribution.md` §7 / §8 / §11】
* **继续单列（不并入本批）**：跨组织真机 **2 条 notVerified**、**OAuth**、**两条既有探针门禁失败**（`governance-ui` 1/5、`model-keychain-restart` 3/15）、**插件隔离（D5-08）**、**D5-02 重命名受 Electron 不支持 `prompt()` 限制**、**SIGKILL 边界**；**本批未新增「创建组织」入口**。
* tracked 证据：`docs/D5-03-GATE-EVIDENCE.json` 的 `batch8` 段（纯插入）；本批决策 = 本文件；结果正文 = `docs/D5-03-RESULT.md` 第八批节；进度 = `PROGRESS.md` 第八批节。
