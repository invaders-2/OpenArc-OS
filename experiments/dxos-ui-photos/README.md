# dxos-ui-photos · 照片应用真机视觉与动效验收探针

只产出**证据**（截图 / 帧序列 / 机器可读报告），不替 Lead 下「视觉通过」结论。

## 被测对象与入口口径（重要）

- 被测：appId=photos 的「照片 / 相册」应用，左栏「图库」「图像工坊」双视图；后端三通道 photos / photocraft / appExchange。
- 本探针现在**同时取证两个渲染入口**，各自独立临时 userData 与 CDP 端口：
  - **react 入口**：设 `OA_UI=react` → `dist/index.html`（electron/main.cjs:192）。跑完整既有套件
    （静态截图 / 组件 / 对比 / 材质 / 动效 / a11y / 卫生 / profile），断言口径与旧基线逐条一致。
  - **默认入口**：**不设** `OA_UI` → `dist/vue.html`（默认 Vue 壳）。appId=photos 由
    `src-vue/shell/WindowLayer.vue` 渲染 `src-vue/apps/PhotosApp.vue`（真实应用），不再是 PlannedApp 占位。
- Vue 壳的 `DOCK_DEFAULT` 里**没有** photos，因此默认入口只能用**真实 UI 路径**打开：
  - 首选：顶栏 `button[aria-label="全局搜索"]` → 搜索面板输入「相册」→ 点 `.search-result`；
  - 备选（同样断言通过）：「应用中心」程序坞 `data-dock-id="home"` → `[data-app-card="photos"]` 卡片。
  - 探针不改产品代码、不直接注入 appId；报告里 `default/entry` 两个断言记录了实际路径。
- 默认入口的专项取证范围：打开路径、真实应用标记（`data-photos-app` / `data-photos-tab` / `data-photos-state`）、
  「PlannedApp 占位特征不存在」、三通道真实调用、关键状态截图（empty/ready × light/dark × 1440x900@2 与 820）、
  逐张实测 `pane-content-overflow`、运行时卫生（console error / pageerror / 非本地请求）。
  组件 clip / 材质三档 / 动效帧序列只在 react 入口跑全量（见 RESULT.md 的覆盖缺口，不当作默认入口通过）。

## 运行

```bash
node experiments/dxos-ui-photos/run-all.mjs                     # 双入口：react 全量 + 默认入口专项
OA_PHOTOS_UI_ENTRY=react node experiments/dxos-ui-photos/run-all.mjs    # 只跑 react 入口
OA_PHOTOS_UI_ENTRY=default node experiments/dxos-ui-photos/run-all.mjs  # 只跑默认入口
OA_PHOTOS_SKIP_DEFAULT_PROBE=1 node experiments/dxos-ui-photos/run-all.mjs
```

退出码：0 = 全部断言通过；1 = 有断言失败；2 = 探针自身异常。非 0 时报告里逐条列出失败。

## 证据落点（artifacts/dxos-ui-photos/）

| 文件 / 目录 | 内容 |
| --- | --- |
| report.json | 全量结构化报告（entries / captures / components / contrast / materials / motion / a11y / dsms / findings / checks） |
| checks.json | 逐条断言（entry / section / name / ok / expected / actual / detail） |
| contrast.json | 每一条文本对比测量的原始数值（含最终合成背景色） |
| dsms.json | DS-A01…A09 / MS-A01…A09 的逐条取证结果 |
| RESULT.md | 人读汇总（双入口事实、默认入口打开路径、pane-content-overflow 实测表、动效对照、覆盖缺口） |
| run.log | 本次运行的完整 stdout（含每条 PASS/FAIL）——由运行者重定向 |
| screens/ | react 入口静态截图 <状态>-<主题>-<尺寸>.png |
| screens-default/ | 默认入口关键状态截图 <状态>-<主题>-<尺寸>.png（empty/ready × light/dark × 1440x900 / 820） |
| default-entry-photos-app.png | 默认入口真实照片应用整窗留证 |
| components/ materials/ motion/ | 组件 clip / 材质三档 / 动效帧序列（react 入口） |

## 方法（与 experiments/dxos-ui-real/run-all.mjs 同口径）

- 真实 electron + 隔离 `--user-data-dir` 临时目录 + 独立 CDP 端口；绝不动真实 profile。
- `Emulation.setDeviceMetricsOverride` 把视图钉到目标尺寸 @dsf2，并**重新最大化真实窗口**让 px 边界跟随新视图；
  每张截图断言像素尺寸。
- 主题 / 减少动态效果 / 材质三档全部走真实设置面板，并校验 `.desktop` 的 dark / reduced / data-glass。
- 数据只经真实桥 `window.openarc.*` 写入：photos/sources/add、photos/folders/create、photocraft/projects/create、
  photocraft/groups/create、appExchange/targets 等。
- DS-A04 对比：把页面文字设为透明后截一张「最终合成背景帧」（玻璃 + 壁纸 + 内容），
  在渲染页里用 canvas 取样每个文本元素的背景色，再按 alpha 合成文字色算 WCAG 比值。
- DS-A09：计算样式扫描（色相 / 饱和度 / 边框宽度与颜色），只给原始事实。
- 动效：`Page.startScreencast`（1x1 心跳元素强制合成器连续出帧）取连续帧，
  页内 rAF 记录被跟踪元素 rect 序列判定布局补间，落盘后用本地最小 PNG 解码器算逐帧像素差。
- pane-content-overflow：逐张在真实 DOM 里量「叶子元素越出所属 pane 且中间没有可滚动祖先」，
  默认入口与 react 入口一样必须实测（Vue 版复用 photos.css 但 DOM 结构不同，不能推断）。
- 收工：杀子进程、删隔离 userData / 临时来源目录，并对真实 profile 做 mtime+size+sha256 只读快照比对。

## 依赖

无新增 npm 依赖。只用仓库既有的 `@playwright/test`（CDP 连接）、`electron`、node 内置模块；
像素差复用了 `experiments/dxos-visual-baseline/lib/pixels.mjs` 的度量口径（本探针另实现零依赖 PNG 解码）。
`lib/pngwrite.mjs` 生成合法 PNG 作为真实照片来源；`lib/pngdecode.mjs` 解码帧做逐帧差。

## 诊断脚本

- `node experiments/dxos-ui-photos/smoke.mjs`：最小冒烟（桥键、照片窗口、来源索引、缩略图、screencast）。
- `node experiments/dxos-ui-photos/measure-narrow.mjs`：窄窗（1180 / 820）三栏骨架实测，
  打印每层包围盒、每栏内容越界（区分「可滚动内容」与「真正溢出」）。

两者都是排查用，不产出交付报告。
