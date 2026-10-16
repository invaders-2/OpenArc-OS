# OpenArc OS · 现状说明与问题清单

> 生成时间：2026-10-08 · **本文是本次唯一新增的文件**。本轮为只读梳理：未修改、未删除、未移动任何既有文件，未安装依赖，未改配置，未运行构建或测试。
> 取证方式：读取配置文件与源码、`grep`、行数统计、自制 import 可达性分析（脚本在 `/tmp/import-graph.mjs`，未写入仓库）。凡代码里找不到依据的，本文明确标注**不确定**。

---

## 0. 先分清两个"工作区"（这是理解一切的前提）

| | 主仓库 | 专用 worktree（移植版） |
|---|---|---|
| 路径 | `/Users/wepingli/Desktop/OpenArc OS` | `/Users/wepingli/.openarc-worktrees/dxos-port-r1` |
| 分支 / HEAD | `integration/ui-core` @ `128e21d` | `dxos-port/r1` @ `128e21d` |
| 内容 | **基线**：无任何移植代码（实测） | 基线 + DX OS 移植（P1/P2） |
| 桌面产物 | — | `/Users/wepingli/Desktop/OpenArc OS.app` 由**该 worktree** 构建 |

> 桌面那个 `OpenArc OS.app` 装的是 **worktree 的移植版**，而项目主目录是**基线**。**"看不到变化"最直接的原因就是这个错位**：从主目录起预览看到的是旧代码。

---

## 1. 这个项目是做什么的

**一句话**：OpenArc OS 是一个跑在 macOS/Windows 上的"完整独立桌面系统"（不开发内核、依赖宿主系统），提供自己的登录、桌面、窗口、文件管理、应用中心、统一设置、权限与局域网协作，并让 AI 在授权范围内操作这些能力。

依据（原文引用，不是我推断的）：

- `PRODUCT.md:5`：「运行在 Windows/macOS 上的完整独立桌面系统，提供自己的登录、桌面、窗口、文件管理、应用中心、统一设置、用户权限和局域网协作……**不能简化为聊天窗口加应用入口**。」
- `PLAN.md:9`：「OpenArc OS 是运行在 Windows/macOS 上的完整独立桌面系统，依赖宿主系统运行，不开发操作系统内核。」
- 界面方向（`PRODUCT.md:11`）：Apple 半透明磨砂玻璃 + Spectrum UI 交互参考；`DESIGN_SYSTEM.md:7`：「色彩体系由'中性灰阶 + 蓝色强调'改为**中性灰阶单色体系**……**蓝色一律不用**」。
- 文档自述的成熟度（`PLAN.md:3`）：「不代表功能已开发或接入已验证」「实际完成情况以 PROGRESS.md 和验证证据为准」。

**说明缺失的直接证据**：`README.md` 全文只有 13 字节 —— `# OpenArc-OS`。**没有任何面向读者的项目说明**，信息散落在 `PRODUCT.md`(10.7 KB)、`PLAN.md`(65.8 KB)、`DESIGN_SYSTEM.md`(21 KB)、`MOTION_SYSTEM.md`(14.8 KB)、`PROGRESS.md`(420 KB)、`CHANGELOG.md`(208 KB)、`WORKTREES.md` 与 `docs/`(29 MB / 74 项) 里。这是"看不懂项目在做什么"的结构性原因。

---

## 2. 入口与运行方式（全部有配置依据，未臆测）

| 用途 | 命令 | 依据 |
|---|---|---|
| 桌面应用入口 | `electron/main.cjs` | `package.json` 的 `"main": "electron/main.cjs"` |
| 渲染层入口 | `index.html` → `/src/main.tsx` | `index.html` |
| 设计系统回归面（第二入口） | `design-system.html` → `/src/design-system/gallery.tsx` | `vite.config.ts` 的 `build.rollupOptions.input` |
| 只跑前端（浏览器） | `npm run dev` = `vite --host 127.0.0.1` | package.json |
| 实时预览（前端 + Electron） | `npm run dev:app` = `node scripts/dev-app.mjs` | package.json |
| 本地跑成品 | `npm run desktop` = `npm run build && electron .` | package.json |
| 构建 | `npm run build` = `tsc --noEmit && vite build` | package.json |
| 单测 | `npm test` = `node --test tests/*.test.mjs` | package.json |
| 把产物同步到桌面 .app | `npm run oa:app` = `node scripts/sync-app.mjs` | package.json |
| 多 worktree 状态总览 | `npm run oa:status` | package.json |

共 **74 个脚本**；其中 30+ 个是分批次探针（`test:d1-*`…`test:d5-*`、`test:desktop`、`test:design-system` 等）。

---

## 3. 顶层目录职责

| 路径 | 职责 | 规模/依据 |
|---|---|---|
| `electron/` | 主进程后端：`<domain>-{domain,service,store,bootstrap}.cjs` 命令总线，87 个 `.cjs` | 32,718 行；最大 `identity-store.cjs` 2,883 行 |
| `src/` | 渲染层前端（React 19） | 39 文件 / 20,190 行 |
| `tests/` | node:test 单测 + 真机探针 | 256 个条目 |
| `experiments/` | 分批次验收探针（`<批次>/run-all.mjs`） | 39 个目录 |
| `docs/` | 各批次 RESULT/证据 + `decisions/ incidents/ plans/ snapshots/` | 74 项 / **29 MB** |
| `public/` | 静态资源：`icons/ cursors/ novai-canvas/ openarc-mark.svg` | 4 项 |
| `build/` | 打包图标 `icon.icns` | 1 项 |
| `artifacts/` | 探针输出（性能、截图等） | 12 个目录 |
| `dist/` | `vite build` 产物（构建生成） | — |
| `.workbuddy/memory` | 工具记忆目录 | — |
| 根文档 | `PRODUCT/PLAN/PLAN_SYNC/DESIGN_SYSTEM/MOTION_SYSTEM/PROGRESS/CHANGELOG/WORKTREES/AGENTS.md` | 见 §1 |

---

## 4. 前端由哪些部分组成

### 4.1 目录 = 应用/域（基本清晰）

| 目录 | 内容 | 行数 |
|---|---|---|
| `src/main.tsx` | **整个桌面壳 + 全部窗口内容都在这一个文件里** | 3,972 |
| `src/styles.css` | **全站唯一样式表** | 3,978 |
| `src/design-system/` | `tokens.css`(439) `primitives.tsx/css`(569/611) `page-states.tsx/css`(125/52) `gallery.tsx/css`(541/173) | 2,510 |
| `src/desktop/` | 桌面壳部件与 hooks：`components.tsx`(1,288)、`SiriBlob`(271)、`SiriOrbProcedural`(612)、`useDesktop`(413)、`useDockMagnify`(239)、`useDockArrange`(204)、`useMicLevel`(112)、`Dialog`(122)、`cursors`(65) | — |
| `src/mcp/` | `McpCenter.tsx`(1,602) | |
| `src/canvas/` | `CanvasHost.tsx`(791) —— NOVAI 画布宿主，挂在 `main.tsx:71` 导入、`:2646` 渲染 | |
| `src/resource/` | `ResourceLibraryApp.tsx`(692) | |
| `src/identity/` | `AuthScreens`(488)、`useIdentity`(249)、`types`(184)、`AvatarPicker`(136)、`Avatar`(120) | |
| `src/device/` | `DevicePane.tsx`(500) | |
| `src/browser/` | `BrowserApp.tsx`(368)、`types.ts`(74) | |
| `src/settings/` | `ModelSettings.tsx`(248 基线)、`SettingsContent.tsx`(83) | |
| `src/governance/` | `GovernanceApp`(245)、`CanvasApp`(90)、`ProjectsApp`(77)、`ResourcePicker`(73)、`FilesApp`(59) | |
| `src/approval/` | `ApprovalPrompt.tsx`(206) | |
| `src/authorization/` | `ProtectedResourceFixture.tsx`(115) | |

### 4.2 引用关系（自制 import 图，从两个入口出发）

- 入口：`src/main.tsx`、`src/design-system/gallery.tsx`。
- 结果：39 个源文件中 **只有 1 个不可达**：`src/governance/CanvasApp.tsx`。
- 例外说明：`src/vite-env.d.ts` 也被标"不可达"，那是分析口径问题（`.d.ts` 不产生 import），**不是死代码**。
- 层级关系：`index.html → main.tsx →（design-system / desktop / settings / mcp / canvas / resource / identity / device / browser / governance / approval）`；后端经 `electron/preload.cjs` 暴露的 `window.openarc` 单一桥通信（渲染层不允许直连本地端口，CSP `connect-src 'none'`，`index.html:8`）。

---

## 5. "移植"到底是从哪到哪

### 5.1 源（只读，不在本仓库内）

```
/Users/wepingli/Downloads/DXOS-Portable-0.5.1-mac-arm64/.dx-runtime/versions/runtime-0.5.1-baseline/
  DX OS.app/Contents/Resources/app.asar.unpacked/server/     ← 110 个顶层 .ts + 13 个子目录，共 63,422 行
  DX OS.app/Contents/Resources/app.asar                      ← 打包主进程 main.cjs
同目录还有计划文档 DXOS-PORT-IMPLEMENTATION-PLAN.md（本次移植的唯一依据）
```

DX OS 0.5.1 是商业桌面应用，**没有公开仓库/文档**；其技术形态：Electron 壳 + `app.asar` 内主进程用内置 node+tsx spawn Express 后端（`server/index.ts` 与 `server/worker.ts`），数据落在 `~/DX OS/data`。

### 5.2 目标

`dxos-port/r1` worktree（`/Users/wepingli/.openarc-worktrees/dxos-port-r1`）。**主仓库里一个字节都没有。**

### 5.3 已经搬过来的（P1 + P2，均在该 worktree 内）

| 类别 | 文件 | 说明 |
|---|---|---|
| 地基 P1 | `electron/dxos-foundation-{schema,paths,errors,mask,events,runner,quota}.cjs` | 52 张 DX 表并入 `identity.db` 的 v22 迁移（跳过 5 张同名表）、数据根布局、错误规约、掩码、事件通道、子进程运行器、配额原语 |
| 类型契约 | `src/types/openarc-ipc.d.ts` | `window.openarc` 的类型声明（此前 `src/vite-env.d.ts` 仅 4 行，无任何类型） |
| 协议域 P2 | `electron/provider-protocol-{domain,store,service}.cjs` | 协议表、`providers.json` 读写（密钥走 safeStorage，不落明文）、统一调用出口 |
| 协议引擎 | `electron/protocol-engine/` 15 个 `.cjs` | 声明式协议编译/校验/工作流轮询/产物下载（**新增 SSRF 防护**，上游没有） |
| 能力清单 | `electron/model-manifest-{domain,service}.cjs` | 能力 manifest、参数 schema、路由描述符；远程更新改本地目录扫描 |
| IPC | `electron/model-bootstrap.cjs` 追加 8 个动作 | `protocol/list|get|validate|save`、`manifest/get`、`provider/call`、`image/generate`、`protocol/execute` |
| 前端适配 | `src/settings/ModelSettings.tsx` +56 行 | manifest 驱动的参数表单（数据层） |
| 测试 | `tests/dxos-foundation.test.mjs`(23 例)、`tests/dxos-protocol.test.mjs`(12 例) | 实测全绿 |

新增代码约 **5,557 行**；`npm run build` exit 0；`npm test` 1447 项 / 1446 通过 / 1 失败（该 1 项是**基线就有**的环境性失败，见 §6.14）。

### 5.4 还没搬 / 明显缺失

1. **模型协议只搬了 1 个**：18 个 v2 模型协议中仅 `openai-images` 可用；`openai-chat-media、comfly-openai、gemini-generations、gpt-best-images、fhl-images、gemini、zkki-images、agtoken-videos、apimart-images、midjourney、apib-images、modelscope-images、volcengine、volcengine-speech、xai、minimax、agnes` 共 **17 个未移植**（在 `protocol/list` 中标 `ported:false`）。
2. **legacy 协议执行器未搬**：`protocols.ts` 的 29 模型 / 19 供应商只进了"协议表"，执行器仍在 DX OS 侧。
3. **规则表被简化**：`protocolInference.ts`(231 行) 未逐条搬运，只保留最保守的关键词规则。
4. **未搬的附属件**：`agnesImageCanary.ts`、`agnesKeyframeCanary.ts`（原生 canary）、modelscope LoRA 归一化。
5. **迁移内的数据操作未搬**：v34 内置 `agent_profiles` 种子、v47/v48 JSON 回填（只抽了 DDL，空表无意义）。
6. **跨域外键全部去掉**（23 处只留列）：因为 OpenArc 的 `tasks` 主键是 `task_id`、`task_steps` 是 `step_id`，照抄 DX 的 `REFERENCES tasks(id)` 会触发 `foreign key mismatch`；代价是 DX 子表可以写入任意 `task_id`，约束留给后续任务域对齐。
7. **真实调用未验证**：无 API 密钥，`experiments/dxos-p2/real-call.mjs` 只验证了"缺密钥时 SKIP 并 exit 0"。
8. **计划里的 P3–P8 完全没开始**：技能系统、MCP 工具调用开放、任务/Agent 内核、媒体/ComfyUI、自动化、云替身、开发者平台与市场、全量验收。
9. **本地依赖缺**：ComfyUI 未安装、`onnxruntime`（node 与 python）未安装、抠图模型缺失；ffmpeg 7.1.1 与 python 3.12.12 已有。

---

## 6. 前端"乱"的具体位置与表现（按严重度排序）

> 每条都给了文件与行号，可自行核对。**风险等级**：🟢 低（改了不影响行为）/ 🟡 中（会动到探针或需要你定文案）/ 🔴 高（改变现有结构或行为）。

### P1 · 直接造成"界面看不懂"

| # | 位置 | 现象 | 原因 | 建议 | 风险 |
|---|---|---|---|---|---|
| 6.1 | **移植版** `src/settings/ModelSettings.tsx:134-139`（定义）与 `:257`（渲染） | 界面上直接出现 `Limits: {"references":{"images":{"max":16}},"output":{"count":{"min":1,"max":4}}}` —— 一整串原始 JSON | `limitsLabel()` 用 `JSON.stringify(limits)` 直接返回 | 改成人类可读（如"参考图 ≤16；单次输出 1–4 张"）或折叠进"详情" | 🟡 |
| 6.2 | `src/settings/ModelSettings.tsx:127`、`:79` | 失败时把后端错误码原样显示，如 `MODEL_COMMAND_NOT_ALLOWED`、`NO_MODEL_FOR_PROVIDER` | `setError(p.error)` 直接把 error 字段塞进 `<p>{error}</p>` | 建立错误码→中文文案映射表 | 🟢 |
| 6.3 | 同上 `:173`(`Remote Model ID`)、`:137/:176`(`PERSONAL`)、`:200/:201`(`Declared:`/`Verified:`)、`:194`(`No models configured`)、`:97`(`Model registered`)、`credLabel`(移植版 `:141`) | 同一页里中英混排：外层是"模型/AI""注册 Model"，内部却是英文标签与英文枚举值 | 该页是 D4-01 批次以英文技术词建设的，之后未做文案统一 | 统一中文（或统一英文），枚举值改成中文显示但保留原值 | 🟡 |
| 6.4 | 移植版 `src/settings/ModelSettings.tsx:229-245` | 模型页把"选择 Provider / Remote Model ID / Display Name / scope / 能力勾选 / 参数字段 / 注册 Model"压在两三行里；manifest 参数字段插在"能力勾选"与"注册 Model"之间，看不出它属于谁 | 新增数据层时按最短路径插入，未做分组 | 分为"注册新模型"与"已注册模型"两块；参数字段归属到具体模型行 | 🟡 |

### P2 · 样式体系

| # | 位置 | 现象 | 原因 | 建议 | 风险 |
|---|---|---|---|---|---|
| 6.5 | `src/styles.css` 全文（3,978 行 / 649 个规则块） | 全站样式集中在一个文件，只有 2 处分段横幅（`:2308`、`:3280`）；组件与样式无对应关系，改一个类名要全文搜索 | 逐批次追加式生长 | 按既有视觉不动，仅做**机械分段 + 索引注释**；真正拆分需你确认 | 🟡/🔴 |
| 6.6 | `src/styles.css` 55 处硬编码色值 | 例：`:434-439`（`#1d1d1f/#f5f5f7/#48484a`）、`:1032`（`#fff`）、`:1709-1712`（`#171717/#f2f2f4`）未见对应 token | 与 `tokens.css`（439 行，设计系统唯一权威，`DESIGN_SYSTEM.md` 要求"不得自己发明颜色"）并存 | 逐条判定：能用 token 的换成 token，确实必要的（如 `:321-327` 交通灯、`:1412` 品牌渐变、`:69-70` 有注释说明的合成色）保留并注明 | 🟡 |
| 6.7 | `src/settings/ModelSettings.tsx`（`.d401-*` 13 个类名）+ 另一处 `data-d4-01-*` | 内部**开发批次号**进入了产品 DOM 与 CSS 选择器（如 `d401-caps`、`data-d4-01-model-limits`） | 探针需要稳定选择器，直接用了批次号命名 | 改成语义化名（`model-limits` 等）；**但 `tests/` 与 `experiments/` 的探针大量依赖这些选择器**，改名要同步改探针 | 🟡 |
| 6.8 | `package.json` devDependencies 的 `tailwindcss`、`@tailwindcss/vite` | 声明了 Tailwind，但 `vite.config.ts` 没挂插件、`styles.css` 无 `@import "tailwindcss"`、全仓 0 个工具类 | 意图不明（预留？遗留？） | 需要你确认是保留还是移除 | 🟡 |

### P3 · 结构与残留

| # | 位置 | 现象 | 原因 | 建议 | 风险 |
|---|---|---|---|---|---|
| 6.9 | `src/main.tsx`（3,972 行；`App()` 从 `:400` 起，约 3,570 行；51×`useState`、26×`useEffect`、17×`useMemo/useCallback`） | 一个组件同时管：桌面壳、窗口层、桌面图标、垃圾桶、壁纸、文件夹窗口、设置路由、AI 面板接线、画布挂载 | 逐批次往同一个文件追加 | 按现有边界抽成独立组件/hook（不改行为），**这是风险最高的一项，需你确认是否纳入本轮** | 🔴 |
| 6.10 | `src/governance/CanvasApp.tsx`（90 行） | **从任何入口都不可达**（import 图实测）；同名能力已由 `src/canvas/CanvasHost.tsx`(791 行，`main.tsx:71/:2646` 挂载) 承担 | D3-04D 的早期实现被 D5-02 取代 | 只列出，**不删**；若要删需你确认 | 🟢（删除动作另议） |
| 6.11 | `src/governance/` | 目录里混放 5 个不相关应用：`GovernanceApp`(治理)、`CanvasApp`(画布)、`ProjectsApp`、`FilesApp`、`ResourcePicker` | 按批次而不是按领域归置 | 按领域重排（移动文件）→ 会动 import 路径 | 🟡/🔴 |

### P4 · 体量与导航（不是代码缺陷，但影响"看得懂"）

| # | 位置 | 现象 | 建议 | 风险 |
|---|---|---|---|---|
| 6.12 | `README.md`（13 字节） | 项目没有任何入门说明 | 写真正的 README（定位/入口/命令/目录/模块职责） | 🟢 |
| 6.13 | `docs/` 74 项 **29 MB**、`PROGRESS.md` 420 KB、`CHANGELOG.md` 208 KB、`tests/` 256 项、`experiments/` 39 目录、`artifacts/` 12 目录 | 历史记录与验证证据量极大，新人无法判断"哪些是当前事实" | 加 `docs/INDEX.md` 索引 + 归档旧批次（**只增不删**） | 🟢 |

### 6.14 属于"看起来像问题、其实不是"的（避免误判）

- `src/desktop/SiriBlob.tsx`(271) 与 `src/desktop/SiriOrbProcedural.tsx`(612) **不是重复实现**：`src/desktop/components.tsx:250-252` 说明这是三级降级链（系统原生 → WebGL 程序化 → orb-ui）。
- 截图里"窗口互相重叠""顶部悬浮的『全局 AI 未连接』药丸""Dock 放大"来自窗口管理器与桌面壳设计（`DESIGN_SYSTEM.md` 明确"桌面感来自可管理的窗口"），**不是布局错误**。如果你觉得它看起来乱，那是设计取舍问题，需要你定。
- `design-system.html` + `gallery.tsx` 是**内部回归面**（`vite.config.ts` 注释明确说明），不是死代码。
- `npm test` 有 1 项失败（`tests/d5-03-dsh-runtime-pin.test.mjs:131`）：因为 worktree 的 `node_modules` 是指向主仓库的符号链接，断言要求 ACP SDK 路径"在项目内"而解析到了主仓库。**基线就有，与移植无关**（本轮只读，未运行测试，此结论来自上一轮实测记录）。

---

## 7. 死代码 / 临时文件 / 历史遗留副本（只列出，未删除）

| 位置 | 性质 |
|---|---|
| `src/governance/CanvasApp.tsx` | 疑似残留实现（无引用，见 6.10） |
| `/Users/wepingli/Desktop/openarc` | 桌面上另一个独立仓库（含自己的 `.git`/`.changeset`/`.github`，2026-06~07 时期），与本项目关系**不确定** |
| `/Users/wepingli/Desktop/openarc-workflow` | 同上，关系**不确定** |
| `/Users/wepingli/.openarc-retired-20261008/` | 历史副本暂存区：7 个 `OpenArc OS-d*` 副本 + `_node_modules-from-OpenArc-OS-9119f85` |
| `/Users/wepingli/.codex/worktrees/ui-design-alignment/OpenArc OS` | 另一个 worktree（detached `e0a557e`） |
| `/Users/wepingli/.openarc-worktrees/dxos-port-r1` | 本轮移植 worktree（**在用**，见 §0） |
| `.workbuddy/memory`、`artifacts/`、`dist/`、`node_modules/` | 工具/构建产物目录 |

---

## 8. 待确认问题

按「哪些必须你定、哪些属我可自决的技术细节」分成 A / B 两组。

### A 组 · 必须你拍板（产品方向 / 外观 / 范围 / 删除文件）

1. **范围界定**：本轮"整理"是只针对**主仓库（基线）**，还是也要覆盖 **`dxos-port/r1` worktree（移植版）**？（两者的"乱"不完全相同：6.1/6.4 只存在于移植版。）
2. **是否保留现有界面外观**：`DESIGN_SYSTEM.md` 说 token 是唯一权威、不得新增/改写。整理时我只做"不改视觉"的改动，还是允许调整视觉（间距/分组/层级）？这直接决定 6.3–6.5 的做法。
3. **移植的目标状态**：是继续走完计划里的 P3–P8（完整复刻），还是先停在已确认的 P0–P2、把现有成果整理清楚？这决定要不要补那 17 个协议。
4. **`tailwindcss`/`@tailwindcss/vite`**（6.8）：有意预留、还是可以移除？
5. **`src/governance/CanvasApp.tsx`**（6.10）：确认无用可删吗？（删文件属"删除现有文件"，我不动。）
6. **`Limits:` 原始 JSON**（6.1）：改成中文可读文案、还是整块隐藏？
7. **模型设置页语言口径**（6.3）：统一中文、还是保留英文技术词（`Remote Model ID` 等）？
8. **批次号选择器**（6.7）：是否要改成语义化命名？会牵动 `tests/`+`experiments/` 里依赖 `data-d4-01-*`/`d401-*` 的探针。
9. **`src/main.tsx` 拆分**（6.9）：是否纳入本轮？这是改动量最大、回归风险最高的一项，我建议单独一轮做。
10. **`styles.css` 是否拆分**（6.5）：只做机械分段注释（低风险），还是按域拆文件（需要改 `index.html`/构建）？
11. **README 与 docs 索引**（6.12/6.13）：写不写？写给谁看（新读者 / 你自己 / AI 协作者）、要多深？
12. **桌面历史副本**（§7）：`openarc`、`openarc-workflow`、暂存区、额外 worktree —— 要不要处理？（我不会动，除非你明确说。）

### B 组 · 属我可自决的技术细节（下面是**我打算这么做**，你若无异议我就照此执行；有异议请直接推翻）

| 原编号 | 事项 | 我打算的做法 |
|---|---|---|
| 4 | `tailwindcss` 依赖 | **本轮不动**（不删依赖、不接线），只在 README 里标注"已声明但未使用，待确认" |
| 6 | `Limits:` 原始 JSON | 改成中文可读（如"参考图 ≤16；单次输出 1–4 张"），原始值仍保留在 `data-` 属性里供探针断言 |
| 7 | 模型页语言口径 | 统一中文；底层枚举值（`PERSONAL` 等）不改，只改显示文案 |
| 8 | 批次号选择器（`data-d4-01-*`/`d401-*`） | 暂不改名 —— 会牵动 `tests/`+`experiments/` 探针，收益低于风险；只在文档里登记 |
| 9 | `src/main.tsx` 拆分（3,972 行） | **本轮不做**，建议单开一轮；若你要做，我先给拆分边界与回归方案再动手 |
| 10 | `styles.css` 拆分 | 只做**机械分段 + 索引注释**（不改任何选择器/样式），不拆文件 |
| 11 | README 与 `docs/INDEX.md` | 写：定位、入口与命令、目录职责、模块清单、当前完成度（不明说未验证的事） |

> 说明：B 组之所以算"我可自定"，是按项目既有规则——技术栈、代码组织、文案实现属执行细节；A 组涉及产品方向、外观取舍、范围与删除动作，必须你定。

## 9. 我明确"不确定"的点

- **不确定** `Desktop/openarc` 与 `Desktop/openarc-workflow` 与本项目的关系（目录里看不到引用关系）。
- **不确定** `tailwindcss` 是有意预留还是历史遗留（代码里零使用，也零说明）。
- **不确定** `PRODUCT.md`/`PLAN.md` 描述的产品目标是否仍是当前有效目标（文档自称"不代表功能已开发或接入已验证"）。
- **不确定** `src/governance/CanvasApp.tsx` 是刻意保留的演示还是残留。
- **未验证**：主仓库 `npm test` 是否全绿 —— 本轮只读，**未运行任何构建或测试**。
