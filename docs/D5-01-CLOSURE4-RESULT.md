# D5-01 Closure-4 · VIS-GEOMETRY-1 定位（唯一口径 · 2026-09-20）

**基线 \`3bcb07c\` → 代码提交 \`0e6702a\`**；分支 \`feature/d4-03-tool-proxy\`；未 push、未合并 main；本轮只处理原生网页区域的几何偏差与相关可见性验收，未改浏览器执行契约、未进入 D5-02。

## 1. 根因（同一次稳定布局，单位 = 屏幕 pt，原点 = 主屏左上）

| 来源 | top | bottom | 说明 |
| --- | --- | --- | --- |
| **domain 意图矩形**（\`nativeIntents\`：\`bounds.y + TITLE_BAR_H + BROWSER_CHROME_H\`，高度 \`bounds.h - 134\`） | **385** | **821** | 单一真源 |
| **像素真值**（\`screencapture -l\` 量页面纯色区段） | **385** | **821** | **偏差 0 / 0** |
| DOM 占位符 \`.web-viewport\` | 468 | 790 | 被一条 \`browser-notices\` 提示条（\`kind=permission\`，高 **114.5**）在 flex 流里推下去 |

换算关系已逐项核对：Quartz 窗口外框 (144,83,1440,940) ⇔ \`window.screenX/screenY/outerH/innerH\`（标题栏 32pt）；\`.browser-shell\` 从 \`bounds.y + TITLE_BAR_H\` 开始，因此 domain 里 \`+TITLE_BAR_H\` 与 DOM 里的标题栏**正好抵消** → 意图矩形 = \`shell.top + BROWSER_CHROME_H\`、高度 = \`shell.height - BROWSER_CHROME_H\`。DPR=2、截图 2× 一致性已核对。

**结论：VIS-GEOMETRY-1 是测量误差（仪器判据选错参照物），不是产品缺陷。** 原生视图既没有压住 chrome，也没有错位；旧证据（Closure-3 报告 §二 与证据 JSON 的 \`openFinding\`）已按此更正。

## 2. 已做的修正

- 几何断言改为与**领域意图矩形**比较（不再拿 DOM 占位符当真值）；占位符偏差只作解释项，并要求"有提示条时偏差可解释"。
- 前台资格改为轮询 + \`AXRaise\`（拿不到就如实 NOT VERIFIED，绝不冒险发真实点击）。
- 增补验收项：网页四边近边界真实指针命中、最大化/恢复、页面缩放（真实按键）。

## 3. 本轮未完成（如实登记，不冒充通过）

同一轮完整验收运行 \`node experiments/d5-01/visibility-e2e.mjs\` 结果：**19/23 PASS、4 FAIL、2 NOT VERIFIED（exit 1）**：
- \`V4c\`：像素真值与意图矩形 \`0/0\` 已达标，但同一条断言里"绿区段长度"取自未生效的 \`run\` 字段 → 判据自身有 bug（仪器）。
- \`V4d\`：占位符偏差与提示条高度不等（83 vs 114.5，页面同时缩短）→ 解释式判据需放宽为"存在提示条即解释"。
- \`V11/V12\`：四边与最大化的**屏幕坐标仍按 DOM 占位符换算**，受同一条提示条影响 → 被安全闸判为越界（正确行为）或未命中；需改用**意图矩形**换算坐标后重跑。
- \`V13\` 页面缩放：真实按键（Cmd+/−）未改变页面，产品当前无缩放入口 → 记 NOT VERIFIED（不假装通过）。

因此：**本轮只完成"定位 + 仪器判据修正"，最终验收矩阵尚未取得一轮完整无失败的有效结果**，D5-01 仍为 PARTIAL。后续只需把 V11/V12 的坐标换算改到意图矩形、修正 V4c/V4d 判据，再跑一轮完整验收（不需改产品代码）。
