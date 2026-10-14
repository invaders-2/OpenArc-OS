# Dx-UI 视觉回归基线（experiments/dxos-visual-baseline）

给五套 UI 探针（skills / tasks / org / model / mcp）补上**像素级视觉回归基线**：布局或样式一改、
截图就变，超过阈值即 exit 非 0 并输出差异放大图。补齐了"度量对照 + 截图 + 录屏"之外最后一项
UI 验收口径。

- **不联网、不新增依赖**：PNG 解码/编码全部交给本机 Chromium 的 canvas，像素差在浏览器里用
  `getImageData` 算，Node 侧只做阈值判定（复用 `experiments/lib/chromium.mjs`）。
- **不改既有五套探针**：以子进程方式调用它们各自的 `run-all.mjs`，只收集它们写进
  `artifacts/dxos-ui-*/report.json` 的截图。
- **默认阈值**：变化像素比例 < 0.5% **且** 最大通道差 <= 12；超阈即报警。

---

## 1. 文件清单

| 文件 | 作用 |
| --- | --- |
| `run-all.mjs` | 主入口：依次跑五套探针 → 逐张比对 → 判定/report。支持 `--update`、`--probe=<name>` |
| `lib/pixels.mjs` | 纯像素度量（`computeDiffMetrics`）与差异放大图（`renderDiffImage`）；两函数自包含，`toString()` 注入浏览器，同一份代码也被单测直接调用 |
| `lib/verdict.mjs` | 阈值判定、差异分类、缺基准结构化错误、`--update` 写入规划与目录守卫、CLI 参数解析、报告汇总 |
| `lib/probes.mjs` | 五套探针清单 + `--probe` 选择（短名/目录名） |
| `lib/tolerances.mjs` | `tolerances.json` 的加载、校验（必须有 reason）与合并 |
| `tolerances.json` | 逐图阈值覆写与显式隔离清单（每条都带 reason + measured 实测证据） |
| `self-check.mjs` | 自证工具：在基准 PNG 上注入可控差异，用来证明"真的会报警" |
| `baseline/<probe>/<name>.png` | 87 张基准图（5 套探针当前全部截图，24MB） |
| `tests/dxos-visual-baseline.test.mjs` | 纯逻辑单测（29 项） |

产物（`artifacts/` 已在 .gitignore，不进版本库）：
`artifacts/dxos-visual-baseline/report.json`、`.../diff/*.png`、`.../logs/*.log`。

---

## 2. 用法

```bash
node experiments/dxos-visual-baseline/run-all.mjs                  # 比对（默认），全绿 exit 0，超阈 exit 1
node experiments/dxos-visual-baseline/run-all.mjs --update         # 用当前截图刷新 baseline，并打印更新清单
node experiments/dxos-visual-baseline/run-all.mjs --probe=skills   # 只跑单套（也认目录名 dxos-ui-skills）
node experiments/dxos-visual-baseline/run-all.mjs --probe=mcp --update
node --test tests/dxos-visual-baseline.test.mjs                    # 纯逻辑单测
```

比对流程：跑探针 → 读它的 `report.json.screenshots`（只取本轮新写、mtime 晚于本次启动的文件）→
逐张与 `baseline/<probe>/<name>.png` 比对 → 判阈值 → 生成 `report.json`。
某张找不到基准图时是**结构化失败**（`BASELINE_MISSING`，带 --update 提示），绝不静默通过。

---

## 3. 阈值口径与逐图覆写

- `changedRatioMax`：变化像素比例（变化像素 / 总像素），默认 **0.005**，口径是**严格小于**（恰好 0.5% 判失败）。
- `maxChannelDiffMax`：全图最大单通道差，默认 **12**，口径是 **<=**。
- `pixelTolerance`：单像素最大通道差 > 该值才算"变化像素"，默认 **0**。

实测发现 7 张截图本身不稳定，且不稳定原因与视觉回归无关。为避免把"时间在变/栅格化抖动"
当成回归，`tolerances.json` 做了**逐张、有理由、有实测证据**的处理；`run-all.mjs` 会在
控制台用 `*` 标记被覆写的帧、用 `[EXCL]` 标记被隔离的帧，`report.json` 里逐张记录
`thresholdOverride` / `exclusion`：

| 帧 | 处理 | 原因（`tolerances.json.reason` 摘要） | 实测 |
| --- | --- | --- | --- |
| `skills/compare-dark-skill.png` | `pixelTolerance=4` | 深色主题整页 ±1~2 级栅格化抖动，包围盒满图但最大差只有 2 | 比例 36.43%，最大差 2 |
| `skills/compare-dark-mcp.png` | `pixelTolerance=4` | 同上（McpCenter 侧） | 比例 1.23%，最大差 1 |
| `model/09-streaming.png` | `maxChannelDiffMax=160` | 流式行里的**实时挂钟时间戳**跨秒，变化的只是那几位数字 | 比例 0.13%，最大差 142 |
| `model/10-stream-error.png` | `maxChannelDiffMax=160` | 同上 | 比例 0.06%，最大差 142 |
| `model/11-cancelling.png` | **`exclude=true`（隔离，不纳入判定）** | 取消中状态有滚动/布局竞态：流式行数不定会让正文整体纵向位移（对比图里同一段文案上下重影） | 7 次比较中 6 次 <0.05%，1 次 12.28% |
| `model/12-cancelled-settled.png` | `maxChannelDiffMax=160` | 同 09，时间戳跨秒 | 比例 0.16%，最大差 142 |

> 被隔离的 `model/11-cancelling.png` **没有视觉回归保护**：它仍会被测量、数值会进 report、
> 控制台会显式打印 `[EXCL]`，但不会让整轮失败。这是已知限制，不是静默放行。

---

## 4. 自证有效（真实命令 + 真实输出）

### 4.1 故意改少量像素 → 报警、exit 1

```console
$ cp experiments/dxos-visual-baseline/baseline/org/07-ready.png /tmp/org-07-ready.bak.png
$ shasum -a 256 experiments/dxos-visual-baseline/baseline/org/07-ready.png
7e954eb79502adc9c7a8152ca06fa4b9c872348454db4d00b1944974d3eabe10  .../baseline/org/07-ready.png
$ node experiments/dxos-visual-baseline/self-check.mjs experiments/dxos-visual-baseline/baseline/org/07-ready.png block
mutated experiments/dxos-visual-baseline/baseline/org/07-ready.png mode=block
$ node experiments/dxos-visual-baseline/run-all.mjs --probe=org
  [FAIL] org/07-ready.png  比例=0.0309%  最大差=255  均值差=0.03867  bbox=0,200 240×1576  分类=widespread-change
         · 最大通道差 255 超过阈值 12
         · 差异放大图：artifacts/dxos-visual-baseline/diff/org__07-ready.png
视觉回归结论：FAIL — {"verdict":"FAIL","total":12,"passed":11,"failed":1,"excluded":0}
EXIT=1
```

> 40×40 红块只占 0.031%（低于 0.5%），所以是被**最大通道差**条款抓住。

### 4.2 恢复基准 → 全绿、exit 0

```console
$ cp /tmp/org-07-ready.bak.png experiments/dxos-visual-baseline/baseline/org/07-ready.png
$ shasum -a 256 experiments/dxos-visual-baseline/baseline/org/07-ready.png /tmp/org-07-ready.bak.png
7e954eb79502adc9c7a8152ca06fa4b9c872348454db4d00b1944974d3eabe10  .../baseline/org/07-ready.png
7e954eb79502adc9c7a8152ca06fa4b9c872348454db4d00b1944974d3eabe10  /tmp/org-07-ready.bak.png
$ node experiments/dxos-visual-baseline/run-all.mjs --probe=org
视觉回归结论：PASS — {"verdict":"PASS","total":12,"passed":12,"failed":0,"excluded":0}
GREEN_EXIT=0
```

### 4.3 追加：整宽横带 → 触发"变化像素比例"条款

```console
$ node experiments/dxos-visual-baseline/self-check.mjs experiments/dxos-visual-baseline/baseline/org/07-ready.png band
mutated experiments/dxos-visual-baseline/baseline/org/07-ready.png mode=band
$ node experiments/dxos-visual-baseline/run-all.mjs --probe=org
  [FAIL] org/07-ready.png  比例=3.3333%  最大差=255  均值差=4.14920  bbox=0,900 2880×60  分类=localized-change
         · 变化像素比例 3.3333% 不低于阈值 0.5000%
         · 最大通道差 255 超过阈值 12
         · 差异放大图：artifacts/dxos-visual-baseline/diff/org__07-ready.png
视觉回归结论：FAIL — {"verdict":"FAIL","total":12,"passed":11,"failed":1,"excluded":0}
BAND_EXIT=1
```

两条阈值条款都经过了真实端到端验证；恢复后截图与基准逐字节一致（哈希相同）。

---

## 5. 验收（真实命令 + 真实输出）

### 5.1 `node --test tests/dxos-visual-baseline.test.mjs`

```console
1..29
# tests 29
# suites 0
# pass 29
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 106.846541
```

覆盖：像素度量数学（相同/单点/多点包围盒/容差/非法输入）、注入源码自包含、阈值边界
（比例恰好 0.5% 判失败、最大差 12 通过 13 失败、双超限两条 reason）、差异分类（identical /
within-threshold / localized / widespread）、baseline 缺失的结构化报错与整体 FAIL、
`--update` 只写 baseline 目录（目标全部落在 `baseline/<probe>/`，越界抛错）、
`--probe` 短名/目录名/未知名、显式隔离帧的汇总口径、tolerances 校验（必须有 reason）。

### 5.2 `node experiments/dxos-visual-baseline/run-all.mjs`

```console
UI 视觉回归基线 · dxos-visual-baseline
模式：compare    探针：skills, tasks, org, model, mcp
默认阈值：变化像素比例 < 0.5000% 且 最大通道差 <= 12
逐图阈值覆写：5 张，显式隔离：1 张（experiments/dxos-visual-baseline/tolerances.json，报告里逐张标注理由）
浏览器候选：/Applications/Google Chrome.app/Contents/MacOS/Google Chrome（source=system-google-chrome）

[探针] dxos-ui-skills（Skill 中心）运行中 … OK  退出码=0  截图=24  用时=57.8s
[探针] dxos-ui-tasks（任务 / Agent 控制台）运行中 … OK  退出码=0  截图=17  用时=42.8s
[探针] dxos-ui-org（组织治理控制台）运行中 … OK  退出码=0  截图=12  用时=30.3s
[探针] dxos-ui-model（模型接入控制台）运行中 … OK  退出码=0  截图=19  用时=62.2s
[探针] dxos-ui-mcp（MCP 中心）运行中 … OK  退出码=0  截图=15  用时=25.8s

逐图判定（默认阈值：比例 < 0.5000%，最大差 <= 12；带 * 的帧用了 tolerances.json 覆写）：
  [PASS] skills/01-loading.png  比例=0.0000%  最大差=0  均值差=0.00000  bbox=—  分类=identical
  ...（其余 80 条 PASS 为 0 差异，完整 87 行见 artifacts/dxos-visual-baseline/report.json）
  [PASS]*skills/compare-dark-skill.png  比例=0.0000%  最大差=2  均值差=0.27323  bbox=—  分类=within-threshold  [覆写 pixelTolerance]
  [PASS]*skills/compare-dark-mcp.png  比例=0.0000%  最大差=0  均值差=0.00000  bbox=—  分类=identical  [覆写 pixelTolerance]
  [PASS]*model/09-streaming.png  比例=0.1420%  最大差=142  均值差=0.06575  bbox=1317,769 1510×652  分类=within-threshold  [覆写 maxChannelDiffMax]
  [PASS]*model/10-stream-error.png  比例=0.0589%  最大差=142  均值差=0.02602  bbox=1276,769 1551×534  分类=within-threshold  [覆写 maxChannelDiffMax]
  [EXCL] model/11-cancelling.png  比例=0.0456%  最大差=142  均值差=0.02210  bbox=1339,769 1488×352  （实测不稳定，不纳入判定：见 tolerances.json）
  [PASS]*model/12-cancelled-settled.png  比例=0.1686%  最大差=142  均值差=0.09128  bbox=1307,769 1520×960  分类=within-threshold  [覆写 maxChannelDiffMax]

════════════════════════════════════════════════════════════════════════
视觉回归结论：PASS — {"verdict":"PASS","total":87,"passed":86,"failed":0,"excluded":1}
报告：artifacts/dxos-visual-baseline/report.json
EXIT=0
```

`report.json` 每张图记录：`probe/name`、基准与当前路径、`status`、`kind`、`metrics`
（`changedRatio` / `maxChannelDiff` / `meanChannelDiff` / `bbox` / `width` / `height`）、
生效 `thresholds` 与 `defaultThresholds`、`thresholdOverride` / `exclusion`；顶层记录默认阈值、
tolerances 文件、浏览器来源（路径 + source + 候选清单）、每个探针的退出码/截图数/日志路径。

---

## 6. baseline 已纳入版本控制

`experiments/` 不在 .gitignore，基准 PNG 可被 git 跟踪（`artifacts/` 被忽略，所以差异图和日志不进库）：

```console
$ git status --porcelain -uall experiments/dxos-visual-baseline | awk '{print $1}' | sort | uniq -c
  95 ??
$ git status --porcelain -uall experiments/dxos-visual-baseline/baseline/org/07-ready.png
?? experiments/dxos-visual-baseline/baseline/org/07-ready.png
$ git check-ignore -v experiments/dxos-visual-baseline/baseline/org/07-ready.png || echo "(未被忽略)"
(未被忽略)
```

95 个 `??` = 87 张基准 PNG + run-all.mjs + self-check.mjs + tolerances.json + README.md + lib 下 4 个模块
（单测文件 `tests/dxos-visual-baseline.test.mjs` 同样 untracked）。
**未执行 `git add`/`git commit`**（任务禁止 commit/push），文件保持 untracked，可直接纳入后续提交。

---

## 7. 未完成 / 未验证项 / 已知限制

1. **`model/11-cancelling.png` 无回归保护**：该帧拍摄"取消中"状态时流式行数不定、正文会整体位移，
   实测约 1/5 的运行换一种排版。已显式隔离（`exclude=true`，带 reason + measured），
   仍测量、仍进报告、控制台显式 `[EXCL]`，但不会让整轮失败。要真正保护它需要改探针
   （等状态稳定后再截图），本轮硬约束不允许改既有探针脚本。
2. **`model/09-12` 的时间戳帧放宽了最大通道差到 160**：真实小范围改动若最大通道差 ≤160 且面积
   <0.5% 会漏过；面积 >=0.5% 的改动仍会被比例条款抓住。放宽幅度与实测值记录在 tolerances.json。
3. **深色对照帧放宽了 pixelTolerance 到 4**：≤4 级的真实变化不计入变化像素；>4 级仍计入，
   且最大通道差仍受默认 12 约束。
4. **基准图 24MB / 87 张**：全部截图都纳入，未做裁剪或压缩；后续若仓库体积敏感，可只保留每套探针的
   代表性状态。
5. **浏览器来源**：本机 Playwright 官方 chromium 未安装，实际用系统 Google Chrome
   （`experiments/lib/chromium.mjs` 的既定优先级）；换浏览器/字体/缩放可能整批变红，这是环境差异不是回归。
6. **动画帧天然不稳定**：只对已知的 7 帧做了实测处理；未做全量多轮采样统计，其他帧若偶发不稳定，
   会在某次运行里报红——这正是探针该有的行为，届时按同样格式在 tolerances.json 登记理由。
7. **本轮未跑**：`npm run build` / `npm test`（任务禁止）；未改 CSP、tokens.css、既有五套探针脚本；
   未联网。
