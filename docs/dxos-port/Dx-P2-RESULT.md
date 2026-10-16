# Dx-P2-RESULT · 模型与协议域（B2，模块 4/5/6）

> 依据：计划 §7 P2、§8。基线：`dxos-port/r1` @ `128e21d`。

## 1. 交付物对照

| P2 要求 | 落点 | 状态 |
|---|---|---|
| 协议表与统一调用出口 | `provider-protocol-{domain,store,service}.cjs` | ✅ DONE |
| 声明式协议引擎（编译执行/工作流轮询/产物下载防 SSRF） | `electron/protocol-engine/`（15 个 .cjs） | ✅ DONE（见 §3 未移植清单） |
| 能力 manifest 与参数 schema | `electron/model-manifest-{domain,service}.cjs` | ✅ DONE |
| 模型路由与描述符 | 同上（`modelResolver`/`modelDescriptor` 语义） | ✅ DONE |
| 本地协议包目录（替代远程更新） | `repository.cjs` 本地扫描 + `model-manifest-service.cjs` | ✅ DONE |
| `model:command` 注册 | `electron/model-bootstrap.cjs`（追加 8 个动作，既有动作逐字未变） | ✅ DONE |
| 前端适配（数据层） | `src/settings/ModelSettings.tsx`（+53 行，无视觉/token/布局改动） | ✅ DONE |
| 新增协议测试 | `tests/dxos-protocol.test.mjs`（12 个用例） | ✅ DONE |
| 真实调用脚本 | `experiments/dxos-p2/real-call.mjs` | ⚠️ 缺密钥，见 §4 |

## 2. 安全与密钥处理（实测）

- **密钥不落明文**：`provider-protocol-store.cjs` 把 `api_key`/`wallet_api_key` 写空串，真值走 `credential-store.cjs` 的 safeStorage backend；写入前用正则拒绝非空 `api_key`（`:114-115` 抛错）。
- **SSRF 防护**（上游 DX OS 没有，本阶段新增）：`artifactDownload.cjs:34-94` 拒绝 localhost/回环/私网/链路本地/CGNAT/云元数据（`169.254.169.254`、`metadata.google.internal`、`100.100.100.200`、`fd00:ec2::254`、IPv4-mapped），DNS 解析后二次校验。
  依据：DXSRC `artifactDownload.ts:12-19,85-103` 只校验 http(s) 与重定向上限 3，**未封私网**。

## 3. 未移植的 DX OS 协议（诚实清单，不做假实现）

- 已完整移植并可执行：**供应商协议 15/15**；模型协议 **1 个**：`openai-images`（含 chat/vision/tools/responses/images.generate/images.edit/video/audio）。
- 未移植的 v2 模型协议 **17 个**（`protocol/list` 中已标 `ported:false`）：openai-chat-media、comfly-openai、gemini-generations、gpt-best-images、fhl-images、gemini、zkki-images、agtoken-videos、apimart-images、midjourney、apib-images、modelscope-images、volcengine、volcengine-speech、xai、minimax、agnes。
  原因：`builtins.ts` 共 2725 行，其余为大体量声明式数据与原生适配器（midjourney/runninghub 需 native executor）；计划 §7 P2 只要求"先 3 个族验证引擎"。
- legacy `protocols.ts` 的 29 模型 / 19 供应商只进协议表（`engine=legacy, ported:false`），legacy 执行器未搬。
- `protocolInference.ts`（231 行规则表）未逐条搬运，`inferModelType` 只保留最保守关键词规则（未命中落到 llm，绝不臆造媒体能力）。

## 4. 真实命令与真实输出

```
$ npm run build                        → ✓ built in 4.09s      BUILD_EXIT:0
$ node --test tests/dxos-protocol.test.mjs
  1..12   # tests 12 / # pass 12 / # fail 0
$ node --test <16 个模型域既有测试 + 本阶段新测试>
  1..132  # tests 132 / # pass 132 / # fail 0
$ env -u OPENARC_OPENAI_BASE_URL -u OPENARC_OPENAI_API_KEY node experiments/dxos-p2/real-call.mjs
  [dxos-p2] SKIP: 未设置 OPENARC_OPENAI_BASE_URL / OPENARC_OPENAI_API_KEY，跳过真实调用（exit 0）。
```

## 5. NOT VERIFIED

- **真实调用（本项为计划 §7 P2 的验收条目）**：NOT VERIFIED —— 环境未提供 `OPENARC_OPENAI_BASE_URL`/`OPENARC_OPENAI_API_KEY` 与图像协议凭据。脚本已就绪，一旦提供即可执行；本轮只验证了 SKIP 路径（exit 0）。**不猜测、不硬编码密钥**。
- `test:model-*` 真机探针（`test:model-ipc-ui` 等）未运行：需真实 Electron + CDP，本轮验收只跑 build 与 node 测试。
- 流式调用未接渲染层下行事件：受"preload 不扩大暴露面"约束，`model:command` 为请求/响应语义，只做聚合返回。
- `ModelSettings.tsx` 未做真机截图/像素比对（无截图证据）。
