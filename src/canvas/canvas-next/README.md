# canvas-next：新的无限画布

整体替换 `react-canvas/ReactCanvasApp`。界面、交互、生成引擎、Agent 都在这里；后端只通过 `backend/types.ts` 的 `CanvasBackend` 接口访问。

## 目录

| 文件 | 作用 |
|---|---|
| `entry.tsx` | 桌面版接入点 `NextCanvasApp`，props 与旧 `ReactCanvasApp` 相同（win / onOpenModelSettings / onBackToWorkspace …） |
| `CanvasApp.tsx` | 画布根组件：`<CanvasApp backend canvasId host />` |
| `model.ts` | 节点数据模型（生成数据存在 `node.data.gen`，兼容现有 CanvasDoc）、模型能力表、参数、连线关系 |
| `table.ts` | 多维表格：数据、出表提示词与校验、输入列、逐行批量（简化自 NOVAI / DX OS） |
| `engine.ts` | 生成引擎：组装请求、单节点生成、重新生成新建节点、链式运行、文本出表、表格逐行批量 |
| `store.ts` | 状态（文档 / 视口 / 界面 / 运行态），撤销重做，防抖保存 |
| `actions.ts` | 连线、删除、复制粘贴、上传等编辑动作 |
| `backend/bridge.ts` | 真后端：`window.openarc.canvas / model` 命令；`BACKEND_TODO` 列出后端还要补的参数 |
| `backend/mock.ts` | 模拟后端（独立页 / 测试） |
| `agent/` | Agent：对话、技能、记忆、上下文；真后端时走对话模型 + `plan` 协议 |
| `ui/` | 视口、节点、连线、生成面板、表格节点、菜单、浮层、编辑器、样式 |
| `dev/` | 独立页入口与示例画布 |

## 换入口

```tsx
// src/canvas/react-canvas/main.tsx
import { NextCanvasApp } from "../canvas-next/entry";
createRoot(root).render(<NextCanvasApp />);
```

其他地方引用 `ReactCanvasApp` 的，换成 `NextCanvasApp`（props 相同）。

## 数据兼容

- 文档仍是 `CanvasDoc`，读写走 `react-canvas/persistence.ts`（含旧格式迁移、409 冲突）。
- 生成相关字段在 `node.data.gen`；同时把当前结果同步回 `node.text / url / variants / ratio`，旧组件和导出照常能读。
- 旧版的 table / note / group / 3D / 时间线节点只读显示，不会丢。
- 表格节点：`kind: "table"`，数据在 `node.data.table`；旧版只读表格的 `data` 会自动转换。

## 素材发给模型：一律转成链接

`backend/bridge.ts` 的 `linkInputs / modelUrl`：生成前把所有图片 / 视频 / 音频输入换成 https 地址，不再传 base64。

- http(s) 地址原样用；data URL 先 `canvas/importAsset` 存进资源库；资源库引用 `openarc-asset:…` 调 `canvas/assetPublicUrl` 换链接（按资源缓存，剩余不足 1 小时重新获取）。
- 主进程实现：`electron/canvas-asset-public-url.cjs`，当前上传到 Litterbox（catbox.moe 临时文件，**有效期 24 小时**，单文件 ≤ 1GB，匿名）；同一内容按 sha256 复用链接。
- 后端还没有 `canvas/assetPublicUrl` 时的兜底：图片压缩到长边 2048、≤1.5MB 后以 data URL 发送；视频 / 音频直接报错说明原因，不会把大文件塞进请求。
- 编辑类（局部重绘、扩图……）的原图和蒙版同样走链接（`sourceUrl` / `maskUrl`）。

## 后端还要补（见 `backend/bridge.ts` 的 BACKEND_TODO）

- **`canvas/assetPublicUrl`**（新命令）：`{ canvasId, ref | dataUrl, ttlSeconds }` → `{ ok, url, expiresAt }`，把资源上传到对象存储或模型服务商的文件接口，返回模型能下载的 https 地址；按内容哈希缓存。
- 各生成命令的素材字段接收 https 地址（`sourceUrl`、`images[].url`、`video.url`、`audio`），不再要求 data URL。

- `canvas/modelImage`：多张参考图 `images[]`、风格、摄影机、联网；目前只有 `canvas/modelImageEdit` 能带 1 张参考图。
- `builtin.video-generator`：`modelType`（8 种生成方式）、首尾帧 / 参考图角色、源视频、驱动音频、时长、分辨率、有声、条数。
- `canvas/modelImageEdit`：多角度 / 重打光 / 扩图 / 增强 / 抠图等 mode、蒙版 `maskDataUrl`、参数、async。
- `canvas/runStatus`：返回 `progress`。
- `canvas/modelChatStream`：视觉模型读图 `images[]`、联网。
- Agent 的技能 / 记忆目前存在本机（localStorage），需要跨设备时接后端存储。

## 主进程接入 canvas/assetPublicUrl

`electron/canvas-bootstrap.cjs`：

```js
const { createAssetPublicUrl } = require("./canvas-asset-public-url.cjs");
// RENDERER_COMMANDS 里加 "canvas/assetPublicUrl"
// 拿到 service 之后：
const assetPublicUrl = createAssetPublicUrl(service, { provider: "litterbox" });
// switch 里：
case "canvas/assetPublicUrl":
  return assetPublicUrl({ context, canvasId: asStr(payload.canvasId, 120), ref: asStr(payload.ref, 200), dataUrl: typeof payload.dataUrl === "string" ? payload.dataUrl : null });
```

另外确认 CanvasHost 的消息桥会转发这条命令（若有白名单要加上）。

## 验证

```bash
npx tsc -p .          # 类型检查
npx vite build        # 独立页构建（canvas-next.html，模拟后端）
```
