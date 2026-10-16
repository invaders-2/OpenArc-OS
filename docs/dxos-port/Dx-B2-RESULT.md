# Dx-B2-RESULT · B2 遗留收口（模型与协议全域）+ 测试报告

> 依据：本轮任务「B2 遗留的先完成，并给出测试报告」。分支 `dxos-port/r1`，工作区 `/Users/wepingli/.openarc-worktrees/dxos-port-r1`。
> 起点 = 上一轮提交 `2bb2f1f`（P2 已完成的部分不重做）。全部结论带真实命令与真实输出；未验证项显式标注 NOT VERIFIED。

## 1. B2 遗留五项对照

| # | 遗留项（Dx-P2-RESULT §3/§5） | 本轮交付 | 状态 |
|---|---|---|---|
| 1 | v2 模型协议只移植 openai-images，余 17 个 `ported:false` | `builtins-models.cjs`（17 个）+ `builtins-helpers.cjs`；`BUILTIN_MODEL_PROTOCOLS_V2` = 18，metadata **无 ported:false** | ✅ 完成 |
| 2 | legacy `protocols.ts` 29 模型/19 供应商只进协议表，执行器未搬 | `legacy-protocols.cjs`（表 + 纯函数）+ `legacy-executor-{chat,images,media}.cjs` + `legacy-executor.cjs`；源 24 个 export function **24/24 落地** | ✅ 完成 |
| 3 | `protocolInference.ts` 未逐条搬运 | `protocol-inference.cjs`（16 条 if 分支 + 14 元素 PLATFORM_PROTOCOLS + 关键词/后置约束规则逐条） | ✅ 完成 |
| 4 | 真实调用无凭据 NOT VERIFIED | 新增 `experiments/dxos-p2/stub-call.mjs`：本地 stub 上跑**真 HTTP / 真 SSE / 真落盘**端到端（15 项断言）。外部真机调用仍需用户密钥 | ⚠️ 本地端到端完成；外部端点仍 NOT VERIFIED |
| 5 | 流式未接渲染层下行事件 | `model:event` 下发（P1 信封）+ preload `model.onEvent` + `provider/callStream`；真实 Electron 探针实测事件投递 | ✅ 完成 |

## 2. 交付物（新增 9,873 行实现 / 2,726 行测试 / 233 行探针）

| 文件 | 行数 | 说明 |
|---|---|---|
| `electron/protocol-engine/builtins-helpers.cjs` | 447 | v2 共享 helper（源 builtins.ts:4-85 等区间） |
| `electron/protocol-engine/builtins-models.cjs` | 2335 | 17 个 v2 模型协议（源 builtins.ts:300-2714） |
| `electron/protocol-engine/legacy-protocols.cjs` | 3415 | PROTOCOLS 29 + PROVIDER_PROTOCOLS 20 + 全部纯函数 |
| `electron/protocol-engine/legacy-executor-chat.cjs` | 680 | callChat/streamChat/chatWithTools/describeImage/fetchModelCatalog |
| `electron/protocol-engine/legacy-executor-images.cjs` | 935 | 图片族（源 :4244-5371） |
| `electron/protocol-engine/legacy-executor-media.cjs` | 1623 | 视频/音频/图片编辑/Midjourney（源 :5372-6623、:4656-4969） |
| `electron/protocol-engine/legacy-executor.cjs` | 148 | 聚合出口（惰性 require，破环） |
| `electron/protocol-engine/protocol-inference.cjs` | 290 | 源 protocolInference.ts 全量 |

改动：`builtins.cjs`（336→105，helper 外提 + 18 协议聚合 + 顺序按源重排）、`index.cjs`（+8 导出）、`provider-protocol-domain.cjs`（legacy 表由真实表派生 + execution/unavailableReason + shadowedLegacyProtocols）、`provider-protocol-service.cjs`（+347，统一出口 legacyExecute + 二进制参考图解码 + 流式信封）、`model-manifest-service.cjs`（+26，inferred）、`model-bootstrap.cjs`（+70，10 条 legacy 命令 + model:event 接线）、`main.cjs`（+9，`win.webContents.send("model:event")`）、`preload.cjs`（+9，仅 model 键内新增 onEvent）、`src/types/openarc-ipc.d.ts`（+2）。

## 3. 真实命令与真实输出

```
$ npm run build
> tsc --noEmit && vite build
✓ 1638 modules transformed.   ✓ built in 1.65s          BUILD_EXIT=0

$ npm test
1..1549
# tests 1549 / # pass 1548 / # fail 1 / # skipped 0
唯一失败：not ok 337 - D5-03-E · ACP SDK 只认项目内那一份（worktree node_modules 符号链接的既有环境性失败）
基线口径：改动前 1447 / 1446 / 1 → 本轮 1549 / 1548 / 1（新增 102 条用例，失败项同一项，无新增失败）

$ node experiments/dxos-p2/stub-call.mjs
[dxos-p2-stub] 本地 stub（真 HTTP/真 SSE/真落盘），不等于外部供应商真实调用
[dxos-p2-stub] checks=15 failures=0 / 结果：全部通过，exit 0        STUB_EXIT=0

$ npm run test:model-ipc-ui
10/10 IPC checks passed
PASS: model:command IPC 边界（白名单 / write-only / no raw secret）在真实 Electron 中成立
MODELIPC_EXIT=0

$ npm run test:design-system
01-token-contract PASS / 02-theme-glass-matrix PASS / 03-component-states PASS /
04-keyboard-a11y PARTIAL {"PASS":33,"NOT VERIFIED":1} / 05-motion-matrix PASS
合计 5 个探针：PASS 4 / PARTIAL 1 / FAIL 0                          DS_EXIT=0
```

## 4. 独立验证（验证岗与移植岗分离，只读复算）

- **A1/A2 精确相等**：`protocols.ts:281-2568` 顶层 key 29 个、`:2589-2982` 20 个，与 `legacy-protocols.cjs` 的 key **集合与顺序完全一致**（TS AST 解析，不用文档）。
- **A3**：`builtins.ts:2346-2397` 15 个 provider、`:2399-2715` 18 个 model，id 集合精确相等。
- **A4 逐协议全量对照**：29 legacy + 18 v2 的 operations/workflows/modelProfiles/capabilities **无真实不一致**（apimart-images 的运行期追加键 ops 35 / workflows 30 / profiles 27 已逐条核算）。
- **A5 路径字面量**：legacy 105/105、v2 56/56，MISSING=0 / EXTRA=0。
- **A6**：`PLATFORM_PROTOCOLS` 14 元素逐元素相等；`defaultModelProtocol` 源 16 条 if 分支逐条等价。
- **A7**：源 `:3610-6794` 24 个 export function **24/24 落地**，未移植 = 0；CLI/原生适配/云计费为显式结构化例外。
- **约束审计**：`package.json`、`package-lock.json`、`index.html`、`src/design-system/tokens.css`、`DESIGN_SYSTEM.md`、`MOTION_SYSTEM.md` **零改动**；preload 顶层仍 **17 键**、未暴露 `ipcRenderer`；CSP 仍 `connect-src 'none'`；无新增依赖。
- **离线**：socket 级守护下新增 111 个用例 + 既有受影响 90 个用例 + 2 个探针脚本，**0 条非回环连接**。

## 5. 差异与处置

| 编号 | 问题 | 处置 |
|---|---|---|
| D2 | `legacy-executor-media.cjs` 的 `verifyDxTemporaryUrl` 会探测 `api.dx-os.com/v1/media/temp/` | **已删除该探测**（属 OUT 范围），保留 URL 校验后恒判"非 DX 临时 URL"，参考素材原样提交；测试用 host 统计断言 0 次访问该主机 |
| D3 | v2 模型协议数组顺序与源不一致 | 按 `builtins.ts:2399-2715` **重排**并加顺序断言 |
| D4 | legacy 条目一律 `ported:true` 掩盖了执行链不可用 | 新增附加字段 `execution`（v2=declarative / 5 个可见 legacy=unavailable+reason / 其余 available）与 `shadowedLegacy` 清单；`ported` 语义（定义已移植）不变 |
| D5 | agnes 在 v2 与 legacy 同名，遮蔽导致不可用分支不可见 | 撤销去重例外，改为 `shadowedLegacy` 附加清单（`items` 无重复 `kind:id`，实测 71 条 0 重复） |
| D1 | `sharp` 未在 package.json 声明（transitive 可解析） | **不新增依赖**（§3.5「sharp 按需」、§7 不擅自新增）；保持惰性 require，缺失时返回结构化错误；登记为 B5 媒体批次前置项 |
| D6 | 文档写"legacy 供应商 19 个" | **勘误：源实测 20 个**（`protocols.ts:2659` 顶层 key `cli:dreamina-canvas`，旧 19 是漏项）。按源码为准移植并断言 20 |

## 6. 未验收 / NOT VERIFIED

1. **外部供应商真实调用**：NOT VERIFIED —— 无 `OPENARC_OPENAI_BASE_URL`/`OPENARC_OPENAI_API_KEY` 等凭据；本地 stub 端到端已通过，但**不等于**外部端点连通性。`real-call.mjs` 缺密钥时 SKIP（exit 0）。
2. **CLI 桥 / 第三方原生适配分支**：`cli:jimeng`、`cli:codex`、`cli:gemini`、`runninghub`、`agnes`、`modelscope` 一律返回 `LEGACY_DEPENDENCY_UNAVAILABLE`（属 B3/B4/B5 批次），**未实现、未验证**，无假实现。
3. **云计费**：`apiQuota`（`assertApiModelAccess`/`withDirectApiQuota`）按 OUT 移除，本地无预扣/结算。
4. **`npm run test:theme-baseline` 失败（既有缺陷，非本批引入）**：打印 17 条 dark 断言失败（dark 三格与 light 三格像素完全相同）。证据链：`git diff` 显示本批对 `src/main.tsx` 与 `experiments/` **零改动**；探针最后改动 2026-09-11（db1b0dd），而应用改读 `oa-theme`（旧键 `oa-dark` 降为兼容写入）是 2026-09-12 的 22e4644，基线 128e21d 在其后 —— **该探针在基线上即已失效**。本批不修（属 D1-04 主题探针本身的问题，改它需单独任务）。另注：该脚本失败时仍返回 exit 0，不能作为门禁判据。
5. **`sharp` 压缩路径**：D1，未触发（>620KB 参考图压缩与 sharp 缺失两条分支均未跑）。
6. **逐函数行为差分**：24 个执行器函数只核了导出名、结构化例外与既有测试行为；**未**与源 TS 做逐函数行为等价差分（源依赖 sharp/runninghub/CLI，离线不可执行）。
7. **出口层未 E2E 的动作**：`legacy/chatTools`、`legacy/editImages`、`legacy/audio`、`legacy/describeImage`、`legacy/midjourney` 各 op 已接线但与出口的端到端仅覆盖 chat/chatStream/images/videos/catalog；`provider-protocol-service.cjs`（+347）与 `model-bootstrap.cjs`（+70）**未逐行语义审查**。
8. **`execute` 后仍未提交/未 push** 的工作由 Lead 统一提交，见 §7。

## 7. 环境变更（可逆，需知悉）

- 本机 `~/Library/Caches/ms-playwright` 只有 `chromium-1223`，而 D1-04/D2-01 探针硬编码 `chromium-1228`，导致 UI 门禁原本无法启动（`browserType.launch: executable doesn't exist`）。
- 为使门禁可跑，创建了符号链接 `chromium-1228 -> chromium-1223`（**未改仓库任何文件**）。移除命令：`rm ~/Library/Caches/ms-playwright/chromium-1228`。
- `test:design-system` 因此得以真跑（4 PASS / 1 PARTIAL / 0 FAIL）；`test:theme-baseline` 的失败见 §6.4，与本链接无关（探针键已过时）。

## 8. 结论

B2 遗留五项全部落地：**结构对照无缺失、无新增失败、安全姿态未降级、无云与商业化引入**。门禁结论：build ✅ / 全量测试 ✅（唯一失败为基线环境项）/ 本地端到端探针 ✅ / model IPC 真机探针 10/10 ✅ / design-system ✅ / theme-baseline ❌（既有失效探针，非本批）。
未验收项已逐条列明，不掩盖、不用"下一批修复"搪塞。B3（任务/Agent/工具）可在本批基础上开始。
