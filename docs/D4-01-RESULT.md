# D4-01 Result

Task Status: **macOS Model Service Core + Model Proxy + Scoped Capability + Child Credential Isolation + Streaming + `model.command` IPC + Settings/Models UI + 真实 Keychain 重启边界 = PASS；跨 Resource/Search/Renderer 全表面的完整 secret scan / 性能基线 / Windows = 未完成；overall PARTIAL**

> **Closure A–D（已真实通过）**：
> - **A/B** `model.command` IPC + preload 白名单 + 安全面：`tests/model-ipc-ui.mjs` 10/10；`tests/model-bootstrap.test.mjs` 9/9（未知命令 DENY、write-only credential、actor/app 伪造无效、settings App Principal、Confused Deputy DENY）。
> - **C** Settings → Models UI：`tests/model-settings-ui.mjs` 16/16。
> - **D** 真实 macOS secure backend / 跨进程重启 / capability 失效：`tests/model-keychain-restart.mjs` **64/64**。4 个独立 Electron 主进程共享同一 userData，真实 `safeStorage`；重启后 credential 仍可用；replace→v2 / delete→DELETED 跨重启生效；旧 proxy capability 重启后 DENY、新 capability PASS；DB 有 credentialRef 而 secure item 缺失 → `CREDENTIAL_MISSING` 安全失败；无安全后端 → `CREDENTIAL_STORE_UNAVAILABLE`，无明文 fallback。
> - 回归：`npm test` **494/494**；`npm run build` PASS；`npm run test:d4-01` **31/31**；`npm run test:d3-05` **13/13**；`npm run test:security` FAIL 0 / PARTIAL 2 / PASS 6；security-surface **15/15**。
>
> **仍未完成（Closure E/F）**：跨 DB/search/log/audit/renderer/Resource 的**完整** secret scan、resolve/proxy 性能基线、Windows。因此 **D4-01 overall 仍 = PARTIAL，D4-02 仍 = BLOCK**。

## 1. Base
`feature/d4-01-model-service`，基线 `feature/d3-05-identity-data-gate` @ `00c079a`（`488a9cf` + D3-05 标准测试入口 `30fb623` 的 cherry-pick）。未 merge main。D4-01 WIP 在继续前冻结于 `wip/d4-01-model-service-core`（`6244a33`）。

## 2. Architecture
User/App → Model Service → Authorization → Resolver → Credential Boundary → Provider Adapter → Provider。未建立第二身份/权限系统。

## 3. Provider model
`model_providers`（id/org/owner/scope/adapter/baseUrl/endpointScope/status/credentialRef/version），CRUD + list + status。

## 4. Credential backend
Electron `safeStorage` 后端（macOS Keychain / Windows DPAPI）：加密 blob 落 `<userData>/credentials/<ref>.bin`（0600）；测试可显式注入 memory 后端。**不是**"每个 Provider 一把独立 Keychain item"。

## 5. Credential isolation
raw secret 只在 CredentialStore 内部解析；DB/调用响应/renderer DOM 不含 key（探针断言）。独立 child-process 隔离探针 `tests/model-proxy-child.test.mjs` 2/2。

## 6. Provider adapter
`provider-adapter.cjs`（openai-compatible，`redirect:"error"`）；真实 localhost fake provider 端到端。

## 7. Endpoint policy
REMOTE_HTTPS / LOCALHOST / LAN_EXPLICIT；非法/远程明文/metadata/URL 凭据全部 `ENDPOINT_BLOCKED`。

## 8. SSRF / redirect boundary
file/gopher/metadata/link-local DENY；credentialed 302 不转发 key（测试）。

## 9. Model registry
`model_configs` CRUD + status；capabilities/verified_capabilities。

## 10. Capabilities
chat / tool-calling / vision-input / image-generation / video-generation / embedding；不按名字猜；真实调用只验证 chat + tool-call proposal。

## 11. Defaults / resolution
Personal default → Organization default → UNAVAILABLE；显式 Personal 失败不 fallback。

## 12. Config version / snapshot
每次更新 `version++`；`resolveModel` 返回 snapshot（configId/version/provider/model/capabilities/source）。重启但**无改动**不漂移（Closure D 断言）。

## 13. Authorization
复用 D3 Identity + App Principal + 同一 App Grant 表（`resource_type='model'`，model.* namespace）；无第二套 ACL。

## 14. App context
App 必须 enabled 且持有对应 model action；disable App → DENY（测试）。settings App Principal 跨重启保留（Closure D）。

## 15. Model Proxy
`electron/model-proxy.cjs`：唯一 Provider 调用出口，bind `127.0.0.1:0`，只做 `POST /v1/chat/completions`；`tests/model-proxy.test.mjs` 6/6 + `tests/model-proxy-child.test.mjs` 2/2。

## 16. Proxy transport
loopback `127.0.0.1:0`（随机端口，绝不 `0.0.0.0`）；localhost ≠ auth，每请求必须带 scoped capability；不做通用 HTTP 转发。`stop()` 后端口释放、再 `start()` 换新端口（Closure D 验证，无端口/socket/handler 泄漏）。

## 17. Proxy capability
内存态 scoped capability（ISSUED/ACTIVE/EXPIRED/EXHAUSTED/REVOKED），每次请求重新 authorize，`maxCalls` 单线程原子消费。**能力只活在进程内存**：重启后旧 capability 必然 DENY——Closure D 中旧 token 仍在 TTL 内、未耗尽，仍得 401 `PROXY_UNAUTHORIZED`；新 capability 正常 PASS。

## 18. Harness credential boundary
Harness 只拿 endpoint + capability，永不拿 raw key。独立 OS child process 探针：Fake Provider 收到 Provider key；child env/argv/stdout/stderr 扫描 0 hit。

## 19. Chat
真实 localhost fake provider 非流式 chat PASS，usage 记录。

## 20. Streaming
`provider-adapter.chatStream` 真实 SSE 解析 → 统一事件模型；`tests/model-service-stream.test.mjs` 4/4（分段 text.delta、cancel、timeout、disconnect→PARTIAL_RESPONSE）。

## 21. Tool-call proposal
fake provider 返回 `tool_calls` → 只返回结构化数据，**0 执行**。

## 22. Cancellation
AbortSignal → `CANCELLED`，请求被终止。

## 23. Timeout
超时 → `MODEL_TIMEOUT`。

## 24. Retry policy
默认 0 次隐藏 retry；500 → 只 1 次请求（fake provider 计数）。

## 25. Error normalization
统一错误码集合已实现（见 ADR）。

## 26. Usage
`model_call_records` 安全 metadata；不存 prompt/response，也不含 raw secret（Closure D 断言）。

## 27. Logging / secret redaction
`redactSecrets`；Closure D 在真实重启流程中扫描整个 userData（identity.db / `credentials/*.bin` / 日志 / `model_call_records`）与落盘 artifact，raw secret 0 hit。**跨 Resource/Search/Renderer 全表面的完整 secret scan 属 Closure E，仍未做**。

## 28. Renderer boundary
`window.openarc.model.command` 单通道 + preload 白名单；主进程静态 switch dispatch + 命令白名单（16 条）；actor/app 一律取自信任宿主，忽略 Renderer 自报的 userId/appId/role。`tests/model-ipc-ui.mjs` 10/10、`tests/model-bootstrap.test.mjs` 9/9。

## 29. Settings UI
`src/settings/ModelSettings.tsx`（Providers/Models/Defaults，write-only credential、staged 连接测试）经 `model.command` 落地；`tests/model-settings-ui.mjs` 16/16。

## 30. Migration
`SCHEMA_VERSION = 8`；迁移套件 v1→current … v7→current + failure rollback **18/18 PASS**。

## 31. Restart
`tests/model-keychain-restart.mjs` **64/64**：真实 macOS secure backend（Electron `safeStorage` 加密 blob 0600）；4 个独立 Electron 进程共享同一 userData → Provider/Model/Defaults/credentialRef 元数据与 settings App Principal 全部保留、config.version 无改动不漂移；重启后 credential 仍被 Provider 接受；replace→v2 / delete→DELETED 跨重启生效；DB 有 credentialRef 而 secure item 缺失 → `CREDENTIAL_MISSING` 安全失败（不抛栈、无明文 fallback）；无安全后端 → `CREDENTIAL_STORE_UNAVAILABLE`。

## 32. Performance
**NOT VERIFIED**（Closure E：未做 resolve/proxy 性能基线）。

## 33. macOS
`npm test` **494/494**；provider/credential/registry/resolution/authorization/chat/tool/cancel/timeout/retry/redirect/SSRF PASS；proxy/capability/child/streaming/IPC/UI/keychain-restart PASS。

## 34. Windows
**NOT VERIFIED**。

## 35. External Provider
**NOT VERIFIED**（只用 localhost fake provider；未使用任何真实外部 key）。

## 36. Tests
`tests/model-fixtures.mjs`、`model-fake-provider.mjs`、`model-service.test.mjs`、`model-proxy.test.mjs`、`model-proxy-child.test.mjs`、`model-service-stream.test.mjs`、`model-bootstrap.test.mjs`、`model-ipc-ui.mjs`、`model-settings-ui.mjs`、`model-keychain-restart.mjs`（+ fixtures `model-ipc-probe` / `model-settings-ui-probe` / `model-keychain-restart-probe`）；迁移测试更新到 v8。

## 37. Files changed
`electron/identity-store.cjs`（v8）、`electron/model-domain.cjs`、`electron/credential-store.cjs`、`electron/model-store.cjs`、`electron/provider-adapter.cjs`、`electron/model-service.cjs`、`electron/model-proxy.cjs`、`electron/model-bootstrap.cjs`、`electron/identity-bootstrap.cjs`、`electron/main.cjs`、`electron/preload.cjs`、`src/main.tsx`、`src/settings/ModelSettings.tsx`、`src/settings/SettingsContent.tsx`、`src/styles.css`、`tests/model-*.mjs`、`tests/fixtures/model-*-probe`、迁移测试、`experiments/d4-01/run-all.mjs`、`package.json`、`docs/decisions/D4-01-model-service.md`、`docs/D4-01-RESULT.md`、`PROGRESS.md`。

## 38. Commits
backend core + credential boundary；proxy + child isolation + streaming（`df8ec81`）；IPC/preload（`e07cdd2`/`497f02c`）；settings App Principal 绑定（`3cb4900`）；Settings UI（`bc17c42`/`a61f183`）；真实 Keychain 重启边界（本轮 Closure D）。D3-05 入口修复单独提交 `30fb623`（已 push 到 D3-05）。

## 39. Evidence
| 入口 | 结果 |
| --- | --- |
| npm test | **494 / 494 PASS** |
| npm run build | PASS |
| test:d4-01 | **31 / 31 PASS** |
| test:d3-05 | **13 / 13 PASS** |
| test:security（D1-05） | FAIL 0 / PARTIAL 2 / PASS 6 |
| security-surface（D2-02 A13） | **15 / 15 PASS** |
| test:model-ipc-ui | **10 / 10 PASS** |
| test:model-settings-ui | **16 / 16 PASS** |
| test:model-keychain-restart | **64 / 64 PASS**（真实 safeStorage / 4 进程重启） |

## 40. Remaining gaps
完整 secret scan（跨 DB search / Resource / Search / Renderer 全表面，Closure E）；resolve/proxy 性能基线（Closure E）；Windows；External Provider 真机接入。

## 41. D4-02 admission recommendation
**D4-02 = BLOCK**，直到 D4-01 完成 Closure E（完整 secret scan + 性能）与 Closure F（全量回归终局门）。约束不变：Harness raw key forbidden / ACP only / Model Proxy only / no production tool execution。
