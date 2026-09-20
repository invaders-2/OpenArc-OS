# 上游来源与改动记录（D5-02）

- 仓库：https://github.com/invaders-2/NOVAI-Infinite-Canvas
- **本轮固定的源 commit：`6ce1a64680b669b31c2ac3b32418b54decd404f2`**（克隆后 `git rev-parse HEAD` 核对一致）
- 只提取**无限画布**：上游的 Python 后端、桌面壳、智能画布（smart-canvas）、素材库、提示词库、
  ComfyUI / Midjourney / RunningHub / 即梦等其它产品页一律**不在**本目录内。

## 取用清单（39 个文件）

| 来源 | 去向 |
| --- | --- |
| `static/canvas.html` | `index.html`（路径改写 `/static/` → `./`，注入两个 OpenArc 脚本） |
| `static/js/canvas.js` | `js/canvas.js`（**唯一改动**：IIFE 末尾追加 OpenArc 适配层） |
| `static/css/{canvas,theme,marvis-shared,table-node}.css` | `css/` |
| `static/js/shared/{utils,icons,media,viewport,workflow-utils,node-registry,table-model,table-node,dropdown}.js` | `js/shared/` |
| `static/js/{theme,touch-mouse,image-adjust-editor,i18n,i18n-core}.js` | `js/` |
| `static/js/i18n/{common,studio,canvas}.js` | `js/i18n/`（i18n.js 的加载清单收窄到这四个） |
| `static/vendor/js/{tailwindcss-cdn,lucide-subset,glfx}.js` | `vendor/js/` |
| `static/vendor/css/fonts.css` + `static/vendor/fonts/*` | `vendor/css/`、`vendor/fonts/`（路径改写为 `../fonts/`） |
| `static/images/logo.png` | `images/logo.png` |

## 对上游代码的改动（可审计、最小）

1. **路径**：`/static/` → `./`；i18n 清单只留画布需要的四个模块。
2. **js/canvas.js 末尾**（IIFE 内，见文件尾部 `OpenArc 适配层` 注释块）：
   - 导出 `window.__openarcCanvasInternals`（画布自己的 getState / primitives，含 `runNode` = 节点 ▶ 按钮的同一入口）；
   - **只读闸**：`addNode / deleteSelectedNodes / pushUndo / performUndo` 在只读时直接拒绝并派发 `openarc-canvas-blocked`；
   - **补重做**：上游只有撤销栈，这里加一条与撤销配对的 redo 栈（新编辑清空 redo）。
3. 其余画布逻辑（节点/连线/渲染/保存/上传/生成流程）**原样保留**，未重写、未复制。

## OpenArc 侧新增（不在本目录）

- `public/novai-canvas/openarc-bridge.js`：最早执行的宿主桥（fetch/XHR 端点白名单 → postMessage →
  OpenArc 受控命令；内存 localStorage；外部页面导航拦截）。
- `public/novai-canvas/openarc-adapter.js`：把宿主命令翻译成画布自己的原语调用（同一命令层 + 只读闸 + 状态回报）。
- `src/canvas/CanvasHost.tsx`：OpenArc 应用窗口内容（项目与状态条 + sandbox iframe + 宿主 RPC）。
- `electron/canvas-{domain,store,service,bootstrap}.cjs`：画布文档层 / 版本检查 / 权限规则 / IPC 白名单。
