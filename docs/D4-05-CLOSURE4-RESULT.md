# D4-05 Closure-4 · 记忆上下文信任分层修复（A36）

- 工作树：`/Users/wepingli/Desktop/OpenArc OS-d4-01`；分支：`feature/d4-03-tool-proxy`
- **实际 Base HEAD**（开工核对，干净）：`a490a0b2c7265779af72825fdfd4f10c354e2abd`（并发会话的文档对齐提交；未再以 `c75f1ba` 为基线，未回退 `a490a0b`）
- **代码与测试被测 commit**：`698117fff03f2d11d952bf94dc99035197ddd09e`（parent = a490a0b；仅 source + tests）
- **报告与证据提交**：本文件 + `docs/D4-05-RESULT.md`、`docs/D4-ACCEPTANCE-RESULT.md`、`docs/D4-05-CLOSURE3-RESULT.md`（更正）、`PROGRESS.md`、`docs/D4-04/05-GATE-EVIDENCE.json`
- 范围：修正 Closure-3 把记忆正文作为 `role:"system"` 注入的信任分层缺陷；不接真实外部服务/凭据；不进入 D5/D6；不 push、不合并 main。
- **结论**：消息结构信任分层已修复；**S4 = PASS（限定“消息结构 + 授权/执行边界”）**，并**收窄安全结论**——这些测试不证明真实模型绝不受提示注入影响。**D4 = PARTIAL 不自动升级**（剩余为既有未验证项）。

## 1. 并发变更核对

- 开工时 `git rev-parse HEAD` = `a490a0b`，工作区干净；`c75f1ba..HEAD` 仅有 `a490a0b`。
- `a490a0b` 只改 `PROGRESS.md`、`docs/D4-05-RESULT.md`、`docs/D4-ACCEPTANCE-RESULT.md`（文档对齐），**不涉及本轮代码/测试文件**，无同文件并发编辑。已保留、未覆盖/回退。
- 期间另有兄弟工作区 `OpenArc OS-integration` 的并发重型测试占用机器（导致个别 dsh 用例偶发 ~900s stall 超时）；本工作树未触碰它，也未受影响文件的正确性。

## 2. 消息结构变化（修复内容）

协议：OpenAI-compatible chat completions（`HarnessModelAdapter` → ModelProxy → `model-service.chat` → `provider-adapter.chat`，`JSON.stringify({model, messages, tools, params})` 原样发送）。协议只有 system/user/assistant/tool，**无原生低信任数据块角色**，且**不得伪造 `tool_calls`**。

| 项 | 修复前（Closure-3） | 修复后（Closure-4） |
| --- | --- | --- |
| 记忆正文承载 | `{role:"system", content: preamble + BEGIN/END 标记 + 正文}` 置于 messages 最前 | `{role:"user", name:"openarc.reference_data", content: JSON.stringify({v:1,type:"openarc.reference_data",trust:"untrusted",items:[{resourceRef,resourceVersion,text}]})}` |
| 固定安全规则 | 与正文同一条 system 消息，依赖 “NOT a system instruction” 文本声明 | 独立的 `{role:"system", name:"openarc.rules", content: OPENARC_RULES_TEXT}`，**常量、零资源可控文本** |
| 隔离手段 | 文本声明 + 正文分隔符（BEGIN/END） | **结构隔离**：固定规则与正文分属不同消息/角色；正文经 JSON.stringify 转义为惰性数据 |
| 清理旧装配 | 扫描正文是否含 BEGIN/END 标记（可误删/误配对） | **只按应用自有结构标签**（`name`）过滤，绝不扫描正文 |
| 不可安全处理 | 残缺标记 → 403 | `body.messages` 非数组或元素非普通对象 → **403 `MEMORY_CONTEXT_UNSAFE(MESSAGES_MALFORMED)` 不转发** |

- **放置**：在所有**前导 system 消息之后**、第一条非 system 消息之前插入 `[rules, reference]`；无 system 则插在最前。
- **结构不可注入**：正文中的伪造 `"role":"system"`、`Human:`、`BEGIN/END` 标记、嵌套 JSON、引号/换行/控制字符都被 `JSON.stringify` 转义为字符串内惰性字符，**不改变消息角色序列/数量**，也不产生 assistant/tool 消息。
- **不保留旧 system 记忆块**：本适配器自本修复起不再产生任何 system 记忆块；记忆注入只发生在本适配器内部、**不回流 Harness、不持久化**，因此旧 system 记忆块在架构上不可达（代码注释已写明）。本轮删除了 `MEMORY_MARKER`/`MEMORY_REFERENCE_PREAMBLE`/`formatMemoryBlock` 及正文标记逻辑。
- **不误删合法输入**：合法用户文本即使含 `BEGIN/END_OPENARC_AUTHORIZED_MEMORY` 或旧 preamble，也因无应用标签而原样保留（出站逐字节一致）。

## 3. 权限与隐私保证（保持有效）

逐请求重新授权、删除/撤权/切账号隔离、预算续接重新装配、有界片段（5×1200≤4000）、正文不落盘、审计只记 `count/refs/reason`——全部沿用，未放宽。完整出站路径（HarnessModelAdapter → ModelProxy → model-service → provider-adapter）逐层确认只做原样转发，不会把低信任记忆再搬进高权限消息。

## 4. 验证边界（Closure-3 过度表述的更正）

- 这些测试证明：**消息结构（记忆只在低信任 user 参考消息、system 常量零资源文本、结构不可注入）**、**逐请求授权/删除/撤权/切账号/续接隔离**、以及**执行边界（越权 WRITE 仍走 `ControlledToolProxy` → APPROVAL_REQUIRED、0 自动批准 / 0 mutation）**。
- **不证明**：真实模型绝不会受恶意记忆的提示注入影响。模型仍可能把参考数据当文本遵循；真正的兜底是后端权限/审批与逐请求重授权，而非提示语本身。Closure-3 中“注入文本是惰性参考数据”被读作“模型不会遵循”的表述属过度，已在本轮更正。

## 5. 检查结果（均在 `698117f`；干净工作区，`workspaceState=""`）

| 命令 | 结果 | exit |
| --- | --- | --- |
| `node --test tests/d4-05-s4-memory-context.test.mjs` | **15 / 15 PASS** | 0 |
| `node --test tests/d4-05-s4-memory.test.mjs` | 2 / 2 PASS | 0 |
| `npm run test:d4-05-memory-ui` | **15 / 15 PASS**（真实 Electron UI） | 0 |
| `npm run test:d4-05` | **169 / 169 functional**；S1/S2/S3/S4 全 PASS；`overallStatus=PASS` | 0 |
| `npm run test:d4-08-verification-ui` | 22 / 22 PASS（无回归） | 0 |
| `npm run test:d4-03b-dsh` | 26 / 26 PASS | 0 |
| `npm run test:d4-04` | 94 / 94 PASS | 0 |
| `npm test` | **984 / 984 PASS** | 0 |

环境：Electron 44.3.0 / Node 24.20.0（Electron 内建）/ darwin arm64；`rendererConsoleErrors` / `mainUnhandledErrors` / `secretHits` = 0。
证据：`docs/D4-05-GATE-EVIDENCE.json`（169 条，`artifactSha256=a0663ca0…dfa7`；S4 共 32 条 = Node 17 + UI 15）；`docs/D4-04-GATE-EVIDENCE.json`（94 条，`b56e24c5…ca9e2`）；原始 UI artifact（gitignored）`artifacts/d4-05-memory-ui/memory-ui-gate.json`（`9b4c5d04…699b`，secretHits=0）。

## 6. 验收对应（本轮要求）

| 要求 | 证据 |
| --- | --- |
| 1 授权记忆进入参考数据位置；高权限消息不含资源可控正文 | Node 用例 1/12 + UI S1.3/S1.4（逐条断言 system/developer 不含 secret/标题/正文） |
| 2 恶意角色/指令/分隔符不能改变请求结构 | Node 用例 12（角色序列只多出 rules+reference；伪造 role/Human/标记/嵌套 JSON 被转义为惰性字符串） |
| 3 删除/撤权/切账号/续接后旧记忆不再出站 | Node 用例 3/4/5/9 + UI S2.2/S3.1 |
| 4 合法用户文本含相同标记不被误删 | Node 用例 11（用户文本含 BEGIN/END/旧 preamble 原样转发） |
| 5 按恶意记忆返回的越权工具请求仍被拒 | Node 用例 15（provider 真实提出 `resource_trash` → APPROVAL_REQUIRED、0 自动批准 / 0 mutation / 0 未授权执行） |
| 6 真实 Electron 记忆隔离流程无回归 | `test:d4-05-memory-ui` 15/15 |

## 7. 剩余限制

1. **不证明抗提示注入**：见 §4；模型层是否遵循参考数据不可由确定性 provider 证明。
2. **协议无原生低信任数据通道**：OpenAI-compatible 仅有 system/user/assistant/tool；本轮以“独立 user 参考消息 + 应用标签 + JSON 转义 + 常量规则”实现结构隔离，未能（也不应伪造）使用 tool_calls。`name` 字段是应用可控结构标签，个别 provider 可能忽略它，但不会因此把正文提升为 system。
3. **S4 = PASS（限定“消息结构 + 授权/执行边界”）**；**D4 = PARTIAL 不自动升级**（D4-01/D4-02 Windows/External Provider、D4-03 外部审计、真实 `electron/main.cjs` 全流程仍为既有 NOT VERIFIED）。
4. 未接真实外部服务/凭据、未使用真实私人记忆；未 push、未合并 main、未触碰默认工作区。
