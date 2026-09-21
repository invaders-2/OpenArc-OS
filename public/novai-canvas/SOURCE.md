# 上游来源与改动记录（D5-02 · 完整应用）

- 仓库：https://github.com/invaders-2/NOVAI-Infinite-Canvas
- **固定的源 commit：`6ce1a64680b669b31c2ac3b32418b54decd404f2`**（vendor 脚本每次核对 `git rev-parse HEAD`）
- 本轮 vendor **整个 `static/`**（14 个页面 + js/css/images/vendor/system-prompts/runninghub，103 个文件）：
  **入口 = 上游原版 `static/index.html`（AI Studio 外壳：首页 + 左侧导航 + 子页 iframe）**。
  上游的 Python 后端与桌面壳不在本目录内（OpenArc 用受控能力替代，见下）。

## 生成方式（唯一入口，可重复执行）

```
OA_NOVAI_SRC=/tmp/novai-canvas-src node experiments/d5-02/vendor-novai-app.mjs
```

**不做 `/static/` 路径改写**：`openarc-canvas:` 是 `standard:true` 的自定义协议，
页面里的根绝对 `/static/...` 会自然解析成 `openarc-canvas://bundle/static/...`。
改写 14 个页面 + i18n 动态注入 + 动态 `import()` 的风险远大于原样服务，所以整棵树原样拷贝。

| 目录/文件 | 来源 | 说明 |
| --- | --- | --- |
| `static/**` | `static/**` | **原样**，仅做下面三处注入 |
| `index.html` | `static/index.html` | 入口副本（桥 + 中继），根绝对 `/static/` 指向同一份资源 |
| `openarc-bridge.js` | OpenArc 新增 | 每页最先执行：端点白名单、账号作用域存储、pywebview 明确不可用、出网拒绝 |
| `openarc-shell.js` | OpenArc 新增 | **只注入入口**：子页 ↔ 外壳 ↔ 宿主的中继协议 |
| `openarc-adapter.js` | OpenArc 新增 | 只注入画布页：把宿主命令翻译成画布自己的原语（同一命令层 + 只读闸） |

## 对上游文件的三处注入（脚本化、可审计）

1. 每个页面 `<head>` 开头：CSP meta + `<script src="/openarc-bridge.js">`；
2. `static/js/canvas.js` 的 IIFE 末尾追加适配层（模板：`experiments/d5-02/vendor/canvas-internals.js`）：
   暴露画布原语（`window.__openarcCanvasInternals`）、只读闸、与撤销配对的 redo；
3. `static/canvas.html` 在 `canvas.js` 之后注入 `openarc-adapter.js`；入口 `index.html` 在桥之后注入 `openarc-shell.js`。

注入清单与哈希写在 `experiments/d5-02/vendor/vendor-manifest.json`（每次 vendor 重新生成）。

## 与上游行为的差异（全部在集成层，不改上游文件）

| # | 上游行为 | OpenArc 里的处理 | 为什么 |
| --- | --- | --- | --- |
| 1 | `DEFAULT_PAGE_ID='zimage'`(3901) 与预载 `frame-home`(3279) 不一致，首启停在"在线生图" | 中继在页面脚本之前把 `studio_active_page` 默认写成 `home`（**只在用户从未选过时**） | 首启必须是原版首页；用户选过就完全按上游记忆还原 |
| 2 | 首页点"最近项目"= 只切到画布管理器（`open-canvas` 消息只服务"待导入图片"） | 中继记下 `navigate` 里的 canvasId，直接驱动 `frame-canvas` 打开**那一本**编辑器 | 产品流程要求"返回首页 → 再打开项目"真的回到那本书 |
| 3 | 依赖 pywebview 桌面壳（11 个宿主方法） | 明确不可用：`window.pywebview` 读取即记录 + 明确提示，页面自动走网页版分支 | 不提供退出 OpenArc / 任意文件路径 / 任意宿主方法转发 |
| 4 | `localStorage`/`BroadcastChannel` 按同源共享 | 按 **OpenArc 账号 + 本次挂载** 的钥匙分桶（真实存储加 `oa:<key>:` 前缀，换挂载整片清掉） | "同一个 bundle origin"不等于不同账号已隔离 |
| 5 | `/ws/stats` 实时推送、桌面更新器（GitHub/Gitee/ModelScope 直连） | `/ws/stats` 明确失败（状态栏改用宿主队列计数）；更新/下载一律 501 并在界面标注"已禁用" | 不出网、不下载、不安装上游程序 |

## 未接入即缺项（保留入口 + 明确报错，不删页面）

素材库 / 提示词库 / 智能画布(Agent) / ComfyUI 与工作流 / RunningHub·即梦·Codex·Gemini-CLI 等第三方供应商 /
`/output`、`/assets` 历史文件浏览 / `/api/download-output`、`/api/view`、`/api/media-preview`
—— 这些页面照常可达，但它们的端点在桥里**明确返回 501 `OPENARC_UNSUPPORTED`**，
并在 OpenArc 窗口条上给出"该功能未接入 OpenArc（保留入口）"的一次性提示。
