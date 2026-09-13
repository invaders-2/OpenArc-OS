# D3-03 Result

Task Status：**macOS Device Identity Core = PASS；overall = PARTIAL**（Windows NOT VERIFIED；Device Agent 生产凭据存储未实现）。
基线 `feature/d3-02-object-authorization` @ `9119f85` → 分支 `feature/d3-03-device-identity`（已推 origin）。

## 1. Base
`git status` 干净、`9119f85` 存在、D3-02 已提交。D1-05 的 TLS 探针需要先生成
`artifacts/d1-05/tls/`（gitignore 的生成物），跑 `gen-test-certs.sh` 后回到基线 —— **属环境前置，不计 D3-03 回归**。

## 2. Device identity
`dev_ + randomBytes(24).base64url`；**UserId ≠ DeviceId**；hostname/IP/MAC/machine/serial 只当 metadata
（`sanitizeMetadata` 显式丢弃）。

## 3. Device registry
`devices` 表字段按 §5 齐备；`registered_at` 只在首次激活落一次；`certificate_identity` 有 partial unique。

## 4. Device states
PENDING/ACTIVE/DISABLED/REVOKED，REVOKED 无出边；"再启用 REVOKED" 返回 `DEVICE_REVOKED`；
非法迁移 `INVALID_STATUS_TRANSITION`。

## 5. Organization binding
设备与 pairing token 都绑 organizationId；跨组织对外 `NOT_FOUND_OR_FORBIDDEN`，内部审计保留 `CROSS_ORGANIZATION_DEVICE`。

## 6. Department access
`device_access` 支持 ORGANIZATION/DEPARTMENT/USER，动作限 `device.view`/`device.use`；
Department Admin 无 manage/disable/revoke（= **DEFERRED TO POLICY EXTENSION**，未半实现）。

## 7. Pairing
Super Admin 发短时凭据 → 验 Service Identity → 提交凭据+设备公身份 → **原子消费** → 建 Registry → 发凭据 → ACTIVE。

## 8. Pairing race / replay
race：store 原语 changes 1→0，以及**两个真实连接**并发（`Promise.all`）→ 恰好一台设备；
replay：`PAIRING_TOKEN_ALREADY_USED`，同 IP/hostname 无效。到期边界 before/at/after 三点冻结为 `now >= expiresAt` 失效。

## 9. Service identity
`serviceIdentitySeen` 必须与配置完全一致，否则 `SERVICE_IDENTITY_MISMATCH`；
未配置则任何配对被拒（fail closed）；**未采用 TOFU**。

## 10. TLS / mTLS
真实 `tls.createServer({requestCert:true, rejectUnauthorized:true, minVersion:TLSv1.2})`；
无明文监听（静态扫描 0 命中）；`127.0.0.1` 同样过 mTLS。**12/12 场景 PASS**（见 §28）。

## 11. Device authorization
两层：`authenticateConnection`（凭据）+ `authorizeDevice`（组织→状态→访问→动作）；
revoked/disabled 场景第一层 ALLOW、第二层 DENY。

## 12. Revocation
撤销即撤全部凭据 + 关闭已建立连接 + connectivity=OFFLINE；下一次认证与授权都 DENY，**不等证书过期**。

## 13. Disable / Enable
可恢复；reason 与 REVOKED 不同；disable 期间重连仍 DENY 且不产生第二台设备。

## 14. Credential rotation
版本单调 +1、旧凭据 ROTATED 立即失效、新凭据 ACTIVE；篡改旧凭据为 ACTIVE 仍 STALE；轮换关闭旧连接。

## 15. Private key boundary
仓库无私钥落库路径；`device_credentials` 只存 subject/fingerprint；审计字段黑名单物理阻断 privateKey/pem/secret/token。

## 16. Heartbeat
只接受与 TLS 身份一致的 deviceId；**每次重读 Registry**；只更新 lastSeen/connectivity/agentVersion，不改 status。

## 17. Offline / reconnect
超阈值只标 OFFLINE；重连沿用同一 deviceId + 凭据。

## 18. Impersonation protection
deviceId 不符 → `DEVICE_IDENTITY_MISMATCH`；指纹与库不符 → `DEVICE_CREDENTIAL_MISMATCH`；未注册 → `DEVICE_CREDENTIAL_UNKNOWN`。

## 19. Resource location contract
`resolveResourceLocation` 返回 `{deviceId, availability, status, connectivity, checkedAt}`；**不读写资源表**。

## 20. Resource + Device intersection
`authorizeExecution` 组合 D3-02 授权与 D3-03 设备门，返回 `side`；三方向 + 中途撤销均验证。

## 21. Agent / Device authorization
Agent 只能用当前 User 的 `device.use`；撤掉后下一请求 DENY；Agent/普通用户不能自授设备权限。

## 22. Audit
`device_audit` 覆盖 §46 全部事件；pairing secret 明文**数据库文件与 WAL 全库 0 命中**。

## 23. Migration
v2→v3 追加式、逐级事务；既有身份+授权数据保留；v2 级与 v3 级失败**各自整级回滚**；幂等；高版本拒绝打开。

## 24. Renderer boundary
`device:command` 白名单；sessionRef 由主进程注入；返回恒为 publicDevice；安全探针暴露面 **5 → 6 已显式登记**。

## 25. UI
设置窗口「设备」pane：列表（ACTIVE/DISABLED/REVOKED/OFFLINE/PENDING 分开显示）、配对面板（join code 只显示一次 + 到期 + 单次状态）、撤销/禁用/启用/重命名、只读审计；错误都有可见 reasonCode。
**真实 Electron 探针 32/32**。

## 26. macOS
TLS / Registry / Pairing / Authorization / Revocation / Rotation / Migration / Audit / UI 全部真实执行 = **PASS**。

## 27. Windows
Named Pipe ACL / DPAPI / 证书存储 / 设备运行时 = **NOT VERIFIED**（无真机，不外推）。

## 28. Tests
```
npm test                                  262/262
npm run build                             PASS
npm run test:d3-03                        TLS 矩阵 12/12，exit 0
node --test tests/device-tls.test.mjs      12/12
node tests/device-ui.mjs                   32/32（+2 NOT VERIFIED）
npm run test:d3-01                         12 探针 PASS 12 / FAIL 0
npm run test:d3-02                         PASS 5 / FAIL 0（06-migration 已更新到 v3）
npm run test:authorization-ui              14/14
npm run test:identity-ui                   24/24
npm run test:security                      FAIL 0 / PARTIAL 3 / PASS 6（= 基线）
npm run test:design-system                 PASS 4 / PARTIAL 1 / FAIL 0
npm run test:theme-baseline                全部通过
```

## 29. Files changed
新增：`electron/device-domain.cjs`、`device-store.cjs`、`device-service.cjs`、`device-bootstrap.cjs`、
`experiments/d3-03/{tls-control-service,run-tls-matrix,run-all}.mjs`、`tests/device-*.test.mjs`（14 个）、
`tests/device-fixtures.mjs`、`tests/device-ui.mjs`、`src/device/DevicePane.tsx`、`src/settings/`、
`docs/decisions/D3-03-device-identity.md`。
修改：`electron/identity-store.cjs`（v3）、`identity-bootstrap.cjs`、`main.cjs`、`preload.cjs`、
`experiments/d2-02/native/probes/02-security-surface.cjs`（5→6）、`tests/migration.test.mjs`、
`experiments/d3-02/06-migration-race-session.mjs`、`src/main.tsx`、`src/styles.css`、`PROGRESS.md`、`package.json`。

## 30. Commits
`62f4b2b` registry+identity / `003a256` tests / `25db5df` mTLS / `2a22f76` intersection /
`53d45ab` docs / `6a4d2bc` UI。全部已推 origin。

## 31. Evidence
见 §28 各入口的真实统计；TLS 矩阵逐场景输出见 ADR §34。

## 32. Remaining gaps
Windows 全部；Device Agent 生产凭据存储；X.509 CRL/OCSP；多级链/IPv6/wildcard；
TLS1.3 下拿不到精确错误文案；明文回退只有静态+配置级证明；部门设备管理 DEFERRED；
Resource Library 仍 PLANNED；notBefore 未来分支未单测。

## 33. D3-04 admission recommendation
**CONDITIONAL GO**：D3-03 已提供 D3-04 需要的 `deviceId` / Registry / 设备授权 /
`ResourceLocation.deviceId` / Online-Offline / Revoked-Disabled / 安全 metadata / 跨设备边界；
条件 = 仅 macOS，Windows 相关项与 Device Agent 凭据存储需在 D6 前补齐。
**不自动进入 D3-04 / D4 / D5。**
