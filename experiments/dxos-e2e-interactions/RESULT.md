# 任务 C · 新交互真机端到端验收结果（dxos-e2e-interactions）

> 探针：`experiments/dxos-e2e-interactions/run-all.mjs`（真实 `electron .` + 隔离 userData + 唯一 CDP/inspector 端口）。
> 证据：`artifacts/dxos-e2e-interactions/report.json` + 8 张浅/深截图。
> 真机运行命令：`node experiments/dxos-e2e-interactions/run-all.mjs`（退出码 1；**不是**探针自身故障，见下 3 条真实发现）。

## 汇总

```
PASS 68 / FAIL 3（共 71 条断言）
console error 0 / pageerror 0 / 非本地请求 0
隔离 userData ≠ 真实 profile；真实 profile 开工/收工 sha256+size+mtime 快照一致（本次 changed=[]）
```

## 通过项（每项真实 Electron 窗口内）

- ① MCP 工具调用开关：读当前状态=false → 点击打开 → `data-mcp-toolswitch-enabled=true` → 真实落盘 `<userData>/dxos/mcp.json` 的 `tools.invocationEnabled=true` + `updatedAt` 数值 → 点击关闭 → 落盘恢复 `false`。
- ② 访达「资源库」：未选中禁用且 title=「先选择要处理的文件或文件夹」→ 选中真实文件后入口 enabled → 菜单 5 项齐备（导出资源在未入库时禁用并给原因）→「加入资源库（Managed）」成功 → `resource/query` 查到 `resource://res_...`（storageMode=MANAGED）→「导出到电脑」真实落盘 1 个文件且内容逐字一致。
- ③ core 任务：产品桥建 core 任务 → 任务控制台出现 core 行 → 选中详情按后端 `task/get` → 空目标时「追加步骤」禁用并给原因、终态任务「取消」禁用并给原因 → 二次确认后追加 → 后端步骤 1→2、界面步骤数一致。
- ④ 定义即授权：启领星 → 建到 127.0.0.1 stub 的真实 MCP 连接（握手 READY，stub 收到 initialize/notifications/initialized/tools/list）→ 建含集成动作的自动化并启用 → `authorization_audit` 落 `automation.authorize`(allow) 与 `automation.execute`(allow, definitionId+runId) → 停用后 `runNow` 返回 `AUTOMATION_FORBIDDEN/DEFINITION_DISABLED` 且 stub 0 次外发。

## 未通过项（3 条真实发现，非探针故障）

### 1) `1-MCP M1.1` MCP 中心**空连接态**下「工具调用」开关不可达

- 真实输出：`{"center":true,"available":"true","empty":true,"toolswitch":false}`
- 根因（只读源码）：`src/mcp/McpCenter.tsx:1060-1085` 在「没有连接」时提前 `return`，而 `McpToolSwitch` 只在 `1095-1135` 的非空分支渲染。
- 影响：零连接的新用户根本看不到本轮新增的全局开关；建一条连接后才出现（M1.1b 通过）。

### 2) `4-自动化 A4.6` 自动化集成动作**到不了真实 MCP 连接**（0 次 tools/call）

- 真实输出：`{"run":{"ok":false,"error":"AUTOMATION_INTERNAL","message":"no-live-connection"},"stubCalls":[],"stubMethods":{"initialize":2,"notifications/initialized":2,"tools/list":2}}`
- 根因（只读源码）：`electron/integration-lingxing-local-data.cjs:231` 把固定字符串 `"lingxing"` 当 serverId 传给 transport；`electron/mcp-live-transport.cjs:46-55` 用 `mcpService.live.get(serverId)` 取连接，而 `live` 的键是随机 `connectionId`（`electron/mcp-service.cjs:612`、`mcp-store.cjs:62`）。所以即使定义授权、插件、总开关、真实连接全都就绪，`tools/call` 也发不出去（本机 stub 只收到 connect 阶段的 initialize/tools/list）。
- 与 `Dx-FINAL-RESULT` §4.8「领星/紫鸟同步的 mcpCallDirect/transportFactory 注入仍不可达」一致，本次是**端到端实测复现**。

### 3) `1b-MCP失败 N1.4` 非管理员 MEMBER 也能写全局 MCP 开关

- 真实输出：`{"memberWrite":{"ok":true,"enabled":false,"persisted":true,"audited":true},"fileUnchanged":false}`
- 说明：`mcp-center` App 的 `mcp.manage` 授权对内置 MEMBER 角色也成立（`electron/mcp-service.cjs:63-85` 按 App grant 判定），因此风险标注为 `mcp.manage` 的全局开关对普通成员实为可写。是否收紧属产品/权限策略判断。

## 失败路径覆盖（MCP 开关）

- `N1.1` 非法载荷 → `MCP_INVALID_INPUT`，文件逐字不变。
- `N1.2` `dxos` 目录只读 → 界面 `data-mcp-toolswitch-error-code=MCP_SWITCH_UNAVAILABLE`、不乐观切换、文件逐字不变。

## 隔离与边界

- 全程只以 `--user-data-dir=<mkdtemp>` 启动，argv 不含真实 profile 路径；收工删除隔离目录、无残留进程。
- 真实 profile 只做 stat+sha256 快照；本次快照一致。此前几轮观测到用户自己的 `OpenArc OS.app`（pid 81259/88861 等）在写真实库 `identity.db-wal/-shm`，探针期间该 App 重启过一次，写入者始终是它，不是探针。
- 「导出到电脑」的系统原生目录选择器无法离线点击：探针用主进程 Node inspector（`--inspect`）把 `dialog.showOpenDialog` 临时换成探针临时目录；`files:export` 的落盘逻辑一字未改（`electron/main.cjs:1276-1310`）。
- 本轮 ④ 无自动化界面（`src` 内 0 处 automation UI），故该项证据为桥命令返回 + 隔离库 `authorization_audit` 行 + stub 计数 + MCP 中心截图（开关已打开的前置态）。

## 复跑

```bash
node experiments/dxos-e2e-interactions/run-all.mjs   # 退出码 1 = 上述 3 条真实发现
```

探针全程离线（只连 127.0.0.1 CDP/inspector/两个本机 stub），不新增依赖、不改产品代码、不跑 npm build/test。
