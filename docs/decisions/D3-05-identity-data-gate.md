# D3-05 · Identity & Data Integration Gate

- **状态**：macOS Identity & Data Gate **PASS**；cross-platform overall **PARTIAL**（Windows NOT VERIFIED）
- **分支**：feature/d3-05-identity-data-gate，基线 feature/d3-04d-resource-governance-integration @ `b5a9b49`（规范写 `76104ee`；该分支随后增加了一个用户要求的 `b5a9b49` 可视探针 opt-in commit，本阶段基于最新远端 HEAD，未 merge main）
- **日期**：2026-09-15
- **性质**：VERIFY / ATTACK / INTEGRATE / FIX GATE-BLOCKING DEFECTS / DOCUMENT，不新增大型功能。

---

## Scope

验证 D3-01～D3-04 形成的 Identity / Authorization / Device / Resource / Search / Preview / Governance 是否足以作为 D4 数据底座。不改 ACL / Resource Identity / App Principal / Device Identity / Resource Store / Search Index。

## Gate Philosophy

DEFAULT DENY；唯一权威；E2E 真实执行；任何不能可靠回答的问题进入 Gate Matrix；未真实验证一律 NOT VERIFIED；发现真实 Gate blocker 才修。

## Authoritative Domains

Identity→D3-01 IdentityStore；Object Authorization→D3-02 AuthorizationService；Device→D3-03 DeviceStore；Resource Identity→resource_registry；Content→D3-04A Resource Store；Search→派生 FTS；Preview→派生 capability/cache；Governance→D3-02 + D3-04D 命令。未发现第二套 ACL / Session / Resource Identity / Device Identity / Permission Store。

## Fresh Install

全新 DB / userData：initialize → admin login → Department A → User A → membership → Resource → Collection → grant → App grant → search → preview → picker → Project → Canvas → restart，全部真实通过（`tests/d3-05-gate.test.mjs`）。

## Identity Lifecycle

Session 有效/过期/锁定/停用/改密语义保持 D3-01。**Gate fix #1**：Disable 后 Re-enable **不再静默恢复旧 session** —— 重新启用时 authVersion++ 并撤销全部旧 session，用户必须重新认证（满足 §9）。Lock → 受保护动作 LOCKED。

## Authorization

D3-02 User ∩ App ∩ Scope ∩ Department ∩ Action；DEFAULT DENY + ADDITIVE ALLOW；anti-enumeration。

## Department

Department CRUD / 详情计数 / 删除保护 / Department Admin 边界；A→B 迁移后旧 Department 继承权限立即消失、新 Department 生效；显式 USER/APP grant 按冻结规则重新求值。

## App

App Principal + AppResourceGrant；内置 baseline 沿用；新 App 默认 DENY；App disable 下一请求 DENY，治理仍可 enable；type/collection/department ceiling；Memory 默认不对第三方 App 开放。

## Agent

`resource.useByAgent` 独立；无 useByAgent → agent DENY；授予后 ALLOW；撤销后下一请求 DENY。Agent 不能借高权限 App 提权，App 不能借 Agent 提权。

## Device

LINKED 资源受 Device 约束：Device use DENY 或 Resource read DENY 都最终 DENY；Device disabled/revoked 时 preview/read/reveal DENY，只返回安全 availability；REMOTE_DEVICE_CONTENT_UNSUPPORTED 保持。

## Resource

完整生命周期：import → search → preview → edit v2 → restore → trash → restore → permanent delete；ResourceRef 在 rename/tag/collection/version/trash/restore/ownership/scope 后**不变**；permanent delete 后 resource grants 与 app grants 不残留幽灵授权，Audit 保留。

## Search

FTS 只产候选，授权在服务端；零泄漏（name/body/tag 全不可见、无 total/snippet/ref 泄漏）；Revoke 后**无需 reindex** 立即消失；Department 迁移后同上。

## Preview

capability 60s；每次协议请求重新授权；resource revoke / App disable 后即使 capability 未过期也 DENY；Range / 206 / 416 / MAX_RANGE 保持；text/image/pdf/video/audio 正常。

## Picker

只返回 User ∩ App ∩ Type ∩ Action；ResourceRef + 安全 metadata；selectionToken 每次 validate 重新 authorize；撤权后 stale selection DENY。

## Project

Project 只引用 ResourceRef；project member 无 resource grant → resource DENY；撤权后下一 project access DENY；Project 权限不洗白 Resource 权限。

## Canvas

节点保存 ResourceRef + version_mode；默认 PIN_VERSION；资源更新到 v2 后节点仍 v1，显式 Update to latest 才跟进；Trash → UNAVAILABLE，Permanent Delete → DELETED，撤权 → UNAUTHORIZED，不泄漏旧 title/content。

## Governance

Super Admin 治理权 ≠ 内容读取权；Personal Memory 内容默认 DENY；scope / ownership / department / app 治理命令由 Domain 校验并审计。

## Audit

治理与安全动作全部落 `authorization_audit`；不写 password / token / credential secret / Resource body / Memory content；`listAudit` 受治理范围约束。

## Migration

`SCHEMA_VERSION = 7`。逐级迁移 v1→current … v6→current、current→current 由现有 migration 测试覆盖（`migration.test.mjs` v1、`device-migration.test.mjs` v2、`resource-migration.test.mjs` v3、`resource-library-migration.test.mjs` v4/v5、`resource-index-migration.test.mjs` v5→v6、D3-04D v6→v7）；失败注入同级回滚（user_version 不提前、半建表不存在、旧数据完整、可重试）。

## Concurrency

login × authorization、grant vs revoke、disable vs read、department transfer vs search、scope/ownership change vs read/edit、delete vs preview、update vs index、app revoke vs picker choose：结果一致、可解释、无 DB 损坏、无越权窗口（`tests/d3-05-*gate` + 既有 D3 测试）。

## Recovery

import 中断、index RUNNING 中断、preview cache 缺失、迁移失败：权威数据不损坏；`recoverStartup` 可重放。

## Renderer Boundary

preload 桥接成员与 IPC 通道重新冻结：10 桥接键 / 8 通道；未知 channel FAIL；无 raw fs / raw SQL / 凭据读取入口；Renderer DOM / preload response 不含 password hash/salt/token/device key/sourceLocator/internalKey。

## IPC Surface

D2-02 `security-surface.mjs` 直接运行 15/15（含 `sec.bridgeKeysMatchFrozenList`、`sec.ipcChannelsMatchFrozenList`、`sec.everyChannelTrustsSender`）。新增 governance:command 已显式登记。

## Security Freeze

保持 `UNTRUSTED CODE EXECUTION = DISABLED BY DEFAULT`；D1-05 的 OS sandbox / network sandbox / hard memory limit blocker 不关闭；Resource API 安全 ≠ 允许不可信 Plugin raw fs 执行。

## Performance

100 users / 20 departments / 10 内置 App / 10,000 resources：authorized search、picker、department count、resource listing、permission lookup 记录 p50/p95 与 RSS（D3-04D 与 D3-04C 探针数据）。

## macOS

真实 Electron 44.3.0 / Node 24.20.0：D3-01…D3-04D 全部 macOS PASS；D3-05 跨域 Gate 测试真实通过。

## Windows

**NOT VERIFIED。** 无 Windows 真机；不外推。

## Known Flakes

D2-02A Gate 的可视化 occlusion/input 探针在本机环境性 flaky（需要独占物理屏幕/指针，且会显示真实窗口）。**按用户明确要求，D3-05 未连续运行 5 次可视化 Gate**（避免打扰桌面），§56 flaky 5-run 分析记为 **NOT VERIFIED**；替代证据：D2-02 `security-surface.mjs` 直接运行 15/15，且 Gate 失败点历史上只在既有 occlusion/input，属 KNOWN FLAKY / 非 D3 回归。可视探针默认 opt-in（`OPENARC_RUN_VISUAL_PROBES=1`）。

## Remaining Gaps

Windows；D2-02 flaky 5-run 未执行；Subject×Permission 完整矩阵 UI；Browser 网页上传 Picker bridge；Organization Memory Audit Policy；Drag&Drop / Paste；App/Agent usage history；产品化 Backup/Restore（D6）。

## D4 Admission

D3-05 macOS Gate PASS → 建议 **D4-01 Model Service / Model Proxy / Credential Boundary = CONDITIONAL GO**，仍受 D1-02 Harness 条件与 D1-05 Security Freeze 约束。D4 不自动获得工具执行权；必须 D4-01→D4-02→D4-03→D4-04→D4-05 依赖推进。Harness raw provider key = FORBIDDEN，继续走 OpenArc Model Proxy。Resource Agent Contract 只暴露受控 `resource.search/getMetadata/preview/read`，必须 Session ∩ User ∩ App ∩ Resource ∩ useByAgent；Mutation 属 D4-03 Tool Gate；No Raw Path Contract。

## Evidence

见 `docs/D3-05-RESULT.md` §38。
