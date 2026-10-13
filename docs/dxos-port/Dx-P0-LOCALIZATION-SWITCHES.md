# Dx-P0 · 本地化开关清单（计划 §6.3）

> 计划把云端依赖分三类处理：**保留（本地可闭环）/ 本地替身 / 关闭开关**。
> 本清单把三类落成可执行的开关名与默认值，供后续域直接引用。

## 1. 开关载体

- 落盘：`<userData>/dxos/switches.json`（与 `providers.json` 同目录，保持 JSON、便于导入导出）。
- 语义：**缺省即关闭**（`false`）。未显式打开的能力不得有任何假实现；界面必须显式标注「本地模式不可用」。
- 命名：`<域>.<能力>`，取值 true/false。

## 2. 保留（本地可闭环，默认开）

| 能力 | 开关 | 本地依赖 |
|---|---|---|
| 供应商调用（用户自填 baseUrl/key） | `providers.call` | 无（用户自备） |
| 技能包本地导入 | `skills.localImport` | 无 |
| ComfyUI 本地实例 | `comfy.local` | Python + ComfyUI（本机缺失，见 Dx-P0-DEPENDENCIES） |
| FFmpeg 渲染 | `media.ffmpeg` | ffmpeg/ffprobe（已装 7.1.1） |
| onnxruntime 抠图 | `media.backgroundRemoval` | onnxruntime + 模型（本机缺失） |
| 文件系统（blob/快照） | `fs.local` | 无 |
| 画布文档 | `canvas.local` | 无 |
| 自动化 | `automation.local` | 无 |

## 3. 本地替身（接口不变，仅换源）

| 原能力 | 替身 | 开关 |
|---|---|---|
| `protocolUpdates` 远程协议包更新 | 扫描本地协议包目录 | `protocol.updates.localDir` |
| `marketplace` 远程市场 | 本地目录清单 | `market.localCatalog` |
| 随包资源 `bundled-skill-packages/`、`bundled-comfy-workflows/`、`baselines/`、`protocol-fixtures/` | 直接作为本地源 | 无开关（始终本地） |

## 4. 关闭开关（本地无对端，默认关，契约保留）

| 能力 | 开关 | 界面要求 |
|---|---|---|
| 云账号 / 权益（`cloudAccount` / `cloudEntitlement`） | `cloud.account`（默认 false） | 显式标注「本地模式不可用」 |
| `dxosProtocol` 云 AI | `cloud.aiJob`（默认 false） | 同上 |
| 临时媒体上传（`publicMedia`） | `cloud.mediaUpload`（默认 false） | 同上 |
| 画布云同步（`canvasCloudSync`） | `canvas.cloudSync`（默认 false） | 同上 |
| 开发者实时房间 / OAuth | `developer.realtime` / `developer.oauth`（默认 false） | 同上 |
| 更新下载 | `update.download`（默认 false，源改本地） | 同上 |

## 5. 与安全不变量的关系

- 开关只影响**功能可用性**，不得用来放宽 CSP、不得暴露本地端口、不得让渲染层直连网络。
- 关闭态下调用必须返回明确的结构化错误（见 `electron/dxos-foundation-errors.cjs`），不得静默降级、不得伪造成功。
