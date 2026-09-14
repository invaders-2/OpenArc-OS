# D4-01 Result

Task Status: **macOS Model Service Core = PASS（Provider / Credential Boundary / Registry / Resolution / Authorization / Chat）；Model Proxy / Harness 隔离 / Streaming / Settings UI = NOT VERIFIED；overall PARTIAL**

## 1. Base
`feature/d4-01-model-service`，基线 `feature/d3-05-identity-data-gate` @ `00c079a`（`488a9cf` + D3-05 标准测试入口 `30fb623` 的 cherry-pick）。未 merge main。D4-01 WIP 在继续前冻结于 `wip/d4-01-model-service-core`（`6244a33`）。

## 2. Architecture
User/App → Model Service → Authorization → Resolver → Credential Boundary → Provider Adapter → Provider。未建立第二身份/权限系统。

## 3. Provider model
`model_providers`（id/org/owner/scope/adapter/baseUrl/endpointScope/status/credentialRef/version），CRUD + list + status。

## 4. Credential backend
Electron `safeStorage` 后端（Keychain/DPAPI）+ 测试注入 memory 后端；DB 只存 credentialRef/version/status。

## 5. Credential isolation
raw secret 只在 CredentialStore 内部解析；测试断言 DB/调用响应不含 key。**独立 child-process 隔离探针 NOT VERIFIED**。

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
每次更新 `version++`；`resolveModel` 返回 snapshot（configId/version/provider/model/capabilities/source）。

## 13. Authorization
复用 D3 Identity + App Principal + 同一 App Grant 表（`resource_type='model'`，model.* namespace）；无第二套 ACL。

## 14. App context
App 必须 enabled 且持有对应 model action；disable App → DENY（测试）。

## 15. Model Proxy
**NOT IMPLEMENTED / NOT VERIFIED**。

## 16. Proxy transport
**NOT VERIFIED**（方向仍为 127.0.0.1 + capability）。

## 17. Proxy capability
**NOT VERIFIED**。

## 18. Harness credential boundary
**NOT VERIFIED**（child process / env / argv secret scan 未实现）。

## 19. Chat
真实 localhost fake provider 非流式 chat PASS，usage 记录。

## 20. Streaming
**NOT IMPLEMENTED / NOT VERIFIED**。

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
`model_call_records` 安全 metadata；不存 prompt/response。

## 27. Logging / secret redaction
`redactSecrets`；测试断言响应/库无 raw secret。**跨 logs/audit/artifacts/child 的完整 secret scan NOT VERIFIED**。

## 28. Renderer boundary
**NOT IMPLEMENTED / NOT VERIFIED**（无 model.command / preload 白名单）。

## 29. Settings UI
**NOT IMPLEMENTED / NOT VERIFIED**。

## 30. Migration
`SCHEMA_VERSION = 8`；迁移套件 v1→current … v7→current + failure rollback **18/18 PASS**。

## 31. Restart
**PARTIAL**：元数据持久化由迁移/重启套件间接覆盖；**真实 Keychain 重启后调用 NOT VERIFIED**（测试用 memory 后端）。

## 32. Performance
**NOT VERIFIED**（未做 resolve/proxy 性能基线）。

## 33. macOS
`npm test` **473/473**；provider/credential/registry/resolution/authorization/chat/tool/cancel/timeout/retry/redirect/SSRF PASS。

## 34. Windows
**NOT VERIFIED**。

## 35. External Provider
**NOT VERIFIED**（本轮只用 localhost fake provider；未使用任何真实外部 key）。

## 36. Tests
新增 `tests/model-fixtures.mjs`、`tests/model-fake-provider.mjs`、`tests/model-service.test.mjs`（10 用例）；迁移测试更新到 v8。**未建立** §141 列出的 proxy/stream/redirect/ssrf/secret-scan/restart/ui/child 独立文件。

## 37. Files changed
`electron/identity-store.cjs`（v8）、`electron/model-domain.cjs`、`electron/credential-store.cjs`、`electron/model-store.cjs`、`electron/provider-adapter.cjs`、`electron/model-service.cjs`、`tests/model-*.mjs`、迁移测试、`docs/decisions/D4-01-model-service.md`、`docs/D4-01-RESULT.md`、`PROGRESS.md`。

## 38. Commits
见最终提交（backend core + credential boundary + tests；docs）。D3-05 入口修复单独提交 `30fb623`（已 push 到 D3-05）。

## 39. Evidence
| 入口 | 结果 |
| --- | --- |
| npm test | **473 / 473 PASS** |
| npm run build | PASS |
| model-service.test | **10 / 10 PASS**（真实 localhost fake provider） |
| migration | 18 / 18 PASS（v8） |
| Model Proxy / child isolation / streaming / Settings UI | **NOT VERIFIED** |

## 40. Remaining gaps
Model Proxy + scoped capability + proxy auth matrix；独立 child credential-isolation 探针；Streaming；Settings → Models UI + `model.command` IPC/preload；跨 DB/search/log/audit/renderer/child 的完整 secret scan；真实 Keychain restart；性能；Windows。

## 41. D4-02 admission recommendation
**D4-02 = BLOCK**，直到 D4-01 补齐 Model Proxy、scoped capability、独立 child credential-isolation 探针与 Settings UI；补齐后可 `CONDITIONAL GO`（Harness raw key forbidden / ACP only / Model Proxy only / no production tool execution）。
