# D4-01 Result

Task Status: **D4-01 macOS Model Service / Model Proxy Core = PASS**；**D4-01 cross-platform overall = PARTIAL**（Windows = NOT VERIFIED；External Provider = NOT VERIFIED）；**D4-02 = CONDITIONAL GO**；**D4-03 = BLOCK**。

> **Closure A–F（已真实通过）**：
> - **A/B** `model.command` IPC + preload 白名单 + 安全面：`tests/model-ipc-ui.mjs` 10/10；`tests/model-bootstrap.test.mjs` 9/9。
> - **C** Settings → Models UI：`tests/model-settings-ui.mjs` 16/16。
> - **D** 真实 macOS secure backend 重启边界：`tests/model-keychain-restart.mjs` **64/64**。
> - **E** Full Secret Scan + 性能基线：`model-secret-scan` 13/13 checks、`model-secret-ui` **20/20**、`model-performance` 10/10 checks；Provider Secret 全表面 0 unauthorized hit。
> - **F** 最终验收：`model-isolation.test.mjs` 10/10（User B / Organization 边界）、`model-isolation-ui.mjs` **26/26**（真实 Electron logout/login + Models a11y smoke）；D3 8 个标准入口全 PASS；14 个 Electron UI probe 全 PASS；`npm test` **522/522**；migration **18/18**；security FAIL 0；security-surface **15/15**；dialog-a11y **33/33**。
> - **Closure F 发现并修复真实越权**：非 Super Admin 原本可以修改/删除 ORGANIZATION Provider（`#authorize` 的 org 判据只看 `config` 没看 `provider`），并可从 `credential/status` 读到他人的 secure backend metadata；已修复并重跑全部 Gate。
>
> **仍未完成**：Windows（DPAPI / proxy / firewall / UI）；External Provider 真机。因此 **cross-platform overall 仍 = PARTIAL**。

## 1. Base
`feature/d4-01-model-service`，基线 `feature/d3-05-identity-data-gate` @ `00c079a`。未 merge main。Closure F 起点 `6599696`。

## 2. Architecture
User/App → Model Service → Authorization → Resolver → Credential Boundary → Provider Adapter → Provider。未建立第二身份/权限系统。

## 3. Provider model
`model_providers`（id/org/owner/scope/adapter/baseUrl/endpointScope/status/credentialRef/version），CRUD + list + status。

## 4. Credential backend
Electron `safeStorage`（macOS Keychain / Windows DPAPI）：加密 blob 落 `<userData>/credentials/<ref>.bin`（0600）；测试显式注入 memory 后端。**不是**"每个 Provider 一把独立 Keychain item"。

## 5. Credential isolation
raw secret 只在 CredentialStore 内部解析；DB/响应/renderer DOM 不含 key。独立 child-process 隔离探针 + Closure E 全表面扫描。

## 6. Provider adapter
`provider-adapter.cjs`（openai-compatible，`redirect:"error"`）；真实 localhost fake provider 端到端。

## 7. Endpoint policy
REMOTE_HTTPS / LOCALHOST / LAN_EXPLICIT；非法/远程明文/metadata/URL 凭据全部 `ENDPOINT_BLOCKED`。

## 8. SSRF / redirect boundary
file/gopher/metadata/link-local DENY；credentialed 302 不转发 key。

## 9. Model registry
`model_configs` CRUD + status；capabilities/verified_capabilities。

## 10. Capabilities
chat / tool-calling / vision-input / image-generation / video-generation / embedding；不按名字猜。

## 11. Defaults / resolution
Personal default → Organization default → UNAVAILABLE；显式 Personal 失败不 fallback。

## 12. Config version / snapshot
每次更新 `version++`；`resolveModel` 返回 snapshot。重启无改动不漂移（Closure D）。

## 13. Authorization
复用 D3 Identity + App Principal + 同一 App Grant 表（`resource_type='model'`，model.* namespace）。

## 14. App context
App 必须 enabled 且持有对应 model action；disable App → DENY。

## 15. Model Proxy
`electron/model-proxy.cjs`：唯一 Provider 调用出口，bind `127.0.0.1:0`，只做 `POST /v1/chat/completions`。

## 16. Proxy transport
loopback 随机端口（绝不 `0.0.0.0`）；localhost ≠ auth；`stop()` 后端口释放、重启换端口。

## 17. Proxy capability
内存态 scoped capability；每次请求重新 authorize；`maxCalls` 单线程原子消费；**只活在进程内存** → 重启后旧 capability 必然 DENY（Closure D）。

## 18. Harness credential boundary
Harness 只拿 endpoint + capability，永不拿 raw key。`HARNESS_RAW_PROVIDER_KEY = FORBIDDEN`。

## 19. Chat
真实 localhost fake provider 非流式 chat PASS，usage 记录。

## 20. Streaming
`provider-adapter.chatStream` 真实 SSE → 统一事件模型；Closure E 记录 TTFB/总时长/delta 数并断言顺序与 `response.complete`/`usage`。

## 21. Tool-call proposal
fake provider 返回 `tool_calls` → 只返回结构化数据，**0 执行**（production tool execution = 0）。

## 22. Cancellation
AbortSignal → `CANCELLED`。

## 23. Timeout
超时 → `MODEL_TIMEOUT`。

## 24. Retry policy
默认 0 次隐藏 retry；Closure E 并发场景同样断言 Provider `requests === 10`。

## 25. Error normalization
统一错误码集合；provider error echo 被归一化为安全错误码，0 raw hit。

## 26. Usage
`model_call_records` 恰为白名单 14 列；不存 prompt/response/raw secret。

## 27. Logging / secret redaction
Closure E 已完成全表面扫描：SQLite / audit / call records / IdentityLogger / Resource / Search+FTS / Preview / child / 源码 / 生成文件 / artifact / Renderer DOM / preload / 真实 blob / userData —— 0 unauthorized hit；capability 不落盘。

## 28. Renderer boundary
`window.openarc.model.command` 单通道 + preload 白名单；静态 switch + 16 条命令白名单；actor/app 取自信任宿主。Renderer 不能拿 raw credential / proxy capability / 直连 provider / 直连 proxy / raw SQL。

## 29. Settings UI
`src/settings/ModelSettings.tsx`；Closure F 补齐表单控件 aria-label，并让不可 manage 的 credential status 显示为「—」。

## 30. Migration
`SCHEMA_VERSION = 8`；迁移套件 **18/18 PASS**（v1→current … v7→current + 失败回滚）。

## 31. Restart
`tests/model-keychain-restart.mjs` **64/64**：真实 macOS secure backend；4 个独立 Electron 进程共享 userData；replace/delete 跨重启生效；旧 capability DENY / 新 PASS；missing secure item → `CREDENTIAL_MISSING`；无安全后端 → `CREDENTIAL_STORE_UNAVAILABLE`。

## 32. Performance
**MEASURED ON TEST MACHINE · NOT PRODUCT SLA**（macOS arm64 Apple M3 Pro / Node v22.22.3 / Electron 44.3.0）。Closure F 重跑无 regression：Resolution 100 次/run ×3（Personal p50 0.12–0.14ms / Organization p50 0.14–0.16ms）；Proxy 10 并发 ×3（proxy p50 ≈8–12ms，direct ≈3–6ms，粗估 overhead 2.7–8.2ms）；Streaming TTFB ≈13ms / 3 deltas；Memory smoke RSS +≈3MB / 30 loops（非 leak certification）；open handle 0。

## 33. macOS
`npm test` **522/522**；D3 / D4 全部标准入口 PASS；UI probe 全 PASS；migration 18/18；security FAIL 0。

## 34. Windows
**NOT VERIFIED**：Windows Credential Backend / Proxy Runtime / Firewall behavior / Settings UI。

## 35. External Provider
**NOT VERIFIED**：只用 localhost fake provider，未使用任何真实外部 key。真实 HTTP transport / streaming / auth header / redirect / timeout / cancel / disconnect / proxy / child / secure backend 均已在 localhost 真实验证，因此 External Provider NOT VERIFIED **不阻塞 macOS Core PASS**，但带入 D4-02 / D4-04，最晚 Vertical Smoke 前关闭。

## 36. Tests
Closure A–E 全部测试 + Closure F 新增：`tests/model-isolation.test.mjs`（10）、`tests/model-isolation-ui.mjs` + `tests/fixtures/model-isolation-ui-probe`（26 checks）；`experiments/d4-01/run-all.mjs` 纳入 isolation（`--test-concurrency=1`）；`package.json` 新增 `test:model-isolation-ui`。

## 37. Files Changed
**产品（Closure F 修复）**：`electron/model-service.cjs`（Organization MANAGE 判据覆盖 provider；`credentialStatusForProvider` 仅对 manager 返回 secure backend metadata）、`src/settings/ModelSettings.tsx`（aria-label + 不可 manage 显示「—」）、`src/settings/SettingsContent.tsx`（注释）。
**测试**：`tests/model-isolation.test.mjs`、`tests/model-isolation-ui.mjs`、`tests/fixtures/model-isolation-ui-probe/`、`tests/fixtures/device-ui-probe/main.cjs`（注册 model IPC + A1c 对齐真实 Models pane）、`experiments/d4-01/run-all.mjs`、`package.json`。
**文档**：`docs/D4-01-RESULT.md`、`docs/decisions/D4-01-model-service.md`、`PROGRESS.md`。

## 38. Commits
backend core / credential boundary；proxy + child + streaming；IPC/preload（`e07cdd2`/`497f02c`）；settings principal（`3cb4900`）；Settings UI（`bc17c42`/`a61f183`）；Keychain restart（`9bbdaac`/`dd7f33e`）；Closure E（`0325168`/`a93b157`/`6599696`）；Closure F（本轮 fix + test + docs）。

## 39. Evidence
| 入口 | 结果 |
| --- | --- |
| test:d3-01 / 02 / 03 | **12 / 6 probes PASS；TLS 12/12** |
| test:d3-04a / 04b / 04c / 04d | **4 / 2 / 5 / 5 probes PASS** |
| test:d3-05 | **13 / 13 PASS** |
| identity-ui / authorization-ui / device-ui | **24/24 · 14/14 · 32/32 PASS**（device 2 NOT VERIFIED 声明） |
| resource-ui / resource-library-ui / resource-search-ui / resource-preview-ui | **10/10 · 24/24 · 16/16 · 19/19 PASS** |
| governance-ui / resource-picker-ui / canvas-resource-ui | **10/10 · 8/8 · 8/8 PASS** |
| model-ipc-ui / model-settings-ui / model-secret-ui / model-isolation-ui | **10/10 · 16/16 · 20/20 · 26/26 PASS** |
| test:model-keychain-restart | **64 / 64 PASS** |
| model-secret-scan / model-performance | **13/13 checks · 10/10 checks PASS** |
| migration（含 v8） | **18 / 18 PASS** |
| npm test | **522 / 522 PASS** |
| npm run build | **PASS** |
| test:security（D1-05） | **FAIL 0** / PARTIAL 2 / PASS 6 |
| security-surface（D2-02 A13） | **15 / 15 PASS** |
| dialog-a11y（D2-02） | **33 / 33 PASS** |

## 40. Remaining Gaps
Windows（Credential Backend / Proxy Runtime / Firewall / Settings UI）NOT VERIFIED；External Provider 真机（带入 D4-02 / D4-04，最晚 Vertical Smoke 前关闭）；D2-02 5-run visual occlusion attribution 仍挂账（与 D4-01 无关）；完整 WCAG certification 不在 D4-01 范围。

## 41. D4-02 Admission
**D4-01 macOS Model Service / Model Proxy Core = PASS；D4-01 cross-platform overall = PARTIAL。**
**D4-02 Task / Harness Adapter = CONDITIONAL GO**，冻结条件：ACP ONLY；`HARNESS_RAW_PROVIDER_KEY = FORBIDDEN`；Harness 只与 OpenArc Model Proxy 通信；只接收 Proxy endpoint + scoped capability + safe model snapshot；不拥有 persistent task queue / persistent task state / side-effect retry / tool authorization / production tool execution。
**D4-03 Controlled Tool Proxy = BLOCK**，直到 D4-02 自身 PASS。
