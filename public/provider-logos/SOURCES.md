# Provider 品牌 Logo 来源与许可记录

- 拉取日期：2026-10-16
- 拉取工具：`curl`（静态资源下载，未安装任何 npm 包，未改动仓库依赖）
- 主源：`@lobehub/icons-static-svg@latest`（实际解析版本 **1.95.1**，许可 **MIT**）
- 备源：`simple-icons@latest`（许可 CC0-1.0）——本批所有命中品牌主源均已覆盖，最终未采用备源文件
- 安全处理：所有 SVG 统一删除固定 `width`/`height`（改由 CSS 控制尺寸）与内联 `style`；保留 `viewBox`；清除 `<script>`、`<foreignObject>`、`on*` 事件属性、`javascript:`、`<image>` 及任何 `http(s)://` 外部引用；单色图标保留根节点 `fill="currentColor"` 语义（`fill-opacity` 为同色透明度，非写死颜色）。
- 校验：逐文件检查「含 `<svg`」且「含 `viewBox`」，并确认无脚本/外链/固定宽高，全部通过；无文件被删除。
- 商标声明：以下标志均为各自公司/项目的商标或注册商标，此处仅用于在界面中**识别对应服务**，不表示任何授权、合作或背书。

## 已下载（13）

| 品牌 | 文件名 | 源 URL | 许可 | 拉取日期 | 是否商标 |
| --- | --- | --- | --- | --- | --- |
| ollama | ollama.svg | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/ollama.svg | MIT | 2026-10-16 | 是（仅用于识别品牌，不代表授权/背书） |
| openai | openai.svg | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/openai.svg | MIT | 2026-10-16 | 是（仅用于识别品牌，不代表授权/背书） |
| google-gemini | google-gemini.svg | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/gemini.svg | MIT | 2026-10-16 | 是（仅用于识别品牌，不代表授权/背书） |
| claude | claude.svg | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/claude.svg | MIT | 2026-10-16 | 是（仅用于识别品牌，不代表授权/背书） |
| xai | xai.svg | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/xai.svg | MIT | 2026-10-16 | 是（仅用于识别品牌，不代表授权/背书） |
| minimax | minimax.svg | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/minimax.svg | MIT | 2026-10-16 | 是（仅用于识别品牌，不代表授权/背书） |
| aliyun-bailian | aliyun-bailian.svg | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/bailian.svg | MIT | 2026-10-16 | 是（仅用于识别品牌，不代表授权/背书） |
| modelscope | modelscope.svg | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/modelscope.svg | MIT | 2026-10-16 | 是（仅用于识别品牌，不代表授权/背书） |
| volcengine | volcengine.svg | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/volcengine.svg | MIT | 2026-10-16 | 是（仅用于识别品牌，不代表授权/背书） |
| agnes | agnes.svg | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/agnesai.svg | MIT | 2026-10-16 | 是（仅用于识别品牌，不代表授权/背书） |
| jimeng | jimeng.svg | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/jimeng.svg | MIT | 2026-10-16 | 是（仅用于识别品牌，不代表授权/背书） |
| deepseek | deepseek.svg | https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/deepseek.svg | MIT | 2026-10-16 | 是（仅用于识别品牌，不代表授权/背书） |
| lovart | lovart.svg | https://raw.githubusercontent.com/lovartai/lovart-skill/main/assets/lovart-icon.svg | MIT（官方仓库 lovartai/lovart-skill） | 2026-10-16 | 是（仅用于识别品牌，不代表授权/背书） |

补充（lovart）：取自官方仓库 `lovartai/lovart-skill`（MIT）的 `assets/lovart-icon.svg`。同仓库另有
`assets/lovart-icon-dark.svg`，两者图形路径**完全相同**、只有写死的 `fill`（#ffffff / #1a1a1a）不同；
按上面的安全处理统一改成 `currentColor` 后是同一枚 mark，因此按既有 12 个品牌的写法只落一个文件
（单色 SVG 走 CSS mask 跟随主题文字色，不需要亮/暗两版）。

## 未找到，未下载（6）

两个源（lobe 与 simple-icons）均未命中，按要求**如实不下载**，界面回退首字母；未使用相近品牌图形冒充。

| 品牌 | 文件名 | 本仓 providerId 前缀（建议） | 说明 | 前端表现 |
| --- | --- | --- | --- | --- |
| runninghub | — | runninghub / runninghub-http | 两个源均无对应 slug（lobe 404 / simple-icons 404） | 回退首字母 |
| fhl | — | fhl / fhl-http | 两个源均无对应 slug | 回退首字母 |
| agtoken | — | agtoken / agtoken-http / agtoken-video | 两个源均无对应 slug | 回退首字母 |
| zkki | — | zkki / zkki-http / zkki-model | 两个源均无对应 slug | 回退首字母 |
| apimart | — | apimart / apimart-http / apimart-gemini / apimart-claude / apimart-media | 两个源均无对应 slug | 回退首字母 |
| pippit | — | pippit / cli:pippit | 两个源均无对应 slug（未用相近品牌冒充） | 回退首字母 |

## 已探测但未采用的相关 slug（留痕）

- `lobe`：`dreamina` 404、`pippit` 404、`runninghub` 404、`agnes` 404（实际命中 slug 为 `agnesai`）、`aliyun-bailian` 404（实际命中 slug 为 `bailian`）、`fhl` 404、`agtoken` 404、`zkki` 404、`apimart` 404。
- `simple-icons`：`volcengine` 404、`zhipu` 404、`moonshot` 404、`dreamina` 404、`jimeng` 404、`fhl` 404、`agtoken` 404、`zkki` 404、`apimart` 404、`pippit` 404、`runninghub` 404。
- 品牌 xai 在 lobe 的 `xai` slug 图形标题为 `Grok`（xAI 的 Grok 标记），本仓 xai / grok / grok2api 共用该图形。

## 复现命令

```bash
curl -sS -L -A 'Mozilla/5.0' -o public/provider-logos/openai.svg \
  'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/openai.svg'
```

其余文件将 slug 替换为：openai, gemini, claude, xai, minimax, bailian, modelscope, volcengine, agnesai, jimeng, ollama, deepseek。

补充：deepseek.svg 于 2026-10-16 从同一源补抓（CDN 当前不稳，第 3 次重试才成功，间隔 4s）；同样按上面的安全处理去除固定 width/height 与内联 style，保留 viewBox 0 0 24 24 与根节点 fill="currentColor"。
