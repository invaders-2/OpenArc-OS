# D3-01 · Identity / Initialization / Session Lifecycle

- **状态**：macOS identity core **PASS**；overall **PARTIAL**（Windows credential backend NOT VERIFIED）
- **分支**：`feature/d3-01-identity-init`，基线 `88d1aa3`（`feature/d2-02-window-system`）
- **日期**：2026-09-11
- **范围**：只回答「你是谁 / session 是否有效」。**不进入** D3-02 对象权限、D3-03 设备注册、D3-04 文件、D3-05 身份网关、D4。

---

## Scope

冻结并实现 OpenArc 第一版身份生命周期：

Installation Identity · User Identity · Session · Initialization · Login · Logout · Lock · Unlock · Reset · Disable

**本轮不做**：完整团队管理、完整 admin UI、deviceId 注册流程（D3-03）、对象 ACL（D3-02）、任务系统（D4）。

---

## Threat Model

| 攻击者 | 能力 | 本轮防御 |
|---|---|---|
| A. 同机同 uid 进程 | 读任意同 uid 文件、连 127.0.0.1、`sysctl(KERN_PROCARGS2)` 读 argv/env（D1-05 实测） | token **不落明文**；0600 **不作为安全边界**，只作防呆；受保护存储用 OS 加密 |
| B. 离线磁盘/备份 | 有数据无登录态 | Keychain / DPAPI 密文 —— 拷走磁盘 ≠ 拷走身份 |
| C. 渲染进程脚本 | 能跑 JS、能写 localStorage | 拿不到 token / verifier / salt；localStorage **零身份字段** |
| D. 网络/远端 | 未授权入口 | 本轮无远程入口；IPC 有 `trusted(event)` 判据 |
| E. 暴力撞库 | 反复试口令 | 指数退避 + 上限 + 成功清零；**永不永久封锁** |

**明确不是安全边界的东西**（继承 D1-06 §5 口径）：JS 路径检查、文件权限、应用层参数校验。
它们负责正确性与防呆，不负责抵御恶意代码。

---

## Identity Domains

四个独立 ID 域，各自带前缀，可跨域识别：

```
inst_<24B>    InstallationId   本机安装身份，物理上唯一
team_<24B>    TeamId           workspace；root team 唯一
usr_<24B>     UserId           用户身份
ses_<24B>     SessionId        会话
sref_<24B>    sessionRef       渲染进程持有的**不透明句柄**
```

**User Identity ≠ Device Identity**（D1-05 / D1-06 冻结）：本轮**没有** deviceId，设备注册属 D3-03。

`sessionRef` 与 `session token` 是**两次独立随机、互不可推导**：

- `token`：32 字节随机，只存在于 OS 受保护存储与主进程内存；库里只有 `SHA-256(token)`
- `ref`：另一次随机的不透明句柄，是渲染进程唯一持有的东西；换进程/换启动即失效

---

## Initialization State Machine

```
UNINITIALIZED ──initializeInstallation()──> READY
                        │
                        └─(事务内) INITIALIZING  ← **永不落盘**
```

**禁止 check-then-act。** 检查状态与建 installation / root team / admin 压进**同一个 `BEGIN IMMEDIATE`**。
KDF 在事务**之前**算完（纯函数、不依赖库状态），把事务体压到最短，竞争窗口随之最小。

`INITIALIZING` 只是事务内的瞬时值：事务回滚，它连同半个用户一起消失。

---

## Initial Admin

第一个管理员**来源于初始化事务**，不是前端单独创建。以后新增成员不再走 `initialize`。

本轮只建：Installation + 一个 root Team/Workspace + 一个 ADMIN user。**不做**完整团队管理。

---

## Password / KDF

**选型：scrypt（Node `node:crypto` 官方实现）。**

| 候选 | 结论 |
|---|---|
| Argon2id | 首选（OWASP 2024 首推），但无 Node 官方实现，只能引 native 依赖（`@node-rs/argon2` / `argon2`），需 prebuilt 或本机工具链。D1-06 已冻结「不引无法双端验证的 native 依赖」 → 本轮**不选**，但保留为 `algo` 的第二取值，未来只改 `electron/password.cjs` 一处 |
| **scrypt** | **选用**。零第三方依赖、跨平台同一条代码路径、memory-hard（不是简单迭代 hash）、RFC 7914 / OWASP 均列为可接受口令 KDF |

**默认参数**：`N=2^15 (32768) / r=8 / p=1 / keylen=32` = 32MB，单次派生实测 ~46ms。

- OWASP 对交互式登录接受 `N=2^14`；取 `2^15` 在安全与"低端机并发登录不 OOM"之间取平衡
- 参数、salt、version **全部写进 verifier 自描述串**：
  `scrypt$<version>$N$r$p$keylen$<saltB64url>$<hashB64url>`
  ⇒ 未来上调参数时旧 verifier 仍可校验，校验成功后**透明重哈希**

**不存明文**，不自创 hash。salt 每次 16 字节新鲜随机。

---

## Persistence

**`node:sqlite`（Node 22.5+ 内置 `DatabaseSync`）**，文件路径 `<userData>/identity.db`。

| 项 | 结论 |
|---|---|
| 库 | `node:sqlite`。零第三方依赖、零 native 编译，macOS/Windows 同一条代码路径。**已在真实 Electron 44 主进程（Node 24.20.0）内实测可用** |
| 否决项 | `better-sqlite3`（功能更全但要 native 构建产物）；JSON 文件（**无事务、无约束**，无法满足 §5 与 §27，§28 明令不得作为可 PASS 方案） |
| 事务 | `transact()` = 连接内互斥队列 + `BEGIN IMMEDIATE` + COMMIT/ROLLBACK。跨连接竞争由 SQLite 写锁仲裁，败者 `SQLITE_BUSY` → 有界重试后重读状态 |
| 迁移 | `PRAGMA user_version`，**第一版就是 1**（§29），`migrate()` 框架同日落位 |
| 权限 | 目录 0700；WAL 模式下另有 `-wal` / `-shm` |
| 备份边界 | **不在本轮**。数据库含 verifier 与 session 哈希，整库拷贝即等于拷贝身份；恢复/迁移策略属发布前事项（见 Remaining gaps） |
| 关闭 | `app.on("will-quit")` 显式 `close()`，否则 WAL 未 checkpoint 的事务会丢 |

连接内互斥的必要性：KDF 是异步的，事务体里存在 `await`，没有互斥就会有第二个事务体插进来。

---

## Schema

`schema_version = 1`。三张主表 + 两张辅助表：

```
installations(singleton PK CHECK(singleton=1), id UNIQUE, status, created_at, initialized_at)
teams(id PK, name, root, created_at)            + UNIQUE INDEX (root) WHERE root = 1
users(id PK, installation_id FK, team_id FK, identifier UNIQUE, display_name,
      role CHECK, status CHECK, auth_version,
      password_algo, password_params, password_salt BLOB, password_hash, password_version,
      created_at, updated_at)
sessions(id PK, ref UNIQUE, user_id FK, installation_id, token_hash,
         created_at, last_seen_at, expires_at, idle_expires_at,
         revoked_at, revoked_reason, locked_at, reauth_at, auth_version)
login_attempts(id PK, identifier_hash, source, failures, first/last_failure_at, cooldown_until)
audit_log(id PK, at, event, user_ref, session_ref_hash, result, error_code, duration_ms)
```

**数据库级约束**（不是"UI 应该不会那样做"）：

1. `installations.singleton CHECK(1)` + PK ⇒ **物理上不可能有第二个 installation**
2. `teams` 上的 partial unique index `(root) WHERE root=1` ⇒ 不可能有两个 root workspace
3. `users.identifier UNIQUE` ⇒ identifier 唯一性（按归一化值）
4. `sessions.user_id REFERENCES users(id)`，外键开启

`users` 表里**没有任何** API key / OAuth token / credential 列 —— 见 Credential Boundary。

---

## Session Model

```
sessionId · userId · createdAt · lastSeenAt · expiresAt · idleExpiresAt
· revokedAt · revokedReason · lockedAt · reauthAt · authVersion
```

支持 create / validate / revoke / expire。**不是** `localStorage.loggedIn = true`。

默认：绝对上限 12h（不因活动延长），空闲上限 2h（活跃时滑动）。两条独立，可配。

**冻结的判定顺序**（决定错误码）：

```
session 缺失/revoked → SESSION_REVOKED
now >= expires_at    → SESSION_EXPIRED  （绝对）
now >= idleExpiresAt → SESSION_EXPIRED  （空闲）
user.status=DISABLED → USER_DISABLED
authVersion 不匹配   → SESSION_REVOKED
```

用户状态排在 authVersion **之前**：改密与禁用同时发生时，"账号已禁用"比"session 已失效"更能指导下一步动作。

---

## Login

```
identifier + password → 限流检查 → 查用户 → verify（不存在也跑满一次 KDF）
  → 用户禁用检查（**在口令正确之后**）→ 建 session → 写受保护存储 → 返回安全快照
```

- **外部统一 `INVALID_CREDENTIALS`**：标识符不存在与口令错误同一个码、同一量级耗时
  （不存在时照样跑一次完整 scrypt，消除时间侧信道）。实测两条路径耗时比 < 3。
- 禁用用户：**错口令 → INVALID_CREDENTIALS，对口令 → USER_DISABLED**。
  顺序不能反，否则免费提供"这个账号存在"的枚举接口。
- 内部审计日志保留 errorCode 分类，**不泄漏给调用方**。

---

## Logout

`logout` 真实写 `revoked_at` + `revoked_reason=LOGOUT`，随后清 OS 受保护存储。

顺序：先撤销（库），再清存储 —— 反过来会在两者之间留下「token 没了但 session 还活着」的窗口。

登出后 `validate(A)` / 受保护命令 / `restore(A 的 token)` 全部 DENY。**仅 UI 返回登录页不算完成。**

---

## Lock / Unlock

**冻结：`LOCK ≠ LOGOUT`**，两条命令、两个语义，不共用函数。

| | session | UI | 恢复方式 |
|---|---|---|---|
| Lock | 仍有效，身份可识别 | 桌面 DOM 保留但整块 `inert`，锁屏覆盖 | 重新验证口令 |
| Logout | 已撤销 | 回登录页 | 重新登录 |

锁屏三层保证（§15）：

1. DOM 层：`.lock-shade` 在最上层，`.desktop-surface` 加 `inert`（指针与键盘都进不去）
2. 原生层：`useDesktop({ locked })` 把 `locked` 并进 `overlayOpen` ⇒ 主进程把 WebContentsView `setVisible(false)`。
   **DOM z-index 对 WebContentsView 无效**（D1-01 事实），只能靠这一路
3. 状态层：`sessions.locked_at` 落库 ⇒ 锁定期间重启仍保持锁定

**Unlock 必须重新验证凭据**，成功后**轮换 `ref` 与 `token`**（旧 ref 立即失效、旧 token 作废），
沿用同一个 session（不新建）。已 revoked 的 session **不会被偷偷恢复**。

不 destroy Browser session —— 锁定不是销毁会话的副作用。

---

## Disable

用户状态：`ACTIVE` / `DISABLED`（本轮只有这两个）。

禁用后：

- 不能新登录
- **已有 session 的后续 validate 立即失败**（§17），错误码 `USER_DISABLED`
- 受保护命令 DENY
- UI 显示安全状态
- OS 受保护存储里的 token 一并清除 ⇒ 重启不能绕过

**禁用不删 session 行**（冻结决定）：这样校验能返回 `USER_DISABLED` 而不是 `SESSION_REVOKED`。
后者会被 UI 当成"请重新登录"，而真实含义是"账号被停用了，重新登录也没用" —— D4 需要这个区分（§19）。

代价：重新启用后、未过期的旧 session 会重新可用。这是**有意的取舍**（disable 可逆、logout 不可逆），
并已由"禁用即清 token"把重启路径堵住。备选方案（revoke-all）被否决，理由如上。

本轮**不做** admin UI，由测试夹具命令 `identity/disable-user` / `identity/enable-user` 驱动；
这两个命令在产品里默认关闭（`OPENARC_IDENTITY_ADMIN=1` 才放行）。

---

## Password Change

**冻结策略：`authVersion++` 且撤销该用户的全部 session（含当前这条）。**

理由：

- 语义最干净 —— 改密之后，除了用新口令新建的会话，没有任何旧凭据还活着
- 可测 —— §46 的"旧 session 行为"只有一个答案，不存在"这条留着那条不留"的特例
- 代价只是"改完要重新登录一次"，而这恰恰是安全上正确的行为

被否决的备选：保留当前 session、只撤其它。它会让 §46 出现两种合法期望，
且"改密后当前会话仍持有旧 auth proof"会成为一个需要额外解释的状态。

必须先验证旧口令；新口令走同一套长度校验。

---

## Reset

拆成两件事：

| 类型 | 本轮 |
|---|---|
| Password Reset / credential reset contract | **已实现**（`identity/change-password`，含全量撤销） |
| Installation Reset | **已实现但禁用 UI 入口**：必须显式传 `confirm: "DELETE-ALL-IDENTITY-DATA"`，输错一字即拒；不在任何产品 UI 暴露；审计日志**不删**（否则"谁重置了"无据可查） |

不做"一键清空数据库"。

---

## Concurrency

机制：连接内互斥 + `BEGIN IMMEDIATE` + SQLite 写锁 + `SQLITE_BUSY` 有界重试。

实测（11-concurrency，17/17）：

- 8 个并发 login → 8 条 session，ref 唯一，行数一致
- logout × validate 竞态 → 结果只可能是「有效 / SESSION_REVOKED」，收尾状态确定
- disable × validate 竞态 → 只可能是「有效 / USER_DISABLED / SESSION_REVOKED」
- 改密 × validate 竞态 → authVersion **恰好 +1**（没有因为并发被加两次）
- 混合风暴 → 域不变量健康、每条撤销都有原因

---

## Expiry

**可控时钟**测试，不真等。口径冻结：**`now >= expires_at` 即过期**（不做 `>` 的 off-by-one）。

覆盖：到期前 1ms（有效）／正好到期（过期）／到期后（过期）／空闲上限滑动／锁定态不滑动／重启恢复同样受约束。

---

## Renderer Boundary

**Renderer 不是认证权威。** 它只能：

- 持有 `sessionRef`（不透明句柄）与 display-safe 快照
- 派发领域命令

它**拿不到**：password、password hash、salt、KDF 参数、raw token、token_hash、全量 session store。

`localStorage` 里**零身份字段**（UI 探针实测：`Object.keys(localStorage)` 不含 identity/session/token/user/auth）。
重启恢复只走 `identity/restore`，由主进程从 OS 受保护存储取 token。

**单一 Identity Store / Service**（§25）：`electron/identity-service.cjs` 是唯一权威，
UI 与未来的 AI 走同一条命令层 —— 渲染进程里根本没有可改的身份 state，
`loggedIn` 这个变量不存在。

命令层（9 条身份命令 + 3 条 admin 夹具）：

```
identity/status   identity/initialize   identity/login    identity/restore
identity/logout   identity/lock         identity/unlock   identity/change-password
identity/validate
── admin / 测试夹具（产品默认关闭）──
identity/disable-user   identity/enable-user   identity/reset-installation
```

身份事件：`identity/session-changed` / `locked` / `unlocked` / `logged-out` / `initialized`。
Window / TopBar / LockScreen 消费同一份状态，**禁止任何组件自己去读 localStorage 里的 user**（§24）。

### 渲染层的一条硬规则（UI 探针抓出来的真实缺陷）

命令失败时，**phase 只允许降级或保持，绝不允许升级**。
早先失败一律落到调用方给的 fallback，而 `unlock` 的 fallback 是 `ready`
⇒ **解锁输错口令会把界面送回桌面，等于口令错误也能解锁**。
现修正为：只有 `NOT_INITIALIZED` / `LOCKED` / `SESSION_*` / `USER_DISABLED` 才允许迁移 phase，
其余错误（含 `INVALID_CREDENTIALS`）保持当前状态。

---

## Credential Boundary

**口令 verifier ≠ credentialRef。**

- **User password verifier**：存在 `users.password_hash`，格式自描述，**不是** credentialRef
- **Model API Key / Adobe Key / OAuth Token**：**继续走 D1-05 的 Credential Store → credentialRef**。
  本轮不实现 credential store 产品化（属后续），但边界已冻结：`users` 表里没有也不该有任何 API secret 列

`users` 表实际列（探针可查）：`password_algo / password_params / password_salt / password_hash / password_version`
—— 全是**口令** verifier，没有任何第三方凭据字段。

### Session token 存储（§11）

**冻结：Electron `safeStorage`**（macOS = Keychain，Windows = DPAPI，Linux = libsecret）。

- 密文写 `<userData>/session-secret.v1`，权限 0600
- 明文**从不**过桥到渲染进程，**从不**进 localStorage
- `safeStorage` 不可用时降级明文 0600 文件，并**显式写审计条 `DOWNGRADED`** —— 不静默降级
- 否决 `/usr/bin/security`：其 `-w/-p/-X` 把密钥放进 argv，同 uid 进程 `ps` 即可读（D1-05 已否决）

---

## Logging

继承 D1-05：**字段白名单** + **secret redaction**。

允许：`event` · `userId` · `sessionRefHash`（sha256 前 16 hex）· `result` · `errorCode` · `durationMs`
禁止：password、password hash、salt、raw session token、Authorization、完整环境变量、标识符明文（只记哈希）

实现方式是**构造新对象**而不是"删掉敏感 key" —— 后者每加一个字段就可能漏删一次。

探针用假口令登记后做落盘扫描：审计记录、数据库 `audit_log`、以及**跨探针的已落盘产物**均不含假口令（10-secret-redaction 10/10）。

---

## UI

三个真实界面，全部消费领域命令：

- **First-run Initialization**（`SetupScreen`）：未初始化时只能进这里；成功后**不自动登录**（让"初始口令是否可用"被真实验证一次）；刷新/回退也回不到可提交的空表单
- **Login**（`LoginScreen`）：错误只认 code，不解析文本
- **Lock Screen**（`LockScreen`）：覆盖层，桌面 DOM 保留（窗口状态不丢）

状态机接 D2-01 已冻结的 Loading / Error / Unavailable / Unauthorized 契约：
`checking` 阶段只画启动态，**不画任何桌面内容** ⇒ 不存在"先显示桌面、几百毫秒后闪回登录"（§39）。

`unavailable`（无主进程，浏览器 / 视觉回归环境）时门禁不参与，桌面照常渲染 —— 真实产品里 preload 恒在，
因此它不是可绕过的后门，而是让既有 D2 视觉/窗口回归能在无主进程环境继续运行的必要条件。

---

## A01

> **Given** 全新安装
> **When** 两个 initialize 请求竞争提交
> **Then** 恰好一个管理员存在

**结论：PASS**（01-init-race，14/14）

四组，逐组加严：

| 组 | 场景 | 结果 |
|---|---|---|
| A | 同一连接内两个并发调用（KDF 异步、事务体可能交错） | 1 OK + 1 ALREADY_INITIALIZED；users=1、installations=1、rootTeams=1 |
| B | **两条独立 SQLite 连接**（无共享互斥，模拟两个进程） | 1 OK；两条连接读到同一个最终状态 |
| C | 事务中途崩溃（installation 已写、admin 未写） | 返回失败，三张表**全部 0 行**；状态仍 UNINITIALIZED；重试可成功 |
| D | 顺序重复调用 | ALREADY_INITIALIZED |

不是"顺序点两次"。

---

## Failure Scenarios

| 场景 | 行为 |
|---|---|
| 初始化事务中崩溃 | ROLLBACK，不留半个 installation / 无 team 的 admin（C 组实测） |
| 写 OS 受保护存储失败 | **补偿**：立刻撤销刚建的 session，返回 INTERNAL_ERROR。不允许出现"库里有 session 但没人能恢复" |
| 解锁写存储失败 | 清存储 + 登出，不留下半解锁态 |
| 审计写失败 | 不影响身份操作本身（审计失败不该让登录失败），但会计入探针 |
| 数据库损坏 / 版本高于本程序 | 拒绝打开并报错，不静默迁移 |
| IPC 异常 | 一律收敛为 `INTERNAL_ERROR`（异常文本可能夹带路径 / SQL / 参数值） |

---

## macOS

**已实测（真实 Electron 44.3.0 / Node 24.20.0 / darwin arm64）**：

- `node:sqlite` 在 Electron 主进程内可用，`initialize → login` 真实事务跑通
- `safeStorage.isEncryptionAvailable()` = true，后端 = Keychain
- 写入/读回 token 往返一致；磁盘内容**不含明文**；文件权限 0600；`clear()` 后不可恢复

**安全红线（§35，继承 D1-06 Boss 决策）遵守情况**：只用假 secret、只用临时目录、
不 rename 真实 login keychain、不改 default keychain、不改 global search list、收尾删除自建条目与临时目录。

**UI E2E**：`tests/identity-ui.mjs` 在真实 Electron 中驱动 `dist/index.html` 走完
初始化 → 登录 → 重启恢复 → 锁定 → 错口令解锁被拒 → 正确解锁 → 登出 → 重启不复活，**24/24 通过**。

---

## Windows

**NOT VERIFIED。**

- 身份**领域逻辑**跨平台可测（纯 Node，无平台分支）
- **credential backend 不可外推**：DPAPI 的行为、safeStorage 在 Windows 上的可用性、
  Windows UI 表现，全部必须在真机逐项实测（D1-05 同口径："Node API 名字相同不代表隔离成立"）
- 降级路径（plainFileBackend）在 Windows 上是否会被触发，同样未知

---

## Known Limitations

1. **Windows credential backend 未验证** ⇒ overall 保持 PARTIAL
2. **单用户 / 单团队最小模型**：`users` 表支持多用户，但没有成员管理、邀请、角色继承
3. **没有 admin UI**：disable / enable / reset 只有命令，没有界面（§18 明确本轮不做）
4. **没有备份 / 迁移 / 恢复策略**：见 Remaining gaps
5. **`node:sqlite` 在 Node 22.5+ 标记为实验性**；API 若变更，`electron/identity-store.cjs` 的
   `openDatabase()` 是唯一的隔离点
6. **数据库文件本身即身份资产**：含 verifier 与 session 哈希，全盘备份会带走它；本轮无加密-at-rest 方案
7. **avatarRef / 多因素 / 生物识别**：未实现（`avatarRef` 字段先落位，恒 null）
8. **限流是进程内 + 库内计数**，不做跨设备协同；阈值与退避参数尚未产品化调优
9. **D2-02 视觉回归在无主进程环境运行**，因此那条路径上的身份门禁未参与（已标注 `data-identity-gate`）

---

## Evidence

| 入口 | 结果 |
|---|---|
| `npm test` | **96 / 96 PASS**（基线 75 + 新增 21） |
| `npm run build` | PASS |
| `npm run test:d3-01` | **12 探针：PASS 12 / PARTIAL 0 / FAIL 0** |
| `npm run test:identity-ui` | **24 / 24 UI checks PASS**（真实 Electron） |
| `npm run test:design-system` | PASS 4 / PARTIAL 1 / FAIL 0（与基线一致） |
| `npm run test:theme-baseline` | PASS（与基线一致） |
| `npm run test:d2-02` | **PASS 7 / 7**（含 security-surface 15/15；preload 暴露面 5→6 已显式登记） |
| `npm run test:security` | FAIL 0 / PARTIAL 3 / PASS 6（与基线一致） |
| 12 条探针用例合计 | **154 条** |

产物：`artifacts/d3-01/*.json`（12 份）

---

## D3-02 Handoff

D3-01 只回答「你是谁 / session 是否有效」，**不回答「你能不能访问这个对象」**。

交给 D3-02 的边界：

1. **鉴权已就绪的接缝**：任何受保护命令都应先 `identity/validate`（受保护命令走 sensitive 语义，锁定即 LOCKED）
2. **`USER_DISABLED` 已冻结并可供消费**：D4 用它表达"管理员禁用成员后，任务不再发起新调用"（§19）
3. **不要复用本轮状态冒充 ACL**：本轮 UI 里的 `Unauthorized` 只用于身份/session 层明确拒绝，不得冒充对象权限（§37）
4. **命令层是同一条**：D3-02 的对象权限应挂在**同一套领域命令层**上，不要新建第二套入口
5. **缺口**：`identity/*` 命令层目前不含 objectId / action 参数；D3-02 需要扩展命令契约，
   而不是在渲染进程里加权限判断

---

## Remaining Gaps（发布前必须回到）

1. Windows 真机验证 credential backend 与 UI
2. 身份数据库的备份 / 迁移 / 恢复策略，以及"重置安装"的用户可达路径
3. `node:sqlite` 稳定化后的 API 复核
4. admin UI（成员管理、禁用、重置）
5. credential store 产品化（Model API Key / Adobe Key / OAuth Token → credentialRef）
