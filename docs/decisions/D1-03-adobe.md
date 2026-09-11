# D1-03 Adobe Integration Evaluation

日期：2026-09-11
分支：`feature/d1-03-adobe`

本轮只验证两件事：OpenArc OS 能否以**安全、稳定、可授权、可验证、可替换**的方式控制
**Adobe Illustrator** 与 **Adobe Photoshop**。两个应用**独立验证**。

判定口径：只接受 **Adobe 官方文档 / Adobe 应用实际安装物 / 真实 MCP 握手 / 真实运行结果**。
第三方文章只能用于发现线索，**不能作为 PASS 证据**。

---

## Environment

| 项 | 值 |
| --- | --- |
| 机器 | macOS（darwin / arm64） |
| Adobe Illustrator | **2026 稳定版 v30.0.0**（`CFBundleShortVersionString` 实测），PID 23509，**运行中** |
| Adobe Photoshop | **2026 稳定版 v27.1.0**（实测），PID 9157，**运行中** |
| Adobe UXP Developer Tools | 已安装 |
| Adobe Creative Cloud | 已安装 |
| **Adobe Illustrator Beta** | **未安装**（`/Applications` 下只有 `Adobe Illustrator 2026`） |
| 既有文档 | 两应用均在运行，视为**有用户在制品**；本轮未创建/打开/修改任何用户文档 |

**本轮未启动、未驱动任何 Adobe 应用。** 所有本机结论均来自静态安装物取证与运行状态观测，
不做任何会触碰用户文档的动作。

---

## Illustrator

### Product/version

Adobe Illustrator 2026 稳定版，**v30.0.0**。
官方 MCP 文档要求的载体是 **Illustrator (Beta)**，本机**没有 Beta**。

### Official interface

**存在官方 MCP，但绑定 Beta 版。** 官方证据（helpx.adobe.com）：

> `Illustrator (Beta) includes a built-in MCP server that allows you to connect desktop AI tools
> to Illustrator (Beta) and perform supported tasks directly from those tools.`
> — About using desktop AI tools with Adobe Illustrator (Beta)

> `You can work with 40 Illustrator tools and actions through this integration.`
> `Once connected, the authentication key remains valid until you regenerate it,
> which requires setting up a new connection.`

入口：Application Bar → **MCP & Tools**；或 Illustrator (Beta) > Settings (macOS) / Edit > Preferences (Windows)。

### Transport

HTTP。官方文档给出的命令形态：

```
claude mcp add --transport http \
  --header "Authorization: Bearer <REDACTED>" \
  --scope user illustrator http://localhost:<port>/v1/mcp
```

说明：
- `--transport http` —— 不是 stdio。
- 端点形如 `http://localhost:<port>/v1/mcp`（文档示例端口 18412，**实际端口以应用 MCP & Tools 面板显示为准**）。

### Authentication

`Authorization: Bearer <key>`，key 形如 `ilst_<hex>`（**本机未取得，值一律 REDACTED**）。
生命周期：官方原文"连接后密钥保持有效，直到你重新生成它，而重新生成需要建立新连接"。
即：**长期有效、无过期、只能靠手动轮换撤销**。

### Tool discovery

官方口径 40 个工具/动作，通过 MCP 标准 `tools/list` 暴露。
**本机未取得 `tools/list` 实际结果**（无 Beta，无服务在跑）。

### Tool execution

**BLOCKED — 未执行。** 本机证据链：

| 检查 | 方法 | 结果 |
| --- | --- | --- |
| 主二进制含 `v1/mcp` | `strings` 全文检索 | **0 命中** |
| 主二进制含 `MCP & Tools` | `strings` | **0 命中** |
| 主二进制含 `model context protocol` | `strings` | **0 命中** |
| 运行中进程是否监听 TCP | `lsof -nP -iTCP -sTCP:LISTEN` | **Illustrator(23509) 无任何监听端口** |

（`strings` 中出现的 `ilst_` 全部来自构建路径 `ilst_rel_30`，是**假阳性**，不是 MCP key 前缀。）

**结论：Illustrator 30.0.0 稳定版不含 MCP server 实现，运行实例也没有暴露 MCP 端点。**
这与官方文档"MCP 在 Illustrator (Beta)"完全一致。

### Artifact verification

**NOT VERIFIED** — 未做任何真实操作，未创建 `D1-03-illustrator-test.ai`。

### Failure behavior

**NOT VERIFIED**。原因：没有可连接的 MCP 端点，无法做错误 token / 无 token / 应用未运行 /
无 active document / 非法参数 / 不存在工具 / 重复请求 / 断连重连等测试。
这些项**只有在安装 Illustrator Beta 并取得真实 key 之后**才能补。

### Security

- MCP 端点为 **localhost HTTP + Bearer**。若端口被本机其他进程探测到即可被驱动
  （官方未描述额外鉴权或来源校验）。OpenArc 侧必须由自己的权限代理持 key，不下发给 Agent。
- **key 生命周期风险**：长期有效、只能手动轮换 → OpenArc 必须把 key 存进自己的凭据库并支持轮换。
- 官方未说明并发/取消语义 → 见 Failure behavior。

### Platform requirements

官方流程同时覆盖 macOS（Settings）与 Windows（Preferences），**两平台均有官方入口**。
Windows 侧未实测（无 Windows 主机，与 D1-01 同一缺口）。

### Result

**BLOCKED**

阻塞原因：官方 Illustrator MCP 仅在 **Illustrator (Beta)** 提供；本机只有稳定版 30.0.0，
且已用二进制检索 + 端口监听双重证据确认其**不含 MCP 实现、未暴露 MCP 端点**。
解除阻塞的唯一条件是安装 Illustrator Beta（需用户操作 Creative Cloud）。

---

## Photoshop

### Product/version

Adobe Photoshop 2026 稳定版，**v27.1.0**。官方 What's New 显示当前最新为 27.10（2026-08）——
本机版本落后，且**该系列 What's New 从未提及 MCP server**。

### Official interfaces found

| 接口 | 是否官方 | 是否控制本机原生应用 | 证据 |
| --- | --- | --- | --- |
| **Photoshop Desktop 官方 MCP** | — | — | **NOT FOUND IN OFFICIAL SOURCES** |
| Photoshop API v2 | 是 | **否（云端）** | `developer.adobe.com/firefly-services/docs/photoshop/` |
| Adobe connectors（ChatGPT / Claude） | 是 | **否（云服务）** | `helpx.adobe.com/.../adobe-connector-overview.html` |
| **UXP Plugin API** | 是 | **是（本地插件）** | 本机 `Required/UXP` + `dvauxphost.framework` + `dvauxpui.framework` + 二进制含 `Unified Extensibility Platform` |
| ExtendScript / legacy automation | 是（legacy） | 是 | 本机 CEP 扩展目录存在 |
| Creative Cloud connector | 是 | 否（资产/云文档） | — |

**关键否定证据（本机实测）**：

| 检查 | 结果 |
| --- | --- |
| 主二进制 `v1/mcp` / `model context protocol` | **0 命中** |
| 运行中 Photoshop(9157) 监听 TCP 端口 | **无** |

### Desktop automation options

对 6 条候选路线的实际评估：

| 路线 | 控制本机原生 PS | 需云端 | 需 Developer credential | 操作当前打开文档 | 存 PSD | 读文档状态 | undo | cancel | 结构化错误 | 可被 OpenArc 权限代理控制 | 可验证真实结果 | 跨 Win/mac | 适合商业部署 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A. 官方 Desktop MCP | — | — | — | — | — | — | — | — | — | — | — | — | **NOT FOUND** |
| B. Photoshop API v2 | **否** | **是** | **是** | **否** | 是（输出为 URL） | 是 | 未知 | 未知 | 是 | 是（代理可管） | 是（产物 URL） | 是 | 是（但能力不同） |
| C. UXP Plugin | **是** | 否 | 否（本地加载） | **是** | 是 | 是 | 是 | 部分 | 是 | **是** | **是** | 是 | 是 |
| D. 本机受控桥接（OpenArc 自研） | **是** | 否 | 否 | **是** | 是 | 是 | 是 | **取决于实现** | **取决于实现** | **是** | **是** | 需两端实现 | 是 |
| E. Adobe 官方 connector | **否** | **是** | 是（Adobe 账户） | **否** | 未知 | 未知 | 未知 | 未知 | 未知 | **否（不由 OpenArc 控制）** | 未知 | 是 | 否（不受控） |
| F. 第三方 MCP（COM/Python/CEP） | 是 | 否 | 否 | 是 | 是 | 是 | 部分 | 部分 | 部分 | 是 | 是 | **多为 Windows-only** | **否（非官方、不可作为 PASS 依据）** |

### Cloud API distinction

**必须明确区分**（对应本轮第 9 条要求）：

- **Photoshop API v2** 是 **Firefly Services 下的云端 REST 文档处理服务**。
  官方原文要求：`Image storage: A publicly accessible URL for your input image (S3, Azure, Dropbox, or any pre-signed URL)`，
  端点 `https://photoshop-api.adobe.io/v2/...`，鉴权 `Authorization: Bearer` + `x-api-key`，
  输出为带有效期的 URL。
- 它**不是**"控制用户本机正在运行的 Photoshop 原生应用"。
  **它不能打开用户当前文档、不能操作用户未保存的编辑状态、不能替代本机 GUI 会话。**
- **结论：单纯 Photoshop API v2 不足以证明 D1-03 Photoshop 通过。**

同理，**Adobe connectors**（虽构建在 MCP 之上）是 Adobe 面向 ChatGPT / Claude 的**云服务集成**，
不由 OpenArc 控制执行位置，也不指向本机原生会话，**同样不能作为本机控制的证据**。

### Authentication

- Photoshop API v2：OAuth 2.0 Server-to-Server + Client ID（Adobe Developer Console）。**云端凭据，不得下发 Agent。**
- UXP：本地插件加载，无需 Adobe 云端凭据；但开发模式加载需 UXP Developer Tools 与开发者模式。

### Tool execution

**NOT VERIFIED** — 本轮未执行任何真实 Photoshop 操作，未创建 `D1-03-photoshop-test.psd`。
UXP 路线需要先在用户运行中的 Photoshop 里加载开发插件，属于对用户应用的持久改动，
本轮**未经用户确认不做**。

### Artifact verification

**NOT VERIFIED** — 无产物。

### Failure behavior

**NOT VERIFIED** — 无真实调用，无法测试失败路径。

### Security

- UXP 路线：插件在 Photoshop 进程内运行，权限等同应用本身 → 插件必须**只暴露白名单命令**，
  不得内置"执行任意脚本"作为默认能力；所有命令经 OpenArc 权限代理裁决。
- Photoshop API v2：输入图需公网 URL → **不得把用户未公开的设计稿上传到公网存储**；
  如使用该路线，必须走私有预签名 URL 且生命周期最小化。

### Platform requirements

UXP 与 ExtendScript 均跨 Windows / macOS。Photoshop API v2 与平台无关（云端）。
Windows 侧未实测。

### Result

**NOT VERIFIED**

理由：官方 Desktop MCP 在官方来源中**未找到**；唯二官方路线中，
Photoshop API v2 是**云端能力、不等于本机控制**，UXP 是真实本机路线但
**本轮未做运行时验证**（需加载插件，未经用户确认不执行）。
候选路线 **C + D：UXP 插件 + OpenArc 本机受控桥接**。

---

## OpenArc Architecture Impact

Adobe 调用链**必须**是：

```
OpenArc Task
  ↓
OpenArc Permission
  ↓
OpenArc Tool Proxy
  ↓
Target Device Agent
  ↓
Adobe Connector / MCP / Bridge
  ↓
Adobe App
```

**严禁** `Harness → Adobe` 直通。Harness 永远不持有 Adobe 的最终执行权限，
它只能**提议**工具调用，由 OpenArc Tool Proxy 裁决并转交 Device Agent 执行。

本轮证据对架构的直接约束：

1. **Illustrator 侧如果是官方 MCP**：OpenArc 的 `illustrator/` adapter 只是一个 MCP 客户端，
   但 **key 必须由 OpenArc 凭据库持有并在建立连接时注入**，不能进 Harness 上下文。
2. **Photoshop 侧只能走 UXP + 本机桥接**：这意味着 Photoshop adapter 要自带一个
   受控插件（本地资产），与 Illustrator 的"纯 MCP 客户端"形态**不同**。
3. **两应用形态不同是可接受的**（对应本轮第 16 条）。建议未来抽象：

```
packages/adobe-adapter/
  ├── illustrator/     # 官方 MCP 客户端
  └── photoshop/       # UXP 插件 + 本机桥接
```

上层统一暴露：

```
discoverCapabilities()
execute()
cancel()
getStatus()
verifyResult()
```

**D1-03 只记录架构建议，不建设该 package。**

4. **取消能力缺口**：官方 Illustrator MCP 文档未描述取消语义；UXP/桥接路线的取消完全取决于
   自研实现。OpenArc 的 `cancel()` 必须在 adapter 层做**尽力而为 + 状态可判定**
   （即：能明确回答"调用是否发生"），否则不能宣称支持取消。

## Credential Boundary

以下均视为**独立凭据**，**禁止**进入：Harness prompt、Harness memory、Skill package、
Plugin export、日志、前端 localStorage、Git repository。

| 凭据 | 归属 | 本轮处理 |
| --- | --- | --- |
| Illustrator MCP key（`ilst_*`） | 单台设备 + 单个 Illustrator 安装 | 本机未取得；所有位置记 `REDACTED` |
| Adobe OAuth token（API v2） | Adobe Developer Console 项目 | 未取得；记 `credentialRef` |
| Adobe Developer Client ID / Secret | 开发者项目 | 未取得；记 `credentialRef` |
| UXP 插件签名/加载凭据 | 本机开发模式 | 未涉及 |

**ADR 只记录 `credentialRef` 或 `REDACTED`。** 日志脱敏规则：`Bearer ***`、`localhost:<port>`。

## Device Boundary

必须验证并记录（本轮为**架构结论 + 部分实测**）：

- **Adobe 应用在哪台电脑运行，调用就必须在哪台 Device Agent 执行。**
  实测支撑：Illustrator MCP 端点是 **`localhost`** —— 它在结构上就**不可跨机**。
  这不是设计选择，是官方实现的硬约束。
- **中心服务安装 Photoshop ≠ 可以操作成员电脑的 Photoshop。** 云端 API v2 也**不能**证明本机控制。
- **成员 A 的 Illustrator MCP key 不能被成员 B 使用**：key 由单个 Illustrator 安装生成，
  且端点在本机 loopback。跨成员使用在物理上不成立。

这三条构成 OpenArc 后续局域网设计的硬边界。

## Risks

1. **Illustrator 官方 MCP 绑定 Beta** —— 生产依赖一个 Beta 载体，Adobe 可随时变更或回收。
   且官方明示"正在快速迭代/收集反馈"，接口稳定性没有承诺。
2. **Photoshop 无官方本机 MCP** —— 只能自研 UXP + 桥接，长期维护成本与 Adobe 版本升级风险由 OpenArc 承担。
3. **key 长期有效、只能手动轮换** —— 泄露后无法自动失效。
4. **UXP 插件等同应用权限** —— 白名单必须收紧，默认不得开放任意脚本执行。
5. **两应用在运行且有用户在制品** —— 任何自动化测试必须先隔离，禁止触碰现有文档。
6. **Windows 侧全未验证**（与 D1-01、D1-02 同一缺口）。
7. **第三方 MCP 不可作为 PASS 依据** —— 已确认多个 Photoshop MCP 为社区项目，
   其中 `@alisaitteke/photoshop-mcp` 自述 "not affiliated with or endorsed by Adobe"。

## Decision

**D1-03 总状态：BLOCKED**

- **Illustrator：BLOCKED** —— 官方 MCP 仅存在于 Beta，本机无 Beta；已用二进制检索 +
  端口监听双重证据确认稳定版 30.0.0 无 MCP 实现。需安装 Illustrator Beta 后重做。
- **Photoshop：NOT VERIFIED** —— 官方 Desktop MCP **NOT FOUND IN OFFICIAL SOURCES**；
  Photoshop API v2 是云端能力、不等于本机控制；候选路线为 UXP + OpenArc 本机桥接，但无运行时证据。

**不允许**出现 "Illustrator PASS + Photoshop NOT VERIFIED → D1-03 PASS" 这类结论。
本轮两者皆无真实运行证据，总状态取 **BLOCKED**。

---

## Evidence

| 类型 | 位置 / 命令 |
| --- | --- |
| 版本实测 | `defaults read ".../Adobe Illustrator.app/Contents/Info.plist" CFBundleShortVersionString` → `30.0.0`；Photoshop → `27.1.0` |
| 运行状态 | `pgrep -l "Illustrator\|Photoshop"` → Photoshop 9157、Illustrator 23509 均在跑 |
| **MCP 实现否定证据** | `strings -a <主二进制> \| grep -c "v1/mcp"` → AI 0、PS 0；`"model context protocol"` → 0；`"MCP & Tools"` → 0 |
| **端点否定证据** | `lsof -nP -iTCP -sTCP:LISTEN \| awk '$2==9157 \|\| $2==23509'` → **无输出**（两应用均不监听） |
| UXP 存在证据 | AI：`Required/UXP`、`UxpExtension.aip`、`AIUXPExtensionHostAPI.framework`；PS：`Required/UXP`、`dvauxphost.framework`、二进制含 `Unified Extensibility Platform` |
| 官方 Illustrator MCP | `helpx.adobe.com/illustrator/desktop/connect-with-other-apps-and-tools/about-using-ai-tools-with-illustrator.html`、`.../connect-illustrator-to-ai-tools.html` |
| 官方 Photoshop API v2 | `developer.adobe.com/firefly-services/docs/photoshop/`（`photoshop-api.adobe.io/v2/...`，需公网 URL 输入） |
| 官方 Adobe connectors | `helpx.adobe.com/.../adobe-connectors/adobe-connector-overview.html`（构建于 MCP，面向 ChatGPT/Claude 的云服务） |
| 未做 | 未启动/驱动 Adobe 应用，未创建测试文档，未取得任何 key，未触碰用户文档 |
