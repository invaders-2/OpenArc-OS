# D4-01 · Model Service / Model Proxy / Credential Boundary

- **状态**：macOS Model Service Core（Provider / Credential Boundary / Registry / Resolution / Authorization / Chat）**PASS**；**Model Proxy / Harness child credential isolation / Streaming / Settings UI = NOT IMPLEMENTED / NOT VERIFIED**；overall **PARTIAL**
- **分支**：feature/d4-01-model-service，基线 feature/d3-05-identity-data-gate @ `00c079a`（`488a9cf` + D3-05 标准测试入口），未 merge main
- **日期**：2026-09-15

## Scope
Provider 管理、Endpoint 策略、Credential 安全保存、Model Registry、Capability、Personal/Organization 默认、Config Resolution、Authorization、单次 Chat、Usage、Error Normalization、secret 脱敏、schema v8 迁移。**不实现** Task 调度 / Harness Task Loop / Tool 执行 / Model Proxy HTTP transport（本轮未完成）。

## Trust Boundaries
Renderer / App → Model Service → Authorization → Resolver → Credential Boundary → Provider Adapter → Provider。**Provider API Key 永不进入 Renderer / DB / search / preview / audit**。

## Provider Model
`model_providers(provider_id, org, owner, scope, adapter_type, base_url, endpoint_scope, status, credential_ref, version)`；Provider Adapter 层独立（`provider-adapter.cjs`，openai-compatible），不在 UI/Task 判断 provider 类型。

## Credential Boundary
`CredentialStore` + 后端抽象：Electron `safeStorage`（macOS Keychain / Windows DPAPI）；测试显式注入 memory 后端。**无 plaintext fallback**：后端不可用 → `CREDENTIAL_STORE_UNAVAILABLE`。DB 只存 `credentialRef / credentialVersion / status`。

## Credential Backend
`safeStorageCredentialBackend({safeStorage, dir})` 写 `<userData>/credentials/<ref>.bin`（OS 加密，0600）；`memoryCredentialBackend()` 仅测试注入。

## No Plaintext Fallback
无后端时 `createSync` 返回 `CREDENTIAL_STORE_UNAVAILABLE`；测试断言不写明文、不返回 raw secret。

## Provider Adapter
`chat({baseUrl, apiKey, model, messages, tools, params, stream, signal, timeoutMs})`，`redirect: "error"`（跨域带凭据重定向直接失败）。

## Endpoint Policy
`validateEndpoint`：拒绝 `file:/ftp:/gopher:/unix:/data:/javascript:`、URL 内凭据、query 内 secret、metadata 地址（169.254.169.254 / link-local / metadata host）；localhost 允许 http(s)；private IP 需显式 `allowLan`（LAN_EXPLICIT）；远程必须 https（TLS 校验不可关）。

## SSRF
危险协议 / metadata / link-local 全部 `ENDPOINT_BLOCKED`（测试覆盖）。

## Redirect Policy
credentialed cross-origin redirect = DENY（fetch `redirect:"error"`）；测试中 fake provider 返回 302 → 调用失败，attacker 未收到 key。

## Model Registry
`model_configs(config_id, provider_id, org, owner, scope, remote_model_id, capabilities, verified_capabilities, status, version)`。

## Capabilities
第一版 chat / tool-calling / vision-input / image-generation / video-generation / embedding；不按模型名猜能力；`verified_capabilities` 只由真实测试写入。

## Defaults
`model_defaults(organization_id, owner_user_id, capability, config_id)`，支持 personal + organization default。

## Resolution
Personal explicit/default → Authorized Organization default → `MODEL_CONFIG_UNAVAILABLE`。显式 Personal 配置失败**不 fallback** 到 Team。

## Config Snapshot
`resolveModel` 返回 `{modelConfigId, modelConfigVersion, providerId, modelId, capabilities, source, scope}`（credentialRef 只内部可见）。

## Authorization
复用 D3 Identity（`resolveActor`）+ App Principal + 同一张 App Grant 表（`resource_type='model'`，action namespace `model.view/use/manage/test`）；App Grant 默认 DENY；无第二套 Model ACL。

## App Context
`context.appId` 必须是 enabled App 且持有对应 model action；disable App 后下一请求 DENY。

## Model Proxy
**NOT IMPLEMENTED / NOT VERIFIED**：loopback HTTP transport、scoped capability、proxy auth matrix、child-process credential isolation 探针本轮未实现。

## Proxy Transport / Proxy Capability / Harness Boundary
**NOT VERIFIED**。方向仍冻结为 127.0.0.1 + short-lived scoped bearer capability + 每次请求重新 authorize；`HARNESS_RAW_PROVIDER_KEY = FORBIDDEN` 不变。

## Streaming
**NOT IMPLEMENTED / NOT VERIFIED**（非流式 chat 已实现）。

## Cancellation / Timeout
AbortSignal 取消 → `CANCELLED`；3s 超时 → `MODEL_TIMEOUT`；测试断言请求被终止。

## Retry Policy
默认 **0 次隐藏 retry**；fake provider 500 → 只请求 1 次（真实计数断言）。

## Error Normalization
AUTH_FAILED / RATE_LIMITED / MODEL_NOT_FOUND / CAPABILITY_UNAVAILABLE / MODEL_TIMEOUT / PROVIDER_UNAVAILABLE / PROVIDER_PROTOCOL_ERROR / CANCELLED / PARTIAL_RESPONSE / CREDENTIAL_UNAVAILABLE / CREDENTIAL_MISSING / CREDENTIAL_STORE_UNAVAILABLE / ENDPOINT_BLOCKED / MODEL_CONFIG_UNAVAILABLE。

## Usage
`model_call_records` 只存安全 metadata（requestId / user / app / provider / model / configVersion / 时间 / status / tokens），不存 prompt/response。

## Logging / Privacy
secret 脱敏 `redactSecrets`；响应 / 库内不出现 raw key（测试断言）。

## Tool-call Proposal
Provider 返回 `tool_calls` 只作为结构化数据返回，**0 执行**（硬 Gate 测试）。

## No Tool Execution
未调用任何 Device / MCP / Shell / File / Resource Mutation。

## Renderer Boundary
**NOT IMPLEMENTED / NOT VERIFIED**：`model.command` 桥、Settings UI、preload 白名单本轮未做。

## Migration
`SCHEMA_VERSION = 8`；v1→current … v7→current、current→current、失败回滚由迁移套件覆盖（18/18）。

## macOS
`npm test` **473/473**（含 10 个 D4-01 测试）；`provider-adapter` 真实 localhost fake provider。

## Windows
**NOT VERIFIED**（DPAPI / proxy / firewall / UI 未验）。

## D4-02 Handoff
D4-01 只交付 Model Config / Credential / Registry / Resolution / 单次 Chat 核心；Model Proxy 与 Harness 隔离接口仍未交付，**D4-02 = BLOCK，直到 D4-01 补齐 Proxy + child isolation**。Harness raw key forbidden / ACP only / Model Proxy only / no production tool execution 约束不变。

## Evidence
见 `docs/D4-01-RESULT.md`。

## Remaining Gaps
Model Proxy HTTP transport + scoped capability + proxy auth matrix；独立 child credential-isolation 探针；Streaming 事件模型；Settings → Models UI；IPC/preload model.command；secret scan 跨 DB/search/log/audit/renderer/child env/argv；restart 用真实 Keychain 验证；Windows。
