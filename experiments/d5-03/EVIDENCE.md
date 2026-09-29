# D5-03 · DSH 运行时版本固定与复现性收口 — 证据索引

分支 `integration/ui-core` · 基线 HEAD `186e2e0` · 全部证据均在 `experiments/d5-03/`。

## 1. 变更面（只动 3 个文件 + 新增 2 个）

| 文件 | 变更 | sha256 |
| --- | --- | --- |
| `electron/harness-adapter.cjs` | 解析器收紧（见 §3） | `9667b527daf44c4d98345a4a8a435655121b681142feade04646cd49a22ff870` |
| `package.json` | devDependency 增加精确版本 `"@deepseek-ai/dsh": "0.1.5-rc.2"`（第 91 行，无 ^/~） | `b0b488cb5489bfb43fbf5278ffd39ba9aabb81f875c35350e1f8d223c03c47dd` |
| `package-lock.json` | 仅**新增** 560 条 dsh 传递依赖；**0 条被删除、0 条被改写** | `884aa856e25ccf7905340901b27e68c5e3a10203bc5ffd634ed6d802fcafcd45` |
| `tests/d5-03-dsh-runtime-pin.test.mjs` | 新增解析器契约测试（D5-03-A…G） | `46e3a3d3b2636ae0331d1e08a090ef26386de8ff28551abba965c0026f535a26` |
| `experiments/d5-03/probe-resolvers.cjs` | 新增四元组探针（前后对比用） | `0174b930342c7d64c5e659d7499ecc09997d31074d7c41bb12c57d001082e9a7` |

锁文件增量核对：`{HEAD 177 条 → 现 737 条, added 560, removed 0, modified 0}`；
项目直接依赖版本全部未变（react 19.3.0 / vite 7.3.6 / typescript 5.9.3 / electron 44.3.0 /
@agentclientprotocol/sdk **1.4.0** 等逐条相同）。既有 3 个测试文件（含其中写死的 `"0.1.5-rc.2"` /
`"1.4.0"` 断言）**一行未改**。

## 2. 安装（项目专用、可复现）

- 命令：`npm install --save-dev --save-exact @deepseek-ai/dsh@0.1.5-rc.2` → `added 498 packages, and audited 604 packages in 34m`，exit 0
- 来源 registry：`https://registry.npmjs.org/`；resolved：`https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.5-rc.2.tgz`
  integrity：`sha512-8Xc8hCQHcIWRmTCVU/xZdp6/qMsWMeAd2ObChKDEsfhUPJFXx6H0lgeb1DxUMD86HZrrVN+1bCvn1ppjZ/fOxw==`
- 实际启动路径：`/Users/wepingli/Desktop/OpenArc OS-integration/node_modules/.bin/dsh`
  → 软链 `../@deepseek-ai/dsh/lib/bin.js` → realpath `.../node_modules/@deepseek-ai/dsh/lib/bin.js`
- `node_modules/@deepseek-ai/dsh/package.json` version = `0.1.5-rc.2`
- ACP SDK **未被挪走/降级/升级**：`node_modules/@agentclientprotocol/sdk/package.json` = `1.4.0`，
  锁文件条目与 resolved/integrity 与安装前逐字相同；`npm ls` 显示
  `dsh → dsh-acp-app@0.1.5-rc.3 → dsh-acp@0.1.5-rc.3 → @agentclientprotocol/sdk@1.4.0 deduped`
- 原始输出：`install-evidence.txt` `60b65a923527b8779108cadd0743cae9792f7689e76c8f8fcc7610f7dfc93f73`、
  `npm-install-log.txt` `366886e6848c5d56129b759911d6c828d4ff1942255c24655d2d69ef10fcf56e`、
  安装前快照 `env-before-install.txt` `5b75c257c140f38191194e5a80b04142f99537e3c3492a61a69d44b32886c7a3`

## 3. 解析器四元组（before → after）

| | before（默认指向共享运行时） | after（默认只认项目） |
| --- | --- | --- |
| `resolveDshRuntime()` | `~/Library/Application Support/DSH Desktop/runtime` | `/Users/wepingli/Desktop/OpenArc OS-integration` |
| `resolveDshBin()` | `.../DSH Desktop/runtime/node_modules/.bin/dsh` | `.../OpenArc OS-integration/node_modules/.bin/dsh` |
| `dshVersion()` | `0.2.0-rc.1` | `0.1.5-rc.2` |
| `resolveAcpSdk()` | 项目内 `@agentclientprotocol/sdk/dist/acp.js` (1.4.0) | 同左（不变，仍只认项目那份） |

原始输出：`resolvers-before.txt` `8b7d598ddd1f328c194d73272704c96508b1210219801f93bdefee600c021449`、
`resolvers-after.txt` `7dbaf79bdc2ca6cc8dbb20547ff5b3b40a354b2156199fb91798deb7ca741c11`

语义变化：默认分支不再出现 DSH Desktop 路径；`OPENARC_DSH_RUNTIME` 覆盖必须校验
（缺 dsh → `DSH_RUNTIME_MISSING`；版本不符 → `DSH_VERSION_MISMATCH`），**绝不回退**；
`resolveDshBin` 删除了"回退到项目其它路径"的分支，只在解析出的运行时内找 bin
（找不到仍返回 `null`，由既有调用方语义抛 `HARNESS_NOT_STARTED`，错误信息带上 runtime 路径以区分"缺失"）；
`OPENARC_DSH_BIN` 覆盖同样校验（走 realpath 反查所属安装根）；
`resolveAcpSdk()` 删除回退到运行时副本的分支，只认项目那份。

## 4. 测试（全部真实输出，含 exit code）

| 套件 | 结果 | exit | 证据 |
| --- | --- | --- | --- |
| 复现基线（修前）：isolation + protocol + facade | **tests 12 / pass 8 / fail 4**（I5、P1、P2、facade-1） | 1 | `baseline-before-pin.txt` `66572aa904c26b33b5f1a336e041f0943b808457614ee10aa29de7c029bf3cba` |
| 同 3 个文件（修后） | **tests 12 / pass 12 / fail 0** | 0 | `tests-after-pin.txt` `5c1f124f9f5b9cd37dbd709843ff3d7d4637903269e13c8ca9fbf7f825ee1130` |
| 新增契约测试 D5-03-A…G | **tests 7 / pass 7 / fail 0** | 0 | `tests-d5-03-pin-contract.txt` `edc7bf2fc6ad9f42b850c8d0cc3821757b3c78a6780dfc4f6a5d3733141b717b` |
| 点名既有：tool-dsh-lifecycle + harness-acp-lifecycle + side-effect-c4-dsh-write + d5-01-browser-control-chain | **tests 15 / pass 15 / fail 0** | 0 | `tests-extra-after-pin.txt` `8a19c2fa680c456b148f4e6f508a749cca083cc605962e7cac8f1794e22f1cfe` |
| 追加回归（harness-acp-cancel/lifecycle/permission + task-harness-* 6 个） | **tests 29 / pass 29 / fail 0** | 0 | `tests-regression-sweep.txt` `0f3a19208e3ecbd61fa419f066e42b21dbc0b4f0a65cb11a8029bc0ae7bdfdde` |

合计：**63 pass / 0 fail**（4 个真实 dsh E2E 链路：ACP protocol、Tool Facade、C4 WRITE side-effect、D5-01 浏览器控制链，
均在 `0.1.5-rc.2` 下全绿 → **无产品兼容问题，无需改任何夹具**）。

## 5. 边界未被触碰

`immutability-proof.txt` `b37f3e7042e089b9aa075f6d2334b81016e29b88e5ad616a44ec034c89b87289`

- `~/.dsh`：目录 mtime 前后同为 `1790647563`，顶层条目 9 个未增减，`.credentials.yaml`(9/11)、
  `settings.yaml.imported`(9/18)、`profiles/`(9/14)、`llm-deepseek/`(9/28) 均未被改动；
  `.credentials.yaml` 内容**从未被读取**。会话期间唯一被写的是 DSH Desktop 宿主为**本会话自己**写的
  `session-e8a7e264-…` / `da05fc94-…` 对话与缓存文件（宿主随对话推进自动落盘，与本轮命令无关）。
- 共享运行时：`0.2.0-rc.1` 前后一致，`find` 显示本次会话**未写入**其中任何文件。
- 主工作树 `/Users/wepingli/Desktop/OpenArc OS`：未提交条目数仍为 **17**（与任务开始时一致），分支/HEAD 未变。
- 未 push、未切分支；三个既有测试文件未改。

## 6. 遗留与不确定项

1. `docs/D4-02B-RESULT.md:9` 与 `docs/decisions/D4-02B-harness-acp-adapter.md:11` 仍描述**旧的**解析顺序
   （"来自冻结的 DSH Desktop managed runtime"、"`OPENARC_DSH_BIN` → repo `node_modules/.bin/dsh` → 冻结 runtime"）。
   本轮未获授权改 `docs/`，故保持原样，需另行派工同步。
2. 契约测试 D5-03-D 在**本机**做非空证明（TAP 输出里可见 `# 回退目标真实存在（非空证明）：…`）；
   换到没有 DSH Desktop 的机器会退化为 diagnostic 提示而非变红——这是刻意的，避免"项目本地可复现"
   反而依赖桌面端共享运行时。
3. `npm ls --depth=0` 有 2 个 `extraneous`（`@emnapi/runtime@1.11.3`、`@img/sharp-wasm32@0.35.5`）：
   二者本就在新锁文件里且标记 `optional: true`，是 dsh→sharp 的跨平台 WASM 回退包被 npm 标注为 extraneous，非漂移。
4. `npm install` 耗时 34 分钟（498 个包，含各平台二进制），首次安装/CI 需预留时间。
