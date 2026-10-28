# DX-OS 前端架构 → OpenArc OS 映射说明（Phase 1）

> 版本：2026-10-08 · 对应改动：`src-vue/` 骨架 + `vue.html` 第二入口 + 壳层 token 化
> 依据：用户确认「接受仅凭构建产物反推架构」「允许追加 token」「换栈 Vue」「在既有项目上替换界面层」

## 1. DX-OS 前端的可读边界（先说清楚限制）

DX-OS 0.5.1 的**前端源码不随包**：`app.asar` 只有主进程 + node_modules（11,708 项），
`app.asar.unpacked/src/` 只有 4 个文件（画布节点注册表 + 视频域定义）。
前端实体是 `app.asar.unpacked/dist/` 的构建产物：`index.html` + **50 个 JS chunk + 37 个 CSS chunk**，主包 374 KB / 161 行（已压缩）。

因此"架构一一对应"只能做到 **模块/页面切分** 这一层；组件内部层级、props、store 划分无法与上游逐项对应。

## 2. 上游架构（实测提取）与我们的映射

| DX-OS（产物证据） | 我们的落点 | 说明 |
|---|---|---|
| Vue 3.5.40 + Pinia 2.3.1 | `vue@3.5.40` + `pinia@2.3.1` | 版本与上游逐字相同 |
| Vite 构建、按 chunk 懒加载 | Vite 7 + `@vitejs/plugin-vue@6` | 上游每个功能一个 chunk；我们 Phase 1 先落壳层 |
| **无 vue-router**（全产物 0 处匹配） | 不引路由库 | 导航由壳层状态驱动（Pinia `stores/shell.ts`），与上游一致 |
| 壳层 8 模块：Wallpaper / Desktop / Dock / Launchpad / WindowLayer / ControlCenter / Overlays / QuickLook | `src-vue/shell/` 同名 8 个 `.vue` | **结构对齐**；视觉完全换成本项目设计语言 |
| 壳层与窗口层共享逻辑 | 渲染层与主进程共用 `electron/*.ts` 纯领域实现；Node 22 / Electron 44 原生类型擦除，Vite 直接加载 ESM，无需 devCjs | Phase 1 未接 IPC，共享实现保持一致 |
| 每功能一个 App chunk（Welcome/Files/Conversation/Settings/McpManager/SkillsApp/MarketApp…） | `src-vue/pages/`（Phase 1 只有 `Welcome.vue`） | 逐页迁移将在后续阶段进行 |
| 一页一样式文件 | `<style scoped>` 就地 + 全部走 `var(--token)` | 我们不做"每页一个 CSS 文件"，改用 scoped 样式；理由见 §4 |
| i18n 独立 chunk（zh-CN / en-US） | 未落地 | **待确认**：是否要引入 i18n（会新增依赖），Phase 1 文案为中文硬编码 |

**技术栈差异（必须记录）**：上游是 **Vue**，本项目原本是 **React 19.1**。按用户决策，界面层换栈为 Vue；
Electron 主进程（`electron/**`，32,718 行 CJS）、`preload.cjs` 的 `window.openarc` 桥、IPC 契约、后端域**全部不变**。

## 3. 设计语言接入层（token / 主题）

**唯一权威**：`src/design-system/tokens.css`（Phase 1 追加了壳层区块）。Vue 侧**不复制 token**，`src-vue/main.ts` 直接 import 该文件。

**使用方式**

```vue
<style scoped>
.panel {
  background: rgb(var(--surface-rgb) / var(--surface-alpha)); /* 颜色：一律 token */
  border-radius: var(--radius-3);
  box-shadow: var(--elevation-2);
  font-size: var(--fs-secondary);
  z-index: var(--shell-z-overlay);        /* 壳层结构：Phase 1 新增 */
}
</style>
```

**Phase 1 新增的壳层 token**（`:root` 17 项 + `.dark` 覆盖 3 项，每个都带"为什么需要"注释）：

- 尺寸基座：`--shell-icon` `--shell-icon-lg` `--shell-dock-icon` `--shell-launchpad-tile` `--shell-titlebar` `--shell-control-tile`
- 层序：`--shell-z-{wallpaper,desktop,window,overlay,launchpad,control-center,dock,quicklook}` = 0/10/20/30/40/50/60/70
- 桌面环境光与遮罩：`--shell-wallpaper-glow` `--shell-wallpaper-edge` `--shell-scrim`（浅色 0.85/0.05/0.28；深色 0.03/0.03/0.5）

**规则（后续阶段必须遵守）**：Vue 组件里**不得出现颜色 / 圆角 / 阴影 / 字号 / 层序 / 尺寸的字面值**，只能 `var(--…)`。
新增设计值一律加进 `tokens.css`，不要在组件里另开一套。

## 4. 关键取舍与理由（决策记录）

| # | 取舍 | 决定 | 理由 |
|---|---|---|---|
| 1 | `@vitejs/plugin-vue` 版本 | 用 **^6（6.0.9）**，不是批准的 ^5 | ^5 的 peer 是 `vite ^5\|\|^6`，本仓库 Vite 7，npm **ERESOLVE 直接失败**；^6 官方声明支持 Vite 7 |
| 2 | 壳层结构值放哪 | **迁入 `tokens.css`**（首次落地时曾放 App.vue 局部变量） | 用户已批准追加 token，且规范要求"设计语言优先通过 token 层接入"；这些值跨组件复用（层序/环境光），放组件里会变成第二权威。首次未迁是因为我把验收口径写成了"dist 逐字节一致"，**那条约束过严，现纠正为"命令无新增错误"** |
| 3 | 是否给 `vue.html` 进生产构建 | **不进**（Phase 1） | 让 `npm run build` 产物结构与改动前一致、风险最小；dev 下 Vite 自动服务根目录 html。收尾阶段再切换入口 |
| 4 | 是否改 `build` 脚本 | **不改**，新增独立 `typecheck:vue` | 保证既有验收命令口径不变；`tsconfig.json` 仍只 include `src`，`src-vue` 由 `tsconfig.vue.json` + `vue-tsc` 单独检查 |
| 5 | 样式组织 | Vue 用 `<style scoped>`，**不照搬"每页一个 CSS 文件"** | 上游是全局 CSS 切分（无 token 体系，全产物仅 8 个 CSS 变量）；我们已有 token 权威，scoped 样式 + token 更贴合本项目既有规范，也避免再造一份全局样式表 |
| 6 | 图标 | 加 `lucide-vue-next@0.468.0`（与 React 版同版本号） | 同一套图标延续；**不复制 DX-OS 的图标 chunk** |
| 7 | AI 球 | 弃用 `orb-ui` 第三级降级 | `orb-ui` 的 peerDeps 要求 react/react-dom，Vue 用不了；保留已有的 SiriBlob(原生) + SiriOrbProcedural(WebGL) 两级 |
| 8 | 路由 | 不引 vue-router | 上游产物中 0 处 vue-router；导航由壳层状态驱动，保持一致 |

## 5. 实际改动（文件清单）

**新增**
- `vue.html` —— 第二入口，CSP 与 `index.html` **逐字符一致**（含 `connect-src 'none'`），title = OpenArc OS
- `tsconfig.vue.json` —— 只 include `src-vue`，供 `vue-tsc`
- `src-vue/main.ts`（createApp + Pinia，import 既有 tokens.css）、`App.vue`、`env.d.ts`、`apps.ts`（应用注册表）
- `src-vue/stores/shell.ts` —— 壳层状态（launchpad / control center / quicklook 开关、窗口栈、外观三态）
- `src-vue/shell/{Wallpaper,Desktop,Dock,Launchpad,WindowLayer,ControlCenter,Overlays,QuickLook}.vue` —— 8 模块
- `src-vue/pages/Welcome.vue` —— 中文首屏
- `artifacts/vue-p1/**` —— 外观证据与比对脚本

**修改**
- `package.json` / `package-lock.json` —— 新增 `vue@3.5.40`、`pinia@2.3.1`、`lucide-vue-next@^0.468.0`、`@vitejs/plugin-vue@^6`、`vue-tsc@^2` + 新增脚本 `typecheck:vue`（**未卸载任何依赖、未改 build 脚本**）
- `vite.config.ts` —— 只在 `command === "serve"` 的插件数组追加 `vue()`
- `src/design-system/tokens.css` —— 追加壳层区块（`:root` 17 + `.dark` 3）

**未改动（已核对）**：`index.html`、`electron/**`、`src/main.tsx` 及其它既有 `src/**`、`tests/**`、`experiments/**`、`scripts/**`。

## 6. 验收结果（本人独立复跑）

| 命令 | 结果 |
|---|---|
| `npm run build` | exit 0（资源哈希链变化是预期的：tokens.css 内容变） |
| `npm test` | **1412 / 1412 / 0**，exit 0（与基线一致） |
| `npm run typecheck:vue` | exit 0 |
| `OA_CHROMIUM=… npm run test:design-system` | exit 0：01-token-contract **PASS 27**、02 PASS 32、03 PASS 56、05 PASS 18、04 PARTIAL（**既有** NOT VERIFIED，非本轮引入） |
| 渲染一致性 | 深色/实色/减少动态 **逐像素完全相同**；浅色 2.617%、QuickLook 2.109%（最大通道差 11/15），且**不超过同代码重跑的噪声地板**（浅色重跑差异同为 135,642 px / Δ11）→ 判定渲染一致 |

**环境注意（既有缺口，非本轮引入）**：`test:design-system` 默认去找 `ms-playwright/chromium-1228`，本机不存在；
用 `chromium-1223` 或系统 Chrome 并设 `OA_CHROMIUM` 即可跑通。

## 7. 怎么看 / 怎么用

```
npm run dev                      # 起 Vite
open http://127.0.0.1:5173/vue.html      # Vue 壳层（第二入口）
open http://127.0.0.1:5173/              # 既有 React 应用，未受影响
npm run typecheck:vue            # Vue 侧类型检查
```

## 8. 后续阶段（未做）

1. 逐页迁移（Welcome → 桌面壳接线 → 设置 → Files/Canvas/MCP…），每页连同它的 `data-*` DOM 契约一起搬。
   **硬约束**：`src/` 现有 **168 个 `data-*` 属性**（25 个文件），`tests/`+`experiments/` 有 114 个文件依赖 `dist/`、154 个探针跑 Electron+CDP —— 不逐字复现这些契约，"无新增错误"做不到。
2. 接入 `window.openarc`（壳层接真实窗口/文件/设置）。
3. 入口切换（`index.html` → Vue）与 React 依赖卸载、旧目录清理（**删除动作需单独确认**）。

## 9. NOT VERIFIED

- 减少动态的**动效行为**（时长归零/结构性替代）：静帧不可验证，由 `05-motion-matrix` 运行时探针覆盖，未录屏。
- 交互态（hover / 按下 / 拖拽 / 焦点环）未做截图比对。
- 未接入 IPC，故壳层未与真实窗口管理器联动。
- 是否引入 i18n（上游有 zh-CN/en-US 独立 chunk）**未定**，需你确认。
