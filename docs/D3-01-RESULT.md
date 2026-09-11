# D3-01 Result

**Task Status**

- macOS identity core：**PASS**
- overall：**PARTIAL**（Windows credential backend NOT VERIFIED，credential backend 不可从 macOS 外推）

分支 `feature/d3-01-identity-init`，基线 `88d1aa3`（`feature/d2-02-window-system`），**未 merge main**。
ADR：`docs/decisions/D3-01-identity-initialization.md`

---

## 1. Base

执行前的真实基线（全部为实测，非沿用记录）：

| 入口 | 基线结果 |
|---|---|
| `npm test` | **75 / 75 PASS** |
| `npm run build` | PASS |
| `npm run test:design-system` | PASS 4 / PARTIAL 1（`04-keyboard-a11y` 含 1 项 NOT VERIFIED）/ FAIL 0 |
| `npm run test:theme-baseline` | PASS |
| `npm run test:d2-02` | PASS 7 / 7 |
| `npm run test:security` | FAIL 0 / PARTIAL 3 / PASS 6 |

`feature/d3-01-identity-init` 从 `feature/d2-02-window-system` 的 `88d1aa3` 建立，**不从 main**。

---

## 2. Identity domains

四个独立 ID 域，各自前缀：`inst_` / `team_` / `usr_` / `ses_`，另加渲染进程持有的不透明 `sref_`。

**没有 deviceId** —— User Identity ≠ Device Identity（D1-05 / D1-06 冻结），设备注册属 D3-03。
单元测试直接断言 `!('DEVICE' in ID_PREFIX)` 且命令集中不含 device 相关项。

`sessionRef` 与 `session token` 是两次独立随机、互不可推导：token 只存在于 OS 受保护存储与主进程内存，
库里只存 `SHA-256(token)`；ref 是渲染进程的唯一句柄，换进程即失效。

---

## 3. Initialization

状态机 `UNINITIALIZED → READY`，`INITIALIZING` 只是事务内瞬时值，**永不落盘**。

**禁止 check-then-act**：检查状态 + 建 installation + 建 root team + 建 admin 全在同一个 `BEGIN IMMEDIATE` 事务内。
KDF 在事务之前算完（纯函数），把事务体压到最短。

初始管理员来源于初始化事务；以后新增成员不再走 `initialize`。

---

## 4. A01 race

> Given 全新安装 / When 两个 initialize 竞争 / Then 恰好一个管理员

**PASS**（01-init-race，14/14）。四组，逐组加严：

| 组 | 场景 | 结果 |
|---|---|---|
| A | 同一连接内两个并发调用 | 1 OK + 1 `ALREADY_INITIALIZED`；users=1 / installations=1 / rootTeams=1；不变量健康 |
| B | **两条独立 SQLite 连接**（无共享互斥） | 1 OK；两条连接读到同一个最终状态 |
| C | 事务中途崩溃（installation 已写、admin 未写） | 返回失败；三张表**全部 0 行**；状态仍 UNINITIALIZED；重试可成功 |
| D | 顺序重复调用 | `ALREADY_INITIALIZED` |

不是"顺序点两次"。

---

## 5. Persistence

**`node:sqlite`（Node 22.5+ 内置 `DatabaseSync`）**，`<userData>/identity.db`，`schema_version = 1`。

- 已在**真实 Electron 44.3.0 / Node 24.20.0** 主进程内实测可用，并跑通 initialize → login 真实事务
- 否决 `better-sqlite3`（native 构建产物，无法双端验证）；否决 JSON 文件（无事务、无约束，§28 明令不得作为可 PASS 方案）
- 事务 = 连接内互斥 + `BEGIN IMMEDIATE`；跨连接竞争由 SQLite 写锁仲裁，`SQLITE_BUSY` → 有界重试后重读状态
- 迁移框架同日落位；`will-quit` 显式 close（否则 WAL 未 checkpoint 的事务会丢）
- 权限：目录 0700

**数据库级约束**（不是靠 UI）：`installations CHECK(singleton=1)` + PK（物理上不可能第二个 installation）、
`teams` partial unique index `(root) WHERE root=1`、`users.identifier UNIQUE`、`sessions.user_id` 外键。
单元测试直接断言"硬插第二行"会被 SQLite 拒绝。

---

## 6. Password / KDF

**scrypt**（Node `node:crypto` 官方实现），参数 `N=2^15 (32768) / r=8 / p=1 / keylen=32` = 32MB，单次派生实测 ~46ms。

- Argon2id 是首选但无 Node 官方实现，只能引 native 依赖，与 D1-06「不引无法双端验证的 native 依赖」冲突 → 本轮不选，保留为 `algo` 第二取值
- verifier 自描述：`scrypt$<version>$N$r$p$keylen$<saltB64url>$<hashB64url>` → 参数可升级，校验成功后透明重哈希
- 不存明文、不自创 hash；salt 每次 16 字节新鲜随机
- 标识符不存在时**照样跑满一次 KDF**，消除"账号是否存在"的时间侧信道（实测两条失败路径耗时比 < 3）

---

## 7. Session model

`sessionId · userId · createdAt · lastSeenAt · expiresAt · idleExpiresAt · revokedAt · revokedReason · lockedAt · reauthAt · authVersion`。
支持 create / validate / revoke / expire。**不是** `localStorage.loggedIn`。

默认绝对上限 12h（不因活动延长）+ 空闲上限 2h（活跃时滑动）。冻结的判定顺序决定错误码：
revoke → 绝对过期 → 空闲过期 → **用户禁用** → authVersion 不匹配。

---

## 8. Login

统一 `INVALID_CREDENTIALS`（标识符不存在与口令错误同码、同耗时）。
禁用用户：**错口令 → INVALID_CREDENTIALS，对口令 → USER_DISABLED**（顺序不能反，否则成为账号枚举接口）。
限流：指数退避 + 上限 60s + 成功清零 + 窗口内自动衰减，**永不永久封锁**（"失败 5 次永久锁"是 DoS 设计）。

---

## 9. Logout

真实写 `revoked_at` + `revoked_reason=LOGOUT`，随后清 OS 受保护存储（顺序：先撤销再清存储）。
登出后 `validate(A)` / 受保护命令 / `restore(A 的 token)` 全部 DENY —— **仅 UI 返回登录页不算完成**。

---

## 10. Lock / Unlock

**LOCK ≠ LOGOUT**，两条命令两个语义。锁定后 session 仍有效、身份仍可识别（非敏感校验通过），
但受保护命令返回 `LOCKED`；`sessions.locked_at` 落库，锁定期间重启仍保持锁定。

锁屏三层：DOM 覆盖 + `inert`、原生视图让位（`useDesktop({ locked })` → `overlayOpen`，因为 **DOM z-index 对 WebContentsView 无效**）、状态层落库。

Unlock 必须重新验证口令，成功后**轮换 ref 与 token**，沿用同一 session；已 revoked 的 session 不会被偷偷恢复。
不 destroy Browser session。

---

## 11. Disable

`ACTIVE` / `DISABLED`。禁用后已有 session **立即**失效（`USER_DISABLED`），不能新登录，
OS 受保护存储里的 token 一并清除（重启不能绕过）。

**禁用不删 session 行**（冻结）：保住 `USER_DISABLED` 语义，不退化成 `SESSION_REVOKED` —— UI 会把后者当成"请重新登录"，
而真实含义是"账号被停用了，重新登录也没用"。D4 需要这个区分（§19）。本轮不做 admin UI，由夹具命令驱动。

---

## 12. Password change

**冻结：authVersion++ 且撤销全部 session（含当前）**。旧口令 DENY、新口令 PASS、旧 session 全部失效（07 探针 13/13）。
先验证旧口令；新口令走同一套长度校验。

---

## 13. Expiry

可控时钟，口径冻结 `now >= expires_at` 即过期。覆盖：到期前 1ms 有效 / 正好到期过期 / 到期后过期 /
空闲滑动 / 锁定态不滑动 / 重启恢复同样受约束（08 探针 10/10）。

---

## 14. Renderer boundary

渲染进程只持有 `sessionRef` 与 display-safe 快照。**拿不到** password / hash / salt / KDF 参数 / raw token / token_hash / 全量 session store。

`localStorage` **零身份字段**（UI 探针实测 `Object.keys(localStorage)` 不含 identity/session/token/user/auth）。
单一权威 = `electron/identity-service.cjs`，UI 与未来 AI 走同一条命令层；渲染进程里根本没有 `loggedIn` 这个变量。

9 条身份命令 + 3 条 admin 夹具（产品默认关闭）；5 个身份事件由 Window / TopBar / LockScreen 共同消费。

**UI 探针抓出的真实缺陷**：命令失败时 phase 一律回落到调用方 fallback，而 `unlock` 的 fallback 是 `ready`
⇒ 解锁输错口令会回到桌面，**等于口令错误也能解锁**。已修正为"失败只允许降级或保持，绝不升级"，并补了断言。

---

## 15. Credential boundary

口令 verifier ≠ credentialRef。`users` 表只有 `password_*` 五个口令 verifier 列，**没有任何** API key / OAuth token 列；
Model API Key / Adobe Key / OAuth Token 继续走 D1-05 的 Credential Store → credentialRef。

session token 走 **Electron `safeStorage`**（macOS Keychain / Windows DPAPI / Linux libsecret）：
密文落 0600 文件，明文从不过桥。否决 `/usr/bin/security`（密钥进 argv，同 uid 进程 `ps` 可读）。
`safeStorage` 不可用时降级明文 0600，并**显式写审计条 `DOWNGRADED`**，不静默降级。

---

## 16. UI

`SetupScreen` / `LoginScreen` / `LockScreen` 三个真实界面，全部消费领域命令，按钮不切页面。
`checking` 阶段只画启动态 ⇒ 不存在"先显示桌面、几百毫秒后闪回登录"（UI 探针在重启过程中采样 2 秒，闪现 0 次）。

无主进程时（浏览器 / 视觉回归环境）门禁不参与，桌面照常渲染 —— 真实产品 preload 恒在，这不是后门，
而是让既有 D2 视觉/窗口回归能在无主进程环境继续运行的必要条件。

---

## 17. Concurrency

机制：连接内互斥 + `BEGIN IMMEDIATE` + SQLite 写锁 + BUSY 有界重试。
8 个并发 login（ref 唯一、行数一致）、logout×validate、disable×validate、改密×validate（authVersion 恰好 +1）、
混合风暴 —— 最终状态一致、域不变量健康、每条撤销都有原因（11 探针 17/17）。

---

## 18. Logging

字段白名单（构造新对象，不是删敏感 key）+ 已登记 secret 打码。
允许：event / userId / sessionRefHash / result / errorCode / durationMs。
探针用假口令登记后扫描：审计记录、数据库 `audit_log`、**跨探针已落盘产物**均不命中（10 探针 11/11）。

---

## 19. Security

- IPC 与 `windows:sync` 同一条 `trusted(event)` 判据；异常一律收敛为 `INTERNAL_ERROR`（文本可能夹带路径/SQL/参数值）
- preload 暴露面 5 → 6（`identity`），**已在 D2-02 的冻结清单里显式登记**并更新通道扫描范围（含 identity-bootstrap.cjs）
- Keychain 探针红线（§35）：只用假 secret、只用临时目录、不 rename 真实 login keychain、不改 default keychain、不改 global search list、收尾删除
- 时间侧信道、账号枚举、重启绕过禁用、token 落 localStorage —— 均有对应断言

---

## 20. macOS

**已实测**（真实 Electron 44.3.0 / Node 24.20.0 / darwin arm64）：

- `node:sqlite` 主进程可用，initialize → login 真实事务跑通
- `safeStorage` 可用，后端 = Keychain；写入/读回一致；磁盘不含明文；权限 0600；clear 后不可恢复
- UI E2E `tests/identity-ui.mjs` **24 / 24 通过**

---

## 21. Windows

**NOT VERIFIED。** 身份领域逻辑跨平台可测（纯 Node，无平台分支）；
但 DPAPI 行为、safeStorage 在 Windows 的可用性、Windows UI 表现必须真机逐项实测，
credential backend **不可从 macOS 外推**（D1-05 同口径）。

---

## 22. Tests

| 入口 | 结果 |
|---|---|
| `npm test` | **96 / 96**（基线 75 + 新增 21：`identity-domain` / `identity-store`） |
| `npm run test:d3-01` | **12 探针 PASS 12 / PARTIAL 0 / FAIL 0**（共 154 条用例） |
| `npm run test:identity-ui` | **24 / 24**（真实 Electron，非 Playwright） |
| `npm run test:d2-02` | **PASS 7 / 7**（security-surface 15/15） |
| `npm run test:design-system` | PASS 4 / PARTIAL 1 / FAIL 0（与基线一致） |
| `npm run test:theme-baseline` | PASS（与基线一致） |
| `npm run test:security` | FAIL 0 / PARTIAL 3 / PASS 6（与基线一致） |

产物：`artifacts/d3-01/*.json`（12 份，跑前先删，不读上一轮）。

UI E2E 说明：Playwright 1.55 与 Electron 内置 Chromium 的 CDP 握手超时（`_electron.launch` / `connectOverCDP` 均失败），
因此改用**主进程自持窗口 + `webContents.executeJavaScript`** 驱动（§48 允许的替代路径）。
这不是"假装 PASS"——它跑的是真实 Electron、真实 preload、真实 dist。

---

## 23. Files changed

**新增**

```
electron/identity-domain.cjs        纯领域模型（ID 域 / 错误码 / 快照 / session 判定 / 限流）
electron/password.cjs               scrypt KDF 与自描述 verifier
electron/identity-store.cjs         SQLite 持久层（事务 / 约束 / 迁移 / 不变量）
electron/identity-service.cjs       身份服务（唯一权威 / 命令层 / 补偿）
electron/session-secret-store.cjs   session token 的 OS 受保护存储（safeStorage 兜底 0600）
electron/identity-log.cjs           审计日志（字段白名单 + secret 打码）
electron/identity-bootstrap.cjs     装配与 IPC 注册（产品与 UI 探针共用同一条线）
src/identity/types.ts               渲染侧类型与错误文案
src/identity/useIdentity.ts         渲染侧钩子（只有快照 + 命令）
src/identity/AuthScreens.tsx        Setup / Login / Lock 三个界面
tests/identity-domain.test.mjs      领域层单测
tests/identity-store.test.mjs       持久层与命令层单测
tests/identity-ui.mjs               真实 Electron UI 验收
tests/fixtures/identity-ui-probe/   UI 探针夹具
experiments/d3-01/                  12 条探针 + lib + native 夹具 + run-all
docs/decisions/D3-01-identity-initialization.md
```

**修改**

```
electron/main.cjs                   接入身份服务（改用 identity-bootstrap 的统一装配）
electron/preload.cjs                新增 identity 桥（只有 command / onEvent）
src/main.tsx                        身份门禁 + 锁屏 + 顶栏锁定/登出
src/desktop/useDesktop.ts           接受 locked，把原生视图让位接进 overlayOpen
src/desktop/components.tsx          TopBar 增加身份投影（可选，无主进程时不渲染）
src/styles.css                      身份界面样式（全部沿用既有 token，不引入新色）
package.json                        新增 test:d3-01 / test:identity-ui
experiments/d2-02/.../02-security-surface.cjs   暴露面 5→6 显式登记 + 通道扫描扩到 bootstrap
PROGRESS.md                         D3-01 状态节
```

---

## 24. Commits

按 §53 拆成原子提交，推送至 `feature/d3-01-identity-init`，**不 merge main**。

---

## 25. Evidence

`artifacts/d3-01/`：

```
01-init-race.json            PASS 14
02-login.json                PASS 16
03-session.json              PASS 13
04-logout.json               PASS 11
05-lock-unlock.json          PASS 15
06-disable.json              PASS 12
07-password-change.json      PASS 13
08-expiry.json               PASS 10
09-identity-snapshot.json    PASS 11
10-secret-redaction.json     PASS 11
11-concurrency.json          PASS 17
12-credential-backend.json   PASS 11
```

---

## 26. Remaining gaps

1. **Windows credential backend 与 UI 未验证**（overall 保持 PARTIAL 的唯一原因）
2. 身份数据库的备份 / 迁移 / 恢复策略；`identity/reset-installation` 的用户可达路径（高风险操作，需二次确认与留痕）
3. `node:sqlite` 仍标记实验性，稳定化后需复核 API（隔离点：`electron/identity-store.cjs` 的 `openDatabase()`）
4. 身份库文件本身即身份资产（含 verifier 与 session 哈希），尚无 at-rest 加密方案
5. admin UI（成员管理 / 禁用 / 重置）
6. credential store 产品化（API Key / OAuth Token → credentialRef）
7. 限流阈值与退避参数尚未产品化调优；多因素 / 生物识别未实现
8. D2-02 视觉回归在无主进程环境运行，该路径上身份门禁未参与（已挂 `data-identity-gate` 便于识别）

---

## 27. D3-02 admission recommendation

**建议：CONDITIONAL GO**（与 D1-06 的放行结论一致，无新增 blocker）。

条件：

1. D3-02 的对象权限必须挂在**同一套领域命令层**上，不得新建第二套入口，也不得在渲染进程里加权限判断
2. 不得复用 D3-01 的身份状态冒充 ACL —— 本轮 UI 里的 `Unauthorized` 只用于身份/session 层明确拒绝（§37）
3. Windows credential backend 仍是 D3-01 的未清项，应在 D3-02 之前或同期排期真机验证，不要让它在多个阶段间滚动

D3-01 只回答「你是谁 / session 是否有效」；「你能不能访问这个对象」由 D3-02 回答。
