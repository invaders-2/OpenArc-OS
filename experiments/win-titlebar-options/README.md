# experiments/win-titlebar-options

Windows 标题栏候选方案的**纯静态示意图**渲染器。只出方案，不改产品代码。

方案正文在 [`artifacts/win-titlebar-options/OPTIONS.md`](../../artifacts/win-titlebar-options/OPTIONS.md)。

## 跑

```bash
# 仓库根目录
node experiments/win-titlebar-options/render.mjs
```

无需构建、无需安装依赖、不需要 dev server。用的是仓库已装的 Playwright（`package.json` devDependencies），
Chromium 解析复用 `experiments/lib/chromium.mjs`（`OA_CHROMIUM` → Playwright 官方 chromium → 系统 Google Chrome），
启动时会打印实际选中的二进制。可用 `OA_CHROMIUM=/path/to/chrome node experiments/win-titlebar-options/render.mjs` 指定。

产物写到 `artifacts/win-titlebar-options/shots/`（12 张 PNG + `manifest.json`，含每张图的真实像素尺寸）。

## 目录

```
render.mjs        渲染器：四个方案 × 浅/深、caption 状态细节图、四方案对照图、manifest
mock/
  index.html      ?option=A|B|C|D&theme=light|dark[&mode=states]
  mock.css        只读复刻 src/design-system/tokens.css 与 src/styles.css 的顶栏规则，
                  再加 Windows 侧数值（标题栏 32px、caption 46×32、close hover #c42b1c）
  mock.js         四个方案的 DOM 构造（lucide 图标路径取自 node_modules/lucide-vue-next）
  app-icon.png    build/icon.icns 用 sips -Z 128 导出的应用图标（系统标题栏用）
  siri.png        从 public/icons/siri.png 复制（顶栏 AI 球）
```

## 口径

- 视口 1280×800、`deviceScaleFactor=2`，只 clip 顶部：A = 168px（32 系统标题栏 + 22 菜单栏 + 38 应用顶栏 + 76），B/C/D = 118px（38 + 80）。
- 静态 mock 不导入产品代码、不发请求、不执行产品逻辑；壁纸渐变、顶栏规则、字色、圆角、时长都从产品文件**只读复制**。
- 字体用 `DESIGN_SYSTEM.md` §5 的字体栈：在 macOS 上解析为 SF Pro / 苹方，Windows 实机会落到 Microsoft YaHei UI，字宽会有出入。
- 图里的说明胶囊与红色虚线框是**示意图标注**，不是产品 UI。
- Windows 侧数值（caption 46×32、close hover `#c42b1c`、系统标题栏 32px）是 Windows 11 公开口径的近似；
  相关原生行为（双击最大化、Snap Layouts、mica 外观）**没有实机证据**，见 OPTIONS.md §4。
