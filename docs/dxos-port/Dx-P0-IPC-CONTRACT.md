# Dx-P0 · window.openarc 契约清单（实测）

> 取证方式：读 `electron/preload.cjs`、`electron/*.cjs` 里 `ipcMain.handle` 的真实注册。所有条目均为实测，未实测项标注 NOT VERIFIED。
> 基线：worktree `dxos-port/r1` @ `128e21d`；采样时间 2026-10-08。

## 1. 现有暴露面（实测）

`contextBridge.exposeInMainWorld("openarc", …)` 的顶层键共 **17** 个：

`sync` `navigate` `action` `browser` `onNativeState` `onDisplay` `identity` `authorization` `device` `resource` `governance` `model` `mcp` `canvas` `task` `sideEffect` `files`

主进程 `ipcMain.handle` 注册的命令前缀共 **13** 个域：
`authorization` `browser` `canvas` `device` `files` `governance` `identity` `mcp` `model` `resource` `sideeffect` `task` `windows`

完整 invoke 通道（实测去重）：

| 通道 | 说明 |
|---|---|
| `windows:sync` | 唯一的原生层上行通道（Window Manager 意图） |
| `browser:navigate` / `browser:action` / `browser:command` | 受控浏览器命令面 |
| `identity:command` `authorization:command` `device:command` `resource:command` `governance:command` `model:command` `mcp:command` `canvas:command` `task:command` `sideeffect:command` | 各域命令总线 |
| `files:{list,info,read,import,export,copy,move,rename,remove,thumb,trash,trashList,trashRestore,trashPurge,trashEmpty}` | 文件服务逐操作通道 |

下行事件（`ipcRenderer.on` 实测）：`native:state`、`display:changed`、`identity:event`、`sideeffect:event`、`task:event`。

## 2. 勘误（与计划 §4 注记的差异）

| 计划原文 | 实测 | 判定 |
|---|---|---|
| 「现有 17 域」 | preload 顶层键 17 个；handler 域 13 个 | 口径不同：17 = 暴露面键数，13 = 命令域数。以实测两个数字并列记录 |
| 「30 通道 / 5 下行事件」 | invoke 通道 29 条；下行事件 5 条 | 通道数差 1（`browser:action` 等拆分口径不同）。以实测为准 |
| 「新增 12 个域」 | 计划 §4 表列出的新通道名为 10 个（skill/media/comfy/automation/integration/developer/market/cloud/update/diagnostics）+ 4 个既有域扩展（model/mcp/task/canvas） | 以计划 §4 的表格为准；「12」应理解为 10 新域 + 2 处扩展通道（canvas、task 事件域）。**此处保留为待对齐项**（其中 comfy 通道已于 2026-10-14 随 B7i 移除，原因与恢复前提见 `Dx-B7-RESULT.md` §8） |

## 3. 计划新增域（§4，实施目标）

| 域 | 通道 | 形态 |
|---|---|---|
| 技能 | `skill:command` + `skill:event` | 新增 |
| 媒体 | `media:command` + `media:event` | 新增 |
| ComfyUI（2026-10-14 随 B7i 从移植范围移除，原因与恢复前提见 `Dx-B7-RESULT.md` §8） | `comfy:command` + `comfy:event` | 新增 |
| 自动化 | `automation:command` + `automation:event` | 新增 |
| 集成（可选插件，默认关） | `integration:command` | 新增 |
| 开发者 / 市场 | `developer:command`、`market:command` | 新增 |
| 云（默认关） | `cloud:command` | 新增 |
| 更新 / 诊断 | `update:command`、`diagnostics:command` | 新增 |
| 供应商 / 协议 | 扩展 `model:command` | 扩展 |
| MCP | 扩展 `mcp:command` + `mcp:event` | 扩展 |
| 任务 / AI 任务 | 扩展 `task:command` + `task:event` | 扩展 |
| 画布 | 扩展 `canvas:command` | 扩展 |

## 4. 硬约束（新增域必须同时满足）

1. `preload.cjs` 与 `main.cjs` 必须同时登记；新增能力只走 trusted(event) 校验的 `invoke`。
2. 不得暴露 `ipcRenderer`、`webContents`、`BrowserWindow`、`fs`、`shell` 的原始对象。
3. 返回值必须经主进程 sanitize：token / verifier / 密钥 / 绝对路径不得过桥。
4. TS 类型声明落在 `src/types/openarc-ipc.d.ts`（P1 交付；此前 `src/vite-env.d.ts` 仅 4 行，`window.openarc` 无类型）。

## 5. NOT VERIFIED

- `files:*` 各操作在真机上的权限语义（本轮未逐一走通）。
- 计划 §4 中 `developer:command` / `market:command` 是否合并为一个域：计划未明确，保留为待对齐项。
