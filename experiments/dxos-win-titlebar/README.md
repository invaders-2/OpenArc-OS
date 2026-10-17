# dxos-win-titlebar · Windows 自绘 caption 真机验收

方案 B（自绘 Windows 风 caption，46×38 满高）的**真实 Electron 验收**：
真启动 `electron/main.cjs` + `preload.cjs` + `dist/vue.html`，隔离 userData、唯一 CDP 端口，
经真实产品桥完成首启与登录，然后点真按钮、读主进程状态、截图。

## 怎么跑

```bash
npm run build                                         # 主进程加载 dist/vue.html
node experiments/dxos-win-titlebar/run.mjs            # 三个 phase 全跑（约 40s）
```

单跑某一 phase（截图与 report 会被本次运行覆盖）：

```bash
node experiments/dxos-win-titlebar/run.mjs --phase=win32      # Windows 布局 + 最大化 + 关闭
node experiments/dxos-win-titlebar/run.mjs --phase=minimize   # 独立启动：最小化
node experiments/dxos-win-titlebar/run.mjs --phase=darwin     # 真实 macOS 零回归
```

### 平台覆盖（仅测试）

```bash
# 在 macOS 上渲染 Windows 窗口 chrome：窗口按 Windows 分支创建（frame:false，无红绿灯）
OA_FORCE_PLATFORM=win32 npm run ...        # 由本脚本自动设置，不需要手动
# 反向（Windows 上渲染 macOS chrome）同理：OA_FORCE_PLATFORM=darwin
```

只认 `win32` / `darwin` 两个字面值；不设置时等于 `process.platform`（生产默认路径）。
它只改「窗口 chrome + `system.info()` 上报的 platform」，不改应用菜单角色与玻璃材质。
主进程会打印 `[openarc] OA_FORCE_PLATFORM=…（仅测试用平台覆盖）`。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `OA_WIN_TITLEBAR_CDP_PORT` | 固定 CDP 端口（默认每次挑空闲端口） |
| `ELECTRON_EXTRA_ARGS` | 追加 electron 启动参数（如无沙箱环境传 `--no-sandbox --disable-gpu-sandbox --in-process-gpu`） |

脚本会从子进程环境里删掉 `ELECTRON_RUN_AS_NODE`（本机 shell 有这个变量，带进去会让 electron 以纯 Node 启动）。
不联网、不改真实 profile（userData 走 `mkdtemp`）、不 commit。

## 三个 phase 各证明什么

| phase | 断言（全部来自真实进程） |
| --- | --- |
| win32-screens | 3 枚按钮 46×38；贴右上角（close.right = innerWidth、y = 0）；左侧 16px 起；右侧入口整体左移（right.right = innerWidth−147）；hover 6%；close hover `rgb(196,43,28)` + 白字形；Tab 可达 + 2px 焦点环；点最大化 → 主进程 `isMaximized()=true` 且图标切「还原」→ 再点还原；减少动态下 transition 0s；点关闭 → 进程 exit 0 + 主进程日志 |
| win32-minimize | 点最小化 → 主进程 `isMinimized()=true`（窗口不可见）；再经同一条 close 路径干净退出 |
| darwin | 0 枚自绘按钮、无 `.topbar-caption`、无 `is-win`；padding-left 92px、menus.left 84、right.right = innerWidth−23、顶栏 38px；浅/深截图 |

## 产物

- `artifacts/dxos-win-titlebar/shots/`：浅/深、常态/最大化/close hover/焦点、左右裁切；
- `artifacts/dxos-win-titlebar/report.json`：逐项断言（expected / actual）+ 主进程日志尾部；
- `artifacts/dxos-win-titlebar/manifest.json`：每张图的 CSS 尺寸、像素尺寸、字节数、sha256；
- `artifacts/dxos-win-titlebar/baseline/`：改动前（HEAD `3775868`，独立 worktree 构建）的 darwin 截图；
- `artifacts/dxos-win-titlebar/baseline-compare.json`：改动前后 darwin 顶栏的逐像素差异。

## 局限（必须知道）

1. **截图只含 WebContents**：macOS 红绿灯、Windows 原生窗口阴影都由系统绘制，Playwright 截不到。
   darwin 零回归的证据是「窗口选项逐字未变（`titleBarStyle:"hidden"` + `trafficLightPosition:{x:20,y:12}`）
   + DOM/CSS 未变 + 逐像素对照」，不假装截到了红绿灯。
2. `OA_FORCE_PLATFORM=win32` 在 macOS 上只是**chrome 模拟**：窗口确实按 Windows 分支创建（无红绿灯），
   但 Snap Layouts / 双击顶栏最大化 / 贴边仍是宿主 OS 行为，不能在本机验证。
3. 关闭 phase 依赖 `window-all-closed → app.quit()`；退出收尾有 3 秒保险丝，断言给了 25 秒上限。
