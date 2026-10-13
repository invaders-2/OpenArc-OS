# Dx-P0 · 依赖清单确认书（计划 §6.4）

> 采样环境：macOS 26.6.2 / arm64；Node v22.22.3；npm 10.9.8。

## 1. 实测可用性

| 依赖 | 用途 | 计划要求 | 实测 | 结论 |
|---|---|---|---|---|
| Node ≥ 22.5 | `node:sqlite` 的 `DatabaseSync` | 必需（现有约束） | **v22.22.3** | ✅ 满足 |
| FFmpeg / ffprobe | 视频渲染、媒体探测 | 媒体能力必需 | **ffmpeg 7.1.1**（/opt/homebrew/bin） | ✅ 已具备 |
| Python 3 + ComfyUI | ComfyUI 集成与桥接 | ComfyUI 能力必需 | Python **3.12.12** ✅；**ComfyUI 未在常见路径发现** | ⚠️ 缺 ComfyUI → P5 阻塞 |
| onnxruntime-node + 抠图模型 | 本地抠图 | 抠图能力必需 | **未安装**（node 侧与 python 侧均无） | ⚠️ P5 阻塞 |
| `better-sqlite3` | DX OS 使用；OpenArc 用内置 `node:sqlite` | 建议不引入，需确认 | 未安装 | ✅ **决定：不引入**，统一 `node:sqlite` |
| `sharp` | 图片处理 | 图像处理必需 | node_modules 中存在 0.35.5，但**仅是 devDependency `@deepseek-ai/dsh` 的传递依赖**（`npm ls` 实测），package.json 未声明 | ✅ **决定：本轮不引入直接依赖**；P5 需要时再单独确认 |
| `ws` | 画布协作 / realtime | 协作能力必需 | 同上（8.22.0，传递依赖） | ✅ **决定：本轮不引入直接依赖**；P5 再评估 |
| `multer` / `express` | 仅方案 B（主进程内嵌 HTTP）需要 | 本计划不引入 | — | ✅ 不引入 |
| 外部 CLI（即梦/Pippit/quark-drive/紫鸟等） | 第三方能力 | 全部可选，按插件启用 | 未探测 | ✅ 本轮不启用（默认关插件） |

`npm ls sharp ws` 关键证据（去标识后）：

```
openarc-os@0.1.0
└─┬ @deepseek-ai/dsh@0.1.5-rc.2
  └─┬ @deepseek-ai/dsh-base@0.1.5-rc.3
    ├─┬ @deepseek-ai/dsh-attachment-local@0.1.5-rc.3
    │ └── sharp@0.35.5
    └─┬ @deepseek-ai/dsh-api-gateway@0.1.5-rc.3
      └── ws@8.22.0
```

## 2. 本轮依赖决策（含理由）

1. **不新增任何运行时依赖**：P1/P2 均可由 Node 内置模块（`node:sqlite`、`node:http`、`node:crypto`、`node:fs`、`node:child_process`）与仓库已声明依赖完成。这样避免平台二进制与打包风险（计划 §10「新依赖引入成本」）。
2. **`better-sqlite3` 不引入**：与计划建议一致，统一到 `node:sqlite`；迁移框架已有 21 级经验可复用。
3. **`sharp` / `ws` 延后到 P5**：它们对应媒体处理与画布协作，属 P5 范围；届时需要显式声明为直接依赖并单独确认平台二进制随包方案。
4. **P5 前置缺口如实登记**：ComfyUI、onnxruntime、抠图模型缺失 → 相关能力在本轮与 P5 均无法实机验证（NOT VERIFIED），不造假实现。

## 3. 待用户提供

- 真实模型调用所需凭据（R11）：OpenAI 兼容的 baseUrl / key，以及所选图像协议所需的凭据。本机未发现任何预置密钥，且按约束不猜测、不检索。
