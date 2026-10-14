# D1-04 / D2-01 Chromium 硬编码收口报告

> 工作区：`/Users/wepingli/.openarc-worktrees/dxos-port-r1`
> 范围：只改实验探针脚本的浏览器解析来源；未动 `electron/`、`src/`；未联网；未新增依赖；未 git commit。

## 0. 摘要

- 全仓 grep（`chromium-\d+` / `ms-playwright` / `Google Chrome for Testing`）后，仍写死 Playwright chromium 版本目录的**脚本/库共 18 个**：
  17 个 `experiments/d1-04/*.mjs` + 1 个 `experiments/d2-01/lib/ds.mjs`（比背景里估计的"约 15 个"多）。
  另外 `experiments/d1-04/theme-matrix.mjs` 在本次任务开始前就已改用共享解析器（本工作树里未提交），本次未再改动；`docs/*.md` 里对 `chromium-1228` 的引用是历史记录文本，不是脚本，未改。
- 18 个文件全部改为 `import { resolveChromium, describeChromiumCandidates } from ... experiments/lib/chromium.mjs`，命令行、输出格式、断言逻辑一律未动，仅替换 `chromium.launch({ executablePath })` 的来源。
- 每个改过的脚本都在本机离线真实跑过。
- 默认解析结果：`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`（source = `system-google-chrome`，版本 **155.0.8059.41**）。
  原因：本机 Playwright 官方路径解析到 `chromium-1243`，该目录不存在；`OA_CHROMIUM` 未设置 → 按设计回退系统 Chrome。
- 退出码非 0 的有 2 个：`perf-product.mjs`、`ui-audit.mjs`。二者都用旧硬编码二进制（`chromium-1228 -> chromium-1223`，**148.0.7778.96**）复跑对照，结果完全一致 → **与本次改动无关，是既有问题**。

## 1. 文件清单（硬编码行 → 新解析块行）

| 文件 | 改动前硬编码位置 | 改动后：新增 import 行 / 解析块行 |
|---|---|---|
| experiments/d1-04/a11y-check.mjs | 2 | 2 / 3–9 |
| experiments/d1-04/contrast.mjs | 8–10 | 5 / 9–15 |
| experiments/d1-04/contrast2.mjs | 13–15 | 6 / 14–20 |
| experiments/d1-04/glass-switch-stress.mjs | 20–22 | 13 / 21–27 |
| experiments/d1-04/glass-switch.mjs | 13–15 | 7 / 14–20 |
| experiments/d1-04/glass-tiers.mjs | 13–15 | 7 / 14–20 |
| experiments/d1-04/hierarchy.mjs | 12–14 | 5 / 13–19 |
| experiments/d1-04/light-bar-check.mjs | 13–15 | 6 / 14–20 |
| experiments/d1-04/opaque-probe.mjs | 11–13 | 5 / 12–18 |
| experiments/d1-04/opaque-verify.mjs | 10–12 | 4 / 11–17 |
| experiments/d1-04/perf-product.mjs | 50–52 | 43 / 51–57 |
| experiments/d1-04/perf.mjs | 13–15 | 11 / 14–20 |
| experiments/d1-04/perf2.mjs | 22–24 | 16 / 23–29 |
| experiments/d1-04/reduced-color-probe.mjs | 20–22 | 14 / 21–27 |
| experiments/d1-04/reduced-hover-probe.mjs | 22–24 | 16 / 23–29 |
| experiments/d1-04/solid-bar-probe.mjs | 16–18 | 9 / 16–22 |
| experiments/d1-04/ui-audit.mjs | 13–15 | 11 / 14–20 |
| experiments/d2-01/lib/ds.mjs | 18–20 | 12 / 19–21 |

## 2. 统一改法

```js
// 改动前（两种写法）
const EXEC =
  process.env.OA_CHROMIUM ||
  "/Users/wepingli/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
// 或 a11y-check.mjs 的单行写法
const EXEC="/Users/wepingli/Library/Caches/ms-playwright/chromium-1228/.../Google Chrome for Testing";
```

```js
// 改动后（各 d1-04 脚本）
import { resolveChromium, describeChromiumCandidates } from "../lib/chromium.mjs";

// Chromium 解析优先级：OA_CHROMIUM → Playwright 官方 chromium → 系统 Google Chrome（见 experiments/lib/chromium.mjs）。
const CHROMIUM_INFO = resolveChromium();
const EXEC = CHROMIUM_INFO.path;
if (!EXEC) {
  console.error("找不到可用 Chromium，已按优先级尝试：" + describeChromiumCandidates(CHROMIUM_INFO.candidates) + "（设置 OA_CHROMIUM 指向可用二进制）");
  process.exit(1);
}
```

`d2-01/lib/ds.mjs` 是库，`launch()` 原有 `fs.existsSync(CHROMIUM)` 检查保留，仅把导出的 `CHROMIUM` 来源换成 `resolveChromium().path`：

```js
const CHROMIUM_INFO = resolveChromium();
export const CHROMIUM = CHROMIUM_INFO.path;
```

## 3. 真实命令与真实输出

运行环境：`node v22.22.3`；工作目录 `/Users/wepingli/.openarc-worktrees/dxos-port-r1`；
默认解析 `/Applications/Google Chrome.app/...`（155.0.8059.41）；`OA_CHROMIUM=.../chromium-1228/...` 时为 148.0.7778.96。
需要 5210 端口的 4 个脚本，配合 `python3 -m http.server 5210 --directory dist` 运行。

各脚本命令均为 `node experiments/d1-04/<文件名>`（perl alarm 仅作超时兜底）。

| 脚本 | exit code | 关键真实输出 |
|---|---|---|
| a11y-check.mjs | 0 | `打开后 context-menu: 0  menu-shade: 0` / `Cmd+K 后 search-panel: 1` / `Esc 后 search-panel: 0` |
| contrast.mjs | 0 | `Dock 项：[12 项]` / 各应用组件覆盖表 / `light: 导出 5 个元素 -> artifacts/d1-04/coords-light.json` / `dark: ...` |
| contrast2.mjs | 0 | `written contrast-after.json` |
| glass-switch-stress.mjs | 0 | `三者一致（data-glass / storage / select）：63/63 通过` / `p50 16.7ms / p95 16.7ms / max 16.8ms / >33ms 0 帧` / `产物：artifacts/d1-04/glass-switch-stress.json` |
| glass-switch.mjs | 0 | `=== §10 切换往返（走 Settings select）===` 6 步全"矩形不变/同步" / `written glass-switch.json` |
| glass-tiers.mjs | 0 | `=== 三档材质矩阵（真实产品实现）===` 6 格；`REDUCED/SOLID 的 filter=none` |
| hierarchy.mjs | 0 | `written hier-after.json` |
| light-bar-check.mjs | 0 | 完整 JSON（topbar/dock/title 全 `rgba(...,0)`/filter none，window `rgba(...,0.68)` + `blur(34px) saturate(1.8)`） |
| opaque-probe.mjs | 0 | `ok` |
| opaque-verify.mjs | 0 | `ok` |
| **perf-product.mjs** | **1** | 见 3.1 |
| perf.mjs | 0 | `A. FULL ... p50 16.7 p95 16.8` / `C. SOLID ... p50 16.7` / `REDUCED 档位检查：window backdrop=blur(34px) saturate(1.8)` |
| perf2.mjs | 0 | 12 组 `FULL/REDUCED/SOLID × 0/24/72/144` 帧统计；`GPU: ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro)` |
| reduced-color-probe.mjs | 0 | `产物：artifacts/d1-04/reduced-probe.json` + 6 组截图 |
| reduced-hover-probe.mjs | 0 | `产物：artifacts/d1-04/hover-probe.json` + 12 张截图 |
| solid-bar-probe.mjs | 0 | `written solidbar-after.json` |
| **ui-audit.mjs** | **1** | `19/27 checks passed`（8 条 FAIL），见 3.2 |

### 3.1 perf-product.mjs（exit 1，既有问题）

```
node experiments/d1-04/perf-product.mjs
exit code 1
page.click: Timeout 5000ms exceeded.
Call log:
  - waiting for locator('.segmented.text[aria-label="材质"] button:has-text("降低材质")')
    - locator resolved to <button aria-pressed="false">降低材质</button>
  - attempting click action
      - <div class="empty-content" data-d3-04b="unavailable">…</div> from
        <section aria-label="资源库窗口" class="window active " data-window-id="resource-library">…</section>
        subtree intercepts pointer events
```

对照实验（同一脚本、只换回旧硬编码二进制）：

```
OA_CHROMIUM=.../chromium-1228/... node experiments/d1-04/perf-product.mjs
环境：... 148.0.7778.96 148.0.7778.96（非 Electron）...
exit code 1
完全相同的 page.click 超时：资源库窗口拦截了 Settings 的「降低材质」按钮
```

结论：失败发生在"打开设置并点击材质档位"这一步，原因是**当前 dist 里资源库窗口与设置窗口重叠、拦截了指针事件**；换 148 / 155 两个浏览器都复现 → 不是本次改动引入，脚本在改动前也跑不完。

### 3.2 ui-audit.mjs（exit 1，既有断言）

```
node experiments/d1-04/ui-audit.mjs                 -> exit 1, 19/27 checks passed（8 FAIL）
OA_CHROMIUM=.../chromium-1228/... node ...ui-audit.mjs -> exit 1, 19/27 checks passed（8 FAIL）
```

两个二进制的 FAIL 数、PASS 数、结束行完全一致（8 / 19 / "19/27 checks passed"）。
FAIL 项为脚本对 DOM 存在性的期望（ContextMenu / SearchPanel / AIPanel / BrowserContainer / AddressBar / Badge / SettingsRow 默认未打开时命中 0、MS-A02 opacity 归位），属脚本口径与当前实现的差异，非浏览器解析改动引入。未放宽任何断言。

## 4. d2-01 库的验证（因为改了共享 ds.mjs）

`experiments/d2-01/lib/ds.mjs` 被 01–05 全部引用，改动后逐个真实跑过：

| 命令 | exit | 结论 |
|---|---|---|
| `node -e "import('./experiments/d2-01/lib/ds.mjs')...launch()"` | 0 | `CHROMIUM=/Applications/Google Chrome.app/...`，`launched version=155.0.8059.41` |
| `node experiments/d2-01/01-token-contract.mjs` | 0 | 26/26 断言通过，PASS |
| `node experiments/d2-01/02-theme-glass-matrix.mjs` | 0 | 31/31 断言通过，PASS |
| `node experiments/d2-01/03-component-states.mjs` | 0 | 55/55 断言通过，PASS |
| `node experiments/d2-01/04-keyboard-a11y.mjs` | 0 | 32/32 断言通过 + 1 NOT VERIFIED，PARTIAL（脚本自身口径） |
| `node experiments/d2-01/05-motion-matrix.mjs` | 0 | 17/17 断言通过，PASS |

## 5. 未完成 / 未验证项

1. **perf-product.mjs 未跑完**：卡在 UI 指针拦截（资源库窗口挡住设置窗口的材质按钮）。已证明与浏览器解析无关，但**脚本本身在现有 dist 上跑不完**；要让它通过需要修 UI 布局或脚本的窗口管理，超出本波"只换浏览器解析"的范围，未动。
2. **ui-audit.mjs 不是全绿**：19/27，8 条 FAIL 为既有断言差异，已用旧二进制对照确认一致，未放宽断言。
3. **实际使用的浏览器版本变了**：默认解析回退到系统 Chrome **155**，而旧硬编码是 chromium-1228（实际为 **148**）。这是共享解析器既定优先级 + 本机 Playwright 官方 chromium-1243 缺失导致；探针的像素/帧数据若要与历史 D1-04 数据严格同版对比，需显式设置 `OA_CHROMIUM`（解析器支持，已实测生效）。此差异已如实记录，未通过安装浏览器或改解析器优先级来消除。
4. **theme-matrix.mjs 未改**：它在本波开始前就已 import 共享解析器（工作树未提交改动），不属于"仍硬编码"清单。
5. **docs/*.md 里的 chromium-1228 字样保留**：属历史记录，不是脚本。
6. 未删除本机 `~/Library/Caches/ms-playwright/chromium-1228` 软链（仓库外环境，未在本次授权范围内清理）。
7. 未执行 `git commit/push`、未跑 `npm run build` / `npm test`。
