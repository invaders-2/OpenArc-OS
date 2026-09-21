# D5-02 Closure · 验收补齐与边界证据（唯一口径 · 2026-09-20）

**基线 `18b7c4c`（完整 HEAD 核对一致、工作树干净）→ 代码/测试提交 `ce5dd21`**；分支 `feature/d4-03-tool-proxy`；
未 push、未合并 main、未触碰其他工作区、未进入 D5-03。复用现有画布：本轮**没有**重写画布、**没有**新增视频或多人协作。

## 1. 一次生成的任务 / 预算 / 停止归属（先定归属，再补最小接线）

| 维度 | 归属 | 实现 |
| --- | --- | --- |
| 任务 | 一次画布生成 = **一个 Task**（appId=canvas，goal canvas.generate:<kind>:<nodeId>） | canvas-service.startRun → TaskService.createTask/startTask；canvas_runs（v18）绑定 run↔task↔画布↔基准 revision |
| 预算 | **任务级 MODEL_CALLS 账本**（与任务层同一份） | 调用前 getTaskBudget 判定 remaining≤0 → BUDGET_EXHAUSTED（run 终结，**不发请求**）；调用后 completeModelCall + recordBudgetConsumption |
| 停止 | **任务级取消** + run 终结 + 在途 abort | canvas/runStop → requestCancel/cancelTask + finishRun(STOPPED) + AbortController；桥把用户级联停止转成 abort 消息 |
| 授权 | 每次调用重新解析 + 重新授权（不冻结绑定） | run 任务**不绑定** model config：canvas/modelChat|modelImage 每次经 ModelService.resolveModel（App Principal = canvas）+ TaskService.startModelCall 重查任务/模型绑定 |
| 版本 | run 固定 baseRevision | 迟到的结果只在画布 revision **未前进**时返回；否则 CANVAS_CHANGED，结果不落回（用户内容优先） |

**唯一模型入口**：model-bootstrap 删除 canvas/chat、canvas/image（不留第二条模型路径）；画布生成只能走 canvas:command 的 run 链。
画布是**独立 App Principal**（canvas），内置授予 model.view/model.use 显式、可按组织 seed、可被 governance/revokeAppAccess 撤销。

## 2. 本轮实测（门禁 experiments/d5-02/canvas-e2e.mjs，真实 electron . + 本地确定性 provider）

| # | 检查 | 结果 |
| --- | --- | --- |
| D2 | 图片能力被指到只有 chat 的模型 → CAPABILITY_UNAVAILABLE，provider 收到 0 个图片请求 | PASS |
| D3 | 同一 run 内把任务级 MODEL_CALLS 用尽 → BUDGET_EXHAUSTED，且 **provider 请求数 = 成功调用数**（被拒那次没有发出） | PASS |
| D4 | 停止：在途请求**不可撤回**（如实记录），停止后**不再发新请求**；迟到结果被丢弃（RUN_STOPPED），不覆盖用户随后编辑的节点内容 | PASS |
| D5 | 失败收敛：provider 500 → 明确失败、**每次调用恰好一次请求**（无隐藏重试）、响应与投影里**没有凭据** | PASS |
| D1 | 无权限：撤销画布应用 model.use 后明确拒绝且 provider 0 请求 | **未取得证据（FAIL）**：governance/getAppAccess 的投影里没有 model.use 那条授予，撤销动作没有落到句柄上 → 断言无法成立（见 §7） |
| E1 | 宿主只接受**当前画布实例**的消息：伪造 token / 其它 iframe / 外壳自身发的调用一律不执行 | PASS |
| E2 | 后端不信任自报身份：带伪造 userId/sessionRef 的请求按当前会话处理 | PASS |
| E3 | openarc-canvas:// 目录穿越（../package.json）与非白名单扩展名（.md）一律拒绝 | PASS |
| E4 | 出网通道：从画布页面试 fetch / img / WebSocket / 表单提交 / 外站 script，**本地接收端 0 命中**（CSP：connect-src none、form-action none、img/media/font 只允许本 bundle 与 data:/blob:；fetch/XHR 替换只是兼容层） | PASS |
| C1–C12 | 上一轮的集成与产品路径检查（可见可操作、创建编辑保存、撤销重做、关闭重开恢复、文本与图片真实模型链、失败如实、不支持能力、切账号隔离、A28 只读） | 全部 PASS（同一次运行内） |

## 3. 隔离结论的边界（不夸大）

* **宿主级**（不是页面内自证）：CSP 写在画布文档里、协议处理器只读白名单、宿主消息校验（event.source + 每次挂载随机 token）、后端按会话重判身份/权限/版本。
* **已知残余通道（如实登记）**：location.href 形式的**自我导航**无法被 CSP 关闭（浏览器没有可用的 navigate-to 指令），沙箱也不阻止本帧自我导航。缓解：桥拦截用户可点的外站链接、画布页面不持有凭据与 Node、宿主可在下一轮补"非预期导航即重置帧"。本轮**没有**为此新增机制。
* fetch/XHR 替换**不是**出网限制的唯一依据：E4 的四类通道由 CSP 与协议层拦住，接收端零命中。

## 4. 统一图片存储口径（后端已接，产品门禁未覆盖）

* canvas/importAsset：本地导入图片写入**现有资源库**（resourceService.importManaged，managed store），画布只存 openarc-asset:<ResourceRef>；
* canvas/readAsset：按当前用户**逐资源授权**解析为 data URL（有界 8MB），未授权/回收站/已删除 → ASSET_UNAVAILABLE/ASSET_FORBIDDEN；
* 宿主做 ref ⇄ data URL 映射（保存回写稳定 ref），**老文档里的 data URL 原样兼容**（不静默丢图）；
* **本轮未完成**：这条链没有进门禁（未验证"保存重开后仍可用、账号隔离、资源删除后的明确提示"），因此上一轮"全部资源均为引用"的说法在产品证据层面仍不成立。

## 5. AI 编辑的真实产品链（未覆盖）

已有证据是**适配器/工具层**（tests/d5-02-canvas-tool.test.mjs：registry 条目、plan 固定 revision、execute 只用 plan、只读成员 plan=null、批准后用户先改 → knownNoEffect + 用户内容保留）。
**未取得**"真实 Agent 提出 → 用户审批 → 权威执行 → 画布呈现 → 保存恢复"整条产品链的证据，也没有在该链上重放"批准后用户修改 → 旧 revision 执行被拒"的对照。

## 6. 干净导出树单轮结果

| # | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| G0 | npm run build | 通过 | 0 |
| G1 | node --test tests/d5-02-canvas-service.test.mjs tests/d5-02-canvas-tool.test.mjs | **12 PASS / 0 FAIL** | **0** |
| G2 | node experiments/d5-02/canvas-e2e.mjs | **24 PASS / 1 FAIL（D1）/ 25** | **1** |
| G3 | npm run test:d5-01（回归） | **64 PASS / 0 FAIL / 1 NOT VERIFIED** | **0** |

## 7. 判定

**D5-02 维持 PARTIAL。** 已明确要求但本轮未取得证据的项目：
1. **D1 无权限路径**：撤销画布应用 model.use 后的"明确拒绝 + provider 0 请求"没有证据（门禁里该断言 FAIL，未删除、未放宽）；
2. **统一图片存储口径的产品验证**（保存重开 / 账号隔离 / 资源删除提示）；
3. **AI 编辑的真实产品链**（Agent 提议 → 审批 → 执行 → 画布呈现 → 保存恢复 + 旧 revision 对照）。

已通过并有实测证据的：停止（D4）、预算（D3）、能力不支持（D2）、失败收敛与无重试/无凭据（D5）、宿主级隔离（E1–E4 + CSP/协议/后端重判）、以及上一轮的集成与产品路径（C 系列）。
视频、多人实时协作仍按 PLAN 单列为非必需项，本轮不扩开发。