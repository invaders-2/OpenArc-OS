# D3-03 · Device Identity / Device Registry / Pairing / TLS

> 状态：**macOS Device Identity Core = PASS；overall = PARTIAL**（Windows 未验证）。
> 基线：`feature/d3-02-object-authorization` @ `9119f85`；本分支 `feature/d3-03-device-identity`。
> 本文只记录**被真实执行验证过**的结论；未验证项一律写在 §33，不写成"已完成"。

## 1. Scope

D3-03 只回答五个问题：这台设备是谁 / 属于哪个 Organization / 是否仍被授权 /
当前 TLS 连接是否真的是这台已注册设备 / 用户是否有权让这台设备参与当前操作。

不在本轮：完整任务调度、Tool Lease、Resource Library CRUD、跨设备文件传输、
Agent Tool Execution、Plugin Sandbox、MCP 完整执行链。

## 2. Threat Model

| 威胁 | 对策 | 证据 |
|---|---|---|
| 攻击者拿到 pairing token 抢注设备 | 单次消费 + 事务原子（§17 §57） | `device-store.consumePairing` 的 `WHERE status='ISSUED'`；race 探针两条路径 |
| 重放已用 token 注册第二台设备 | CONSUMED 恒拒绝，同 IP/hostname 无效（§18） | `device-pairing-replay.test` |
| 用 Device A 的凭据冒充 Device B | payload deviceId 必须等于 TLS 身份（§33 §34） | `device-impersonation.test` |
| 证书仍然有效但设备已被撤销 | **两层判定**：凭据有效性 ≠ 设备授权（§24） | TLS 矩阵 REVOKED/DISABLED 两条 |
| 撤销后靠长连接继续发消息 | 撤销即关连接 + 每条心跳重读 Registry（§26 §35） | `device-revocation.test` + `heartbeat` 每次 `deviceById` |
| 跨组织用 deviceId 横向移动 | 组织绑定 + 对外收敛 reason（§9） | `device-cross-org.test` |
| 明文/降级连接 | fail closed；无明文监听（§22 §62） | TLS 矩阵静态扫描 + `requestCert` 退化自检 |

## 3. Device Identity

`deviceId = "dev_" + randomBytes(24).base64url`（与 D3-01/D3-02 同一 ID 工具）。
**User Id ≠ DeviceId** 冻结：一个用户登录成功不等于任意设备可信；一台设备注册成功
也不等于它上面的任意用户有权使用所有资源。

hostname / IP / MAC / machine name / certificate serial **只能作为 metadata**：
`sanitizeMetadata()` 显式丢弃这些键（§4），`certificate_identity` 也从不来自它们。

## 4. Device Registry

表 `devices`：deviceId、organizationId、displayName、platform、architecture、status、
registeredAt、registeredBy、lastSeenAt、certificateIdentity、credentialVersion、
agentVersion、metadataVersion、departmentId、connectivity。

`registered_at` 只在**首次激活**时落一次（`markRegistered` 用 COALESCE，rename/离线不刷新）。

## 5. Device States

PENDING / ACTIVE / DISABLED / REVOKED；迁移表见 `device-domain.TRANSITIONS`，
**REVOKED 无出边**。非法迁移返回 `INVALID_STATUS_TRANSITION`；
"把 REVOKED 再启用"返回明确的 `DEVICE_REVOKED`（不是通用迁移错误）。

**OFFLINE 与状态是两根轴**（`connectivity` 与 `status` 两个列）：离线只改 connectivity，
永不自动变成 REVOKED（`device-registry.test` 断言状态仍 ACTIVE）。

## 6. Organization Binding

每台设备必须绑 organizationId；配对 token 也绑组织，跨组织 token 直接
`PAIRING_TOKEN_ORGANIZATION_MISMATCH`。跨组织访问对外收敛为
`NOT_FOUND_OR_FORBIDDEN`（anti-enumeration），内部审计保留 `CROSS_ORGANIZATION_DEVICE`。

## 7. Department Access

`device_access` 支持 ORGANIZATION / DEPARTMENT / **USER** 三类主体（§11），
授权动作限定在 `device.view` / `device.use`。**没有第二套 Permission Engine**：
主体与动作求值复用 D3-02 的语义（默认拒绝 + 叠加允许），设备侧只做交集。

Department Admin 本轮**不**获得 `device.manage` / `disable` / `revoke`
（`ACTION_AUTHORITY` 冻结为 SUPER_ADMIN）；探针断言 dana 调 revoke 得 `NOT_SUPER_ADMIN`。
是否下放部门管理 = DEFERRED TO POLICY EXTENSION（§52 允许的显式 DEFERRED）。

## 8. Device Actions

`device.view / use / manage / disable / revoke / pair`。
任何执行判断都走动作，**不写 role === ADMIN**（role 只在治理闸门里出现一次）。

## 9. Pairing

流程与规格 §15 一致：Super Admin 发短时凭据 → New Device 验 Service Identity →
提交凭据 + 设备公身份 → **服务端原子消费** → 建 Registry → 发凭据 → 变 ACTIVE。

## 10. Pairing Credential

short-lived（默认 5 分钟，上限 60 分钟，`DEFAULT_PAIRING_TTL_MS` / `MAX_PAIRING_TTL_MS`）、
single-use、random（256bit）、auditable、organization-bound。
**只存 sha256**（`pairingSecretHash`），明文只在返回值里出现一次。

## 11. Replay

成功配对后重复提交同一 token → `PAIRING_TOKEN_ALREADY_USED`，不产生第二台设备。
配对凭据不是设备凭据：拿它当 fingerprint 去 `authenticateConnection` 会
`DEVICE_CREDENTIAL_UNKNOWN`（§16）。

## 12. Service Identity

配对前必须能确认"这是我要加入的 Control Service"：`createPairing` 返回
`serviceIdentity`，`consumePairing` 要求 `serviceIdentitySeen` 完全一致，否则
`SERVICE_IDENTITY_MISMATCH`。未配置 `OPENARC_SERVICE_IDENTITY` 时**任何配对都被拒**
（fail closed）。**没有采用 TOFU**（§61）；LAN 发现只用于地址发现（§20）。

## 13. TLS

`experiments/d3-03/tls-control-service.mjs`：唯一的 `tls.createServer`
（`requestCert:true, rejectUnauthorized:true, minVersion:'TLSv1.2'`）。
**没有 http/net 明文监听**（静态扫描：4 个新增文件里明文监听入口 = 0）。
localhost 不被特殊对待：`127.0.0.1` 同样要过 mTLS（§22）。

## 14. mTLS

设备身份优先 mTLS：服务端要求客户端证书，取 `getPeerCertificate().fingerprint256`
规范化为 sha256 大写冒号十六进制，交给 `authenticateConnection`。

## 15. Certificate Identity

指纹是运行时热路径的查找键：`device_credentials.fingerprint` 有唯一索引，
`devices.certificate_identity` 也有（partial unique）。两行同指纹 = 安全漏洞，
不是数据质量问题。

## 16. Device Authorization

两层（§24）：
1. `authenticateConnection({fingerprint})` → 连接是谁（凭据未知/过期/STALE 都在这层拒）；
2. `authorizeDevice` → 组织 → 状态 → 访问授权 → 动作。
**两层都必须过**；TLS 矩阵用 revoked/disabled 两条证明第一层 ALLOW 而第二层 DENY。

## 17. Revocation

撤销立即生效：状态转 REVOKED、**撤销该设备全部凭据**、主动关闭已建立连接
（`closeConnections` 返回关闭条数）、connectivity 置 OFFLINE。
下一次 `authenticateConnection` 与 `authorizeDeviceById` 都 DENY —— **不等证书过期**（§25）。

## 18. Disable / Enable

Disable 是可恢复的管理动作：disable → `DEVICE_DISABLED`；enable → 同一 deviceId 恢复 ALLOW。
两者 reason 码不同（§6 禁止混成 Unavailable）。Revoked 不能 enable（§27）。

## 19. Rotation

`credentialVersion` 严格单调 +1；旧凭据转 ROTATED（立即失效），新凭据 ACTIVE 并写回
`devices.credential_version`。探针还**篡改**旧凭据为 ACTIVE 验证：版本不一致仍然 STALE
（`credentialUsable` 比对 `deviceCredentialVersion`）。轮换会关闭旧连接（rotation race）。
不存在"两个永久有效的设备凭据无法区分"（唯一索引 + 版本比对）。

## 20. Private Key Boundary

私钥只存在于 Device Agent / 受信服务侧：本仓库**没有**任何私钥落库路径，
`device_credentials` 只存 subject 与 fingerprint；审计黑名单
（`AUDIT_FORBIDDEN_KEYS`）让 privateKey/pem/secret/token 物理上写不进去（探针断言）。

## 21. Credential Storage

macOS：本轮**没有**写入任何真实用户 Keychain 条目 —— TLS 测试的密钥全部生成在
`fs.mkdtempSync(os.tmpdir())` 下。生产凭据存储（Device Agent 侧的安全存储）
**尚未实现**，见 §33。Windows：NOT VERIFIED。

## 22. Heartbeat

心跳只接受与当前 TLS 身份一致的 deviceId；并且**每次心跳都重读 Registry**
（`deviceById` + `credentialByFingerprint`），因此撤销/禁用/轮换对已建立连接立即生效。
心跳只更新 lastSeenAt/connectivity/agentVersion，**不改变 status**（§35）。

## 23. Offline / Reconnect

超过阈值只标 OFFLINE（`markOffline`），**不自动 REVOKE**；重连沿用同一 deviceId + 凭据，
不会因网络异常生成第二个身份（§63）。

## 24. Impersonation Protection

Device A 凭据声明 deviceId = B → `DEVICE_IDENTITY_MISMATCH`；
连接对象里的凭据指纹与库里不一致 → `DEVICE_CREDENTIAL_MISMATCH`；
未注册指纹 → `DEVICE_CREDENTIAL_UNKNOWN`。

## 25. Resource Location Contract

`resolveResourceLocation({context, deviceId})` 返回
`{ deviceId, availability, status, connectivity, checkedAt }`。
D3-03 **只定义契约**，不读不写资源表；`storageDeviceId` 的落地属 D3-04。

## 26. Resource Authorization Intersection

`authorizeExecution({context, resourceRef, resourceAction, deviceId, action})`：
资源侧复用 D3-02 `authorize()`，设备侧走 §16，返回 `side: RESOURCE | DEVICE | BOTH`。
探针证明三个方向：有资源无设备 → DENY(DEVICE)；有设备无资源 → DENY(RESOURCE)；
两者都有 → ALLOW(BOTH)；设备中途被撤销 → DENY(DEVICE)。

## 27. Agent Device Access

Agent 没有"任意设备权限"：它只能用当前 User 的 `device.use`。
探针：全允许时 ALLOW；撤掉 device.use（disable）后**下一请求立即 DENY**；
Agent/普通用户自己调 `grantDeviceAccess` 得 `NOT_SUPER_ADMIN`。

## 28. App Device Access

App 不自行选择设备：`authorizeExecution` 的 resource 侧要求 App 在 D3-02 里被授权
（`APP_ACTION_NOT_GRANTED` 会先于设备侧出现）。完整应用能力发现属 D5。

## 29. Audit

`device_audit`：at / actorUserId / deviceId / organizationId / event / reasonCode /
requestId / detail。事件覆盖 PAIRING_CREATED / PAIRING_USED / PAIRING_REJECTED /
DEVICE_REGISTERED / DEVICE_DISABLED / DEVICE_ENABLED / DEVICE_REVOKED / DEVICE_RENAMED /
CERT_ROTATED / TLS_AUTH_FAILED / DEVICE_AUTH_DENIED / DEVICE_AUTH_ALLOWED。
pairing secret 明文全库扫描 = **0 命中**（DB 与 WAL 都查）。

## 30. Migration

v2 → v3 追加 `SCHEMA_V3_SQL`，迁移阶梯逐级、每级一个事务。
- 既有 Identity + Authorization 数据保留（部门/资源/授权/审计逐条断言）；
- 迁移后仍可 login；
- 注入失败 → **整级回滚**：user_version 不前进、v3 表不存在（v2 级与 v3 级各测一次）；
- 幂等：重复 open 不重复执行；
- 版本高于程序支持 → 拒绝打开。

## 31. macOS / Windows

macOS：TLS / Registry / Pairing / Authorization / Revocation / Rotation / 迁移 / 审计
全部真实执行 = **PASS**。
Windows：Named Pipe ACL / DPAPI / 证书存储 / 进程与设备运行时 = **NOT VERIFIED**（无真机，不外推）。

## 32. D3-04 Handoff / D4 Handoff

交给 D3-04：`deviceId`、Registry、设备授权、`ResourceLocation.deviceId`、
Online/Offline、Revoked/Disabled、安全 metadata、跨设备边界。
交给 D4-03：执行链 `validateSession → authorizeUser/App/Resource → **authorizeDevice** →
validateDeviceLease → execute`；Lease 本轮不实现。
`UNKNOWN_EFFECT` 契约继续有效：设备断开不等于结果未知可自动重发（§68）。

## 33. Remaining Gaps（诚实计数）

1. **Windows 全部 NOT VERIFIED**（无真机）：Named Pipe ACL、DPAPI、证书存储、运行时。
2. **Device Agent 侧的生产凭据存储未实现**：本轮只做到测试原型（临时目录密钥）；
   §31 的"生产 Private Key Storage 已安全完成"**不能宣称**。
3. **X.509 级吊销（CRL/OCSP）未做**：REVOKED 是 Registry 层结论（这正是两层语义）。
4. **多级证书链 / IPv6 / wildcard SAN 未覆盖**；TLS1.2 路径未单独跑到（协商到 TLS1.3）。
5. TLS1.3 下 wrong-CA / 过期客户端证书只能观察到 ECONNRESET，"原因"靠独立密码学验证，
   **没有拿到服务端的精确错误文案**。
6. **"明文回退不存在"是静态扫描 + 唯一 effective 配置**，不是运行时抓包级证明。
7. Department Admin 的设备管理 = **DEFERRED TO POLICY EXTENSION**（未半实现）。
8. Resource Library 仍 **PLANNED / NOT IMPLEMENTED**；本轮只有 location 契约与交集证明。
9. `notBefore` 在未来（`DEVICE_CREDENTIAL_MISMATCH` 分支）未单独测。
10. 并发握手、`closeConnections` 在真实 TLS 长连接上的主动关闭未在 TLS 探针里覆盖
    （§26 由单元测试覆盖，TLS 探针是一次性连接）。

## 34. Tests / Evidence

```
npm test                                    262/262
npm run test:d3-03                          run-all 1/1 组通过（TLS 矩阵 12/12）
node --test tests/device-tls.test.mjs       12/12
node experiments/d3-03/run-tls-matrix.mjs   12/12 场景，exit 0
npm run test:security                       FAIL 0 / PARTIAL 3 / PASS 6（= D3-01 基线）
npm run test:d3-01 / test:d3-02 / test:authorization-ui / test:identity-ui   见 docs/D3-03-RESULT.md
```

2026-09-13 复跑记录（同一天内）：`npm test` 262/262、`npm run build` PASS、
安全探针 FAIL 0/PARTIAL 3/PASS 6、TLS 矩阵 12/12。
D1-05 的 TLS 探针首次运行时因 `artifacts/d1-05/tls/`（生成物、被 gitignore）缺失而 BLOCKED，
跑 `experiments/d1-05/gen-test-certs.sh` 后回到基线 —— **属环境前置，不计为 D3-03 回归**。
