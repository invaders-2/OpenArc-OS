# 第三方组件、图标与商标说明

OpenArc OS 本身以 AGPL-3.0-only 发布（见 [LICENSE](LICENSE)）。下面列出随软件分发的第三方内容及其各自的许可。
各组件仍受其原许可证约束；本文件不改变它们的许可。

## 应用图标（GPL-3.0）

`public/icons/` 下的应用图标（`siri.png` 除外）取自 **WhiteSur icon theme**（作者 Vince Liuice），
许可为 **GPL-3.0**，全文见 [public/icons/LICENSE-WhiteSur.txt](public/icons/LICENSE-WhiteSur.txt)，
来源与逐个文件的对应关系见 [public/icons/ICONS-SOURCE.md](public/icons/ICONS-SOURCE.md)。
GPL-3.0 与本项目的 AGPL-3.0 兼容（AGPL-3.0 第 13 条）。

> ⚠️ `public/icons/siri.png` 是从 macOS 中提取的图片，**不在任何开源许可下，不得随软件分发**；正式发布前必须替换。

## 服务商品牌标志（商标）

`public/provider-logos/` 下的 SVG 文件来自 `@lobehub/icons-static-svg`（MIT）。这些标志是各自公司或项目的商标 / 注册商标，
OpenArc OS 仅用于在界面中**识别对应的模型服务**，不表示任何授权、合作或背书。详见
[public/provider-logos/SOURCES.md](public/provider-logos/SOURCES.md)。

## 画布内置的浏览器端库（`public/novai-canvas/`）

| 组件 | 许可 |
| --- | --- |
| three.js 0.160.0 | MIT |
| html-to-image | MIT |
| Tailwind CSS（CDN 构建） | MIT |
| Lucide 图标（子集） | ISC |
| ag-psd（无损改图工具） | MIT |

`public/novai-canvas/` 来自版权所有者自己的项目 NOVAI Infinite Canvas，来源记录见
[public/novai-canvas/SOURCE.md](public/novai-canvas/SOURCE.md)。

## 运行时框架

| 组件 | 许可 |
| --- | --- |
| Electron 44.3.0（桌面版打包的运行时，含 Chromium 与 Node.js） | MIT（内含组件的许可随 Electron 发行包附带） |

## npm 生产依赖

以下由 `package-lock.json` 生成（不含仅开发时使用的依赖）。全部为宽松许可（MIT / ISC / BSD / Apache-2.0）。

| 包 | 版本 | 许可 |
| --- | --- | --- |
| @babel/helper-string-parser | 7.29.7 | MIT |
| @babel/helper-validator-identifier | 7.29.7 | MIT |
| @babel/parser | 7.29.8 | MIT |
| @babel/types | 7.29.8 | MIT |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT |
| @vue/compiler-core | 3.5.40 | MIT |
| @vue/compiler-dom | 3.5.40 | MIT |
| @vue/compiler-sfc | 3.5.40 | MIT |
| @vue/compiler-ssr | 3.5.40 | MIT |
| @vue/devtools-api | 6.6.4 | MIT |
| @vue/reactivity | 3.5.40 | MIT |
| @vue/runtime-core | 3.5.40 | MIT |
| @vue/runtime-dom | 3.5.40 | MIT |
| @vue/server-renderer | 3.5.40 | MIT |
| @vue/shared | 3.5.40 | MIT |
| csstype | 3.2.3 | MIT |
| entities | 7.0.1 | BSD-2-Clause |
| estree-walker | 2.0.2 | MIT |
| framer-motion | 13.2.0 | MIT |
| lucide-react | 0.468.0 | ISC |
| lucide-vue-next | 0.468.0 | ISC |
| magic-string | 0.30.21 | MIT |
| motion | 13.2.0 | MIT |
| motion-dom | 13.2.0 | MIT |
| motion-utils | 13.0.0 | MIT |
| nanoid | 3.3.18 | MIT |
| orb-ui | 0.8.0 | MIT |
| picocolors | 1.1.1 | ISC |
| pinia | 2.3.1 | MIT |
| postcss | 8.5.28 | MIT |
| react | 19.3.0 | MIT |
| react-dom | 19.3.0 | MIT |
| scheduler | 0.28.0 | MIT |
| source-map-js | 1.2.1 | BSD-3-Clause |
| three | 0.186.1 | MIT |
| tslib | 2.8.1 | 0BSD |
| typescript | 5.9.3 | Apache-2.0 |
| vue | 3.5.40 | MIT |
| vue-demi | 0.14.10 | MIT |

## 设计参考

界面交互参考了 TapNow 等产品的公开使用体验；仓库中不包含这些产品的代码、图片或其他素材。
