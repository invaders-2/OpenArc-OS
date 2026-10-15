# Dx UI 真机对照 · 对照源体检（不再被陈旧产物误导）

> 范围：只改探针 `experiments/dxos-ui-real/run-all.mjs`，不改产品代码、不新增依赖、不联网、未 commit / push、未跑 npm run build / npm test。
> 背景：C2「列表行高逐项记录并归因」此前失败，根因是它读的 `artifacts/dxos-ui-skills/report.json` / `artifacts/dxos-ui-model/report.json` 缺失，`compare.metrics` 为 null，而不是真实回归。旧代码在 report 读不到时只把 metric 置 null，既不报错也不补跑，于是把「对照源不可用」误报成「度量不一致」（而且 C1 在无可比项时是空断言，会静默通过）。

## 1. 文件清单

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `experiments/dxos-ui-real/run-all.mjs` | **修改（唯一源码改动，+273 / −23）** | 启动时对照源体检 / 默认自动补齐 / 明确失败指引 / 报告标注来源与指纹 / C1 非空断言 |
| `artifacts/dxos-ui-real/preflight.json` | 新增（运行产物，gitignore） | 本次对照源体检快照；**成功与失败都写**，避免上一次失败快照被误读成当前状态 |
| `artifacts/dxos-ui-real/report.json` | 运行产物 | 新增 `chromiumCompare.preflight`（`originByPage` / `reports` / `ranProbes` / `initialStale`） |
| `artifacts/dxos-ui-real/compare-notes.md` | 运行产物 | 新增「## 0.5 对照源体检（新跑 / 复用）」表；每页来源行加「本次复用/新跑 + 时间 + sha256」 |
| `artifacts/dxos-ui-real/preflight-selftest/*.log` | 新增（自检证据，gitignore） | 场景 A / B / C 的完整真实输出，另含两次环境抖动运行的原始日志 |
| `docs/dxos-port/Dx-UI-REAL-CMP-PREFLIGHT.md` | 新增（本报告） | 交付说明 |

> 注：本工作树是**共享**的，本轮会话期间有并发改动（例如 `tests/fixtures/governance-ui-probe/main.cjs` 的选择器从 `data-app-id` / `data-d3-04d-*` 换成 `data-dock-id` / `data-org-*`；随后 `electron/automation-*.cjs`、`electron/identity-bootstrap.cjs`、`electron/main.cjs`、`electron/resource-bootstrap.cjs`、新增 `src/governance/filesLibraryActions.ts` 等也出现在 git status）。这些**都不是本任务改的**，本任务只改 `experiments/dxos-ui-real/run-all.mjs` 与本报告；并发改动一律原样保留、未回滚。真机探针渲染源是 14:33 冻结的 `dist/index.html`，并发改 `src` / `electron` 不改变本次对照度量，但会带来运行期抖动（见 §4 第 5 条）。

## 2. 改动要点（只改探针）

1. **启动时校验对照源**（在启动真实 electron 之前，`ensureChromiumSources`）。对 4 个 report（供给 skills+mcp / tasks / org / model 五个页面）检查：
   - **存在且可解析**：文件存在、JSON 可解析；
   - **有生成时间戳**：`finishedAt` / `generatedAt` / `reportAt` / `at` 至少一个非空；
   - **必备度量路径齐备**：`compare.metrics.<key>` 里必须能取到 `row.height`、`rowNameStyle.font-size`、`rowFactsStyle.font-size`（skills/mcp/tasks/org 还要求 `titleStyle.font-size`；model 探针落盘键名是 `blockTitleStyle`、不产出 `titleStyle`，故不要求）。任何一条缺失即判该对照源不可用；
   - **不比产出它的探针源码旧**：`report.json` mtime >= 该探针 `run-all.mjs` + `harness.tsx` 的最新 mtime。
2. **缺失 / 陈旧时的默认动作：自动串行补齐**。按既定顺序跑对应 Chromium 探针（`dxos-ui-skills` → `dxos-ui-tasks` → `dxos-ui-org` → `dxos-ui-model`），每个探针用 `freePort()` 拿一个**唯一空闲端口**（`OA_SKILLS_PORT` / `OA_TASKS_PORT` / `OA_ORG_PORT` / `OA_MODEL_PORT`），一次一个、串行执行，避免与其它探针并行冲突；单个探针上限 `OA_UI_REAL_CMP_TIMEOUT_MS`（默认 60 分钟）。
3. **另一种合法模式（`OA_UI_REAL_CMP_AUTOFILL=0`）：明确失败并给可执行指引**，exit 3，并写 `preflight.json`；不会启动 electron、不会写半份 report。
4. **绝不放宽 / 跳过对照**：对照源不可用时 `Q4` 记 FAIL 并直接返回 3；C1/C2/C3 一条不改。并把 C1 从「凡两侧都有值就必须一致」（无可比项时为空断言）收紧为「每页必备字号项两侧都必须有值且一致」，杜绝 `metric=null` 退化成通过。
5. **报告如实标注来源**：`report.json → chromiumCompare.preflight` 与 `compare-notes.md → ## 0.5`，逐个 report 标「**新跑** / 复用 + 生成时间 + 文件 sha256(12) + 补跑命令/端口/耗时」。

### 新鲜度判定的边界（如实）

- 现有 Chromium 探针的 `report.json` **没有记录源码指纹**，因此「本次对照源是否与当前产品 `src` 一致」无法由 report 自证；本探针只校验「存在 / 有生成时间 / 度量齐备 / 不比产出它的探针脚本旧」。
- 产品源码改动导致的度量漂移不在本次修复范围内；这是要求里「记录的源码/产物指纹与当前一致」那一档尚未闭环的部分，已登记为未验证项。

## 3. 真实命令与真实输出（最终代码）

### 场景 A：对照源缺失 → 默认自动补齐 → 全绿

先人为制造缺失（也正是修复前导致 C2 误报的真实状态）：

```
$ TARGET=/Users/wepingli/.openarc-worktrees/dxos-port-r1/artifacts/dxos-ui-skills/report.json
$ rm -f "$TARGET" && (ls "$TARGET" 2>&1 || echo CONFIRMED_MISSING)
ls: .../artifacts/dxos-ui-skills/report.json: No such file or directory
CONFIRMED_MISSING
```

```
$ node experiments/dxos-ui-real/run-all.mjs          # 默认自动补齐
   · 对照源不可用（artifacts/dxos-ui-skills/report.json：report_missing）→ 自动补齐：node experiments/dxos-ui-skills/run-all.mjs
PASS [preflight] Q3 · 自动补齐对照源（node experiments/dxos-ui-skills/run-all.mjs，端口 59676） :: actual={"port":59676,"ms":85364,"code":0,"signal":null,"timedOut":false,"stderrTail":""} expected=exit 0
...
   · 对照源体检通过：新跑 1 个探针 / 复用 3 个 report
...
PASS [compare] C2 · 列表行高逐项记录并归因（真实数据内容，非窗口外壳） :: actual=[{"page":"skills","chromium":108,"real":88,"delta":-20},{"page":"mcp","chromium":88,"real":85,"delta":-3},{"page":"tasks","chromium":108,"real":106,"delta":-2},{"page":"org","chromium":110,"real":108,"delta":-2},{"page":"model","chromium":164,"real":132,"delta":-32}] expected=两侧数值齐备
...
=== 结论 ===
截图：30 张（每页 empty/ready × light/dark）
console error=0 pageerror=0 非本地请求=0
真实 profile 身份库未变=true（identity.db sha256 前后对照见 report.json）
对照源：skills=fresh-run@2026-10-15T08:50:52.609Z#4f5ca1a1a766 · mcp=fresh-run@2026-10-15T08:50:52.609Z#4f5ca1a1a766 · tasks=reused@2026-10-14T18:19:45.765Z#4032ef9fcd1b · org=reused@2026-10-14T18:36:10.300Z#b9d367afe421 · model=reused@2026-10-15T07:30:33.741Z#124f5bec833a
对照源补跑：experiments/dxos-ui-skills/run-all.mjs(port 59676,85s,exit0)
PASS 191 / FAIL 0
报告：artifacts/dxos-ui-real/report.json
对照笔记：artifacts/dxos-ui-real/compare-notes.md
REAL_EXIT=0
```

> C2 五个页面 chromium 全部非 null（108 / 88 / 108 / 110 / 164），正是修复前为 null 的那三项（skills / mcp / model）。C1 也因「每页必备字号项」全部两侧有值且一致而 PASS（不再是空断言）。

### 场景 B：对照源陈旧 + 关闭自动补齐 → 明确失败指引（exit 3）

人为把 tasks 的 report mtime 改到 2001-09-09（比产出它的探针源码旧），并设置 `OA_UI_REAL_CMP_AUTOFILL=0`：

```
$ OA_UI_REAL_CMP_AUTOFILL=0 node experiments/dxos-ui-real/run-all.mjs
   · OA_UI_REAL_CMP_AUTOFILL=0 → 不自动补齐，按明确指引失败
PASS [preflight] Q0 · 对照源 artifacts/dxos-ui-skills/report.json 存在 / 可解析 / 带生成时间戳 :: actual={"exists":true,"parsed":true,"timestamp":"2026-10-15T07:36:16.171Z","timestampField":"finishedAt","mtimeMs":1792049776172,"sha256_12":"39fbddb4b72e","reasons":[]} expected=exists + parse + 非空生成时间戳
PASS [preflight] Q1 · 对照源 artifacts/dxos-ui-skills/report.json 度量齐备（skill + mcp） :: actual={"missing":[],"checks":[{"page":"skills","key":"skill","ok":true},{"page":"mcp","key":"mcp","ok":true}]} expected=compare.metrics 必备路径齐全
PASS [preflight] Q2 · 对照源 artifacts/dxos-ui-skills/report.json 不比产出它的探针源码旧 :: actual={"reportMtimeMs":1792049776172,"probeSourceNewestMs":1791992832242.1396,...} expected=report mtime >= 探针脚本/挂载壳 mtime
PASS [preflight] Q0 · 对照源 artifacts/dxos-ui-tasks/report.json 存在 / 可解析 / 带生成时间戳 :: actual={"exists":true,"parsed":true,"timestamp":"2026-10-14T18:19:45.765Z","timestampField":"finishedAt","mtimeMs":1000000000000,"sha256_12":"4032ef9fcd1b","reasons":["probe_source_newer"]} expected=exists + parse + 非空生成时间戳
PASS [preflight] Q1 · 对照源 artifacts/dxos-ui-tasks/report.json 度量齐备（task） :: actual={"missing":[],"checks":[{"page":"tasks","key":"task","ok":true}]} expected=compare.metrics 必备路径齐全
FAIL [preflight] Q2 · 对照源 artifacts/dxos-ui-tasks/report.json 不比产出它的探针源码旧 :: actual={"reportMtimeMs":1000000000000,"probeSourceNewestMs":1791992832252.4897,"probeSource":{"probe":"experiments/dxos-ui-tasks/run-all.mjs","files":[{"file":"experiments/dxos-ui-tasks/run-all.mjs","exists":true,"mtimeMs":1791992832252,"sha256_12":"2b347a5adc18"},{"file":"experiments/dxos-ui-tasks/harness.tsx","exists":true,"mtimeMs":1791968736536,"sha256_12":"814792adf191"}],"newestMs":1791992832252.4897,"sha256_12":"bc70094b459a"}} expected=report mtime >= 探针脚本/挂载壳 mtime
PASS [preflight] Q0 · 对照源 artifacts/dxos-ui-org/report.json 存在 / 可解析 / 带生成时间戳 :: actual={"exists":true,"parsed":true,"timestamp":"2026-10-14T18:36:10.300Z","timestampField":"finishedAt","mtimeMs":1792002970301,"sha256_12":"b9d367afe421","reasons":[]} expected=exists + parse + 非空生成时间戳
PASS [preflight] Q1 · 对照源 artifacts/dxos-ui-org/report.json 度量齐备（org） :: actual={"missing":[],"checks":[{"page":"org","key":"org","ok":true}]} expected=compare.metrics 必备路径齐全
PASS [preflight] Q2 · 对照源 artifacts/dxos-ui-org/report.json 不比产出它的探针源码旧 :: actual={"reportMtimeMs":1792002970301,"probeSourceNewestMs":1791992832263.2966,...} expected=report mtime >= 探针脚本/挂载壳 mtime
PASS [preflight] Q0 · 对照源 artifacts/dxos-ui-model/report.json 存在 / 可解析 / 带生成时间戳 :: actual={"exists":true,"parsed":true,"timestamp":"2026-10-15T07:30:33.741Z","timestampField":"finishedAt","mtimeMs":1792049433742,"sha256_12":"124f5bec833a","reasons":[]} expected=exists + parse + 非空生成时间戳
PASS [preflight] Q1 · 对照源 artifacts/dxos-ui-model/report.json 度量齐备（model） :: actual={"missing":[],"checks":[{"page":"model","key":"model","ok":true}]} expected=compare.metrics 必备路径齐全
PASS [preflight] Q2 · 对照源 artifacts/dxos-ui-model/report.json 不比产出它的探针源码旧 :: actual={"reportMtimeMs":1792049433742,"probeSourceNewestMs":1791992832230.6877,...} expected=report mtime >= 探针脚本/挂载壳 mtime
FAIL [preflight] Q4 · 对照源全部新鲜可用（缺失/陈旧/度量残缺一律失败，绝不放宽或跳过对照） :: actual={"problems":[{"report":"artifacts/dxos-ui-tasks/report.json","reasons":["probe_source_newer"]}]} expected=全部 fresh

对照源体检未通过：本探针不使用缺失 / 陈旧 / 度量残缺的对照源，也不会因此放宽或跳过对照断言。
请先按既定顺序串行补齐（每个探针自带唯一端口，勿并行）：
  - artifacts/dxos-ui-tasks/report.json → probe_source_newer
  node experiments/dxos-ui-tasks/run-all.mjs
或保持默认自动补齐（不要设置 OA_UI_REAL_CMP_AUTOFILL=0）。
失败明细：artifacts/dxos-ui-real/preflight.json
REAL_EXIT=3
```

> 该场景没有启动 electron、没有写 report.json；随后把 tasks report 的 mtime 恢复原值，后续正常跑恢复复用。

### 场景 C：正常跑一次 → 全部复用 → 全绿

```
$ node experiments/dxos-ui-real/run-all.mjs
   · 对照源体检通过：新跑 0 个探针 / 复用 4 个 report
...
=== 结论 ===
截图：30 张（每页 empty/ready × light/dark）
console error=0 pageerror=0 非本地请求=0
真实 profile 身份库未变=true（identity.db sha256 前后对照见 report.json）
对照源：skills=reused@2026-10-15T07:43:33.489Z#0416023ac745 · mcp=reused@2026-10-15T07:43:33.489Z#0416023ac745 · tasks=reused@2026-10-14T18:19:45.765Z#4032ef9fcd1b · org=reused@2026-10-14T18:36:10.300Z#b9d367afe421 · model=reused@2026-10-15T07:30:33.741Z#124f5bec833a
对照源补跑：无（全部复用）
PASS 190 / FAIL 0
REAL_EXIT=0
```

> 场景 C 与场景 A 的核对：A 是「skills 新跑、其余复用」，C 是「4 个 report 全复用」；两次都跑到 C1/C2/C3 + 全部页面断言，结果一致。

### 对照产物（要求 3：标注新跑 / 复用 + 生成时间 + 指纹）

当前 `artifacts/dxos-ui-real/compare-notes.md`（场景 A 产物，逐字）：

```markdown
## 0.5 对照源体检（新跑 / 复用）

> 启动时先体检每个 Chromium 侧对照源：存在 + 可解析 + 非空生成时间戳 + 必备度量路径齐备 + 不比产出它的探针源码旧。
> 缺失 / 陈旧 / 度量残缺时默认按既定顺序串行补跑对应 Chromium 探针（唯一空闲端口）；本次自动补齐=开启。

| 对照源 report | 供给页面 | 本次来源 | 生成时间 | 文件 mtimeMs | sha256(12) | 补跑命令（端口 / 耗时） |
| --- | --- | --- | --- | --- | --- | --- |
| artifacts/dxos-ui-skills/report.json | skills / mcp | **新跑** | 2026-10-15T08:50:52.609Z | 1792054252610 | 4f5ca1a1a766 | node experiments/dxos-ui-skills/run-all.mjs（端口 59676，85s） |
| artifacts/dxos-ui-tasks/report.json | tasks | 复用 | 2026-10-14T18:19:45.765Z | 1792001985765 | 4032ef9fcd1b | —（复用，未补跑） |
| artifacts/dxos-ui-org/report.json | org | 复用 | 2026-10-14T18:36:10.300Z | 1792002970301 | b9d367afe421 | —（复用，未补跑） |
| artifacts/dxos-ui-model/report.json | model | 复用 | 2026-10-15T07:30:33.741Z | 1792049433742 | 124f5bec833a | —（复用，未补跑） |
```

`artifacts/dxos-ui-real/report.json → chromiumCompare.sources`（场景 A）：

```
skills {"report":"artifacts/dxos-ui-skills/report.json","key":"skill","origin":"fresh-run","reportAt":"2026-10-15T08:50:52.609Z","sha":"4f5ca1a1a766","fresh":true}
mcp    {"report":"artifacts/dxos-ui-skills/report.json","key":"mcp",  "origin":"fresh-run","reportAt":"2026-10-15T08:50:52.609Z","sha":"4f5ca1a1a766","fresh":true}
tasks  {"report":"artifacts/dxos-ui-tasks/report.json", "key":"task",  "origin":"reused","reportAt":"2026-10-14T18:19:45.765Z","sha":"4032ef9fcd1b","fresh":true}
org    {"report":"artifacts/dxos-ui-org/report.json",   "key":"org",   "origin":"reused","reportAt":"2026-10-14T18:36:10.300Z","sha":"b9d367afe421","fresh":true}
model  {"report":"artifacts/dxos-ui-model/report.json", "key":"model", "origin":"reused","reportAt":"2026-10-15T07:30:33.741Z","sha":"124f5bec833a","fresh":true}

# chromiumCompare.preflight
"initialStale": [{"report":"artifacts/dxos-ui-skills/report.json","staleReasons":["report_missing"],"timestamp":null,"mtimeMs":null}]
"ranProbes":    [{"report":"artifacts/dxos-ui-skills/report.json","probe":"experiments/dxos-ui-skills/run-all.mjs","port":59676,"ms":85364,"ok":true,"exitCode":0,"signal":null,"timedOut":false}]
```

`artifacts/dxos-ui-real/preflight.json`（失败时含指引，成功时 ok:true；上面场景 C 的失败版也已落盘验证过）：

```json
{
  "ok": true,
  "autofill": true,
  "initialStale": [ { "report": "artifacts/dxos-ui-skills/report.json", "staleReasons": ["report_missing"] } ],
  "ran": [ { "report": "artifacts/dxos-ui-skills/report.json", "probe": "experiments/dxos-ui-skills/run-all.mjs", "port": 59676, "ms": 85364, "ok": true, "exitCode": 0 } ],
  "reports": [
    { "report": "artifacts/dxos-ui-skills/report.json", "fresh": true, "reasons": [], "timestamp": "2026-10-15T08:50:52.609Z", "sha": "4f5ca1a1a766" },
    { "report": "artifacts/dxos-ui-tasks/report.json",  "fresh": true, "reasons": [], "timestamp": "2026-10-14T18:19:45.765Z", "sha": "4032ef9fcd1b" },
    { "report": "artifacts/dxos-ui-org/report.json",    "fresh": true, "reasons": [], "timestamp": "2026-10-14T18:36:10.300Z", "sha": "b9d367afe421" },
    { "report": "artifacts/dxos-ui-model/report.json",  "fresh": true, "reasons": [], "timestamp": "2026-10-15T07:30:33.741Z", "sha": "124f5bec833a" }
  ]
}
```

## 4. 未完成 / 未验证项（含环境抖动如实登记）

1. **对照源与当前产品源码的一致性未被证明**：Chromium 探针的 report.json 未记录产品源码指纹，本探针只能证明「report 存在、有时间戳、度量齐备、不比产出它的探针脚本旧」。要闭环「源码/产物指纹与当前一致」需改各 Chromium 探针记录指纹，本次按「只改本探针」约束未做。
2. **「陈旧」只覆盖探针自身脚本/挂载壳更新的情形**：未设 TTL（报告最大年龄），「很久以前跑过但脚本未变」的 report 仍按可比处理。
3. **自动补齐继承各 Chromium 探针自身的判定**：某探针失败时本探针会 Q3/Q0-Q2/Q4 记 FAIL 并 exit 3，不会假绿；本次只实测了 `dxos-ui-skills` 的自动补齐成功路径（3 次：84s / 89s / 85s，均 exit 0）与 `dxos-ui-model` 的手工首跑（PASS 88/88），未实测自动补齐 `dxos-ui-tasks` / `dxos-ui-org` 或补齐失败的路径。
4. **场景 B 的「陈旧」是改 mtime 模拟的**（report 内容未改），用于验证分类器与失败指引；真实的「内容陈旧」在无源码指纹机制下无法精确复现。
5. **宿主高负载下出现过两次与本次修复无关的抖动运行**（原始日志已留档）：
   - `scenario-A2-aborted-under-load.log`：自动补齐成功（Q3 exit 0）后，ready 场景出现 `fatal/ready F · 场景中断：Target page, context or browser has been closed`，导致 6 条连带 FAIL。属宿主 loadavg ≈ 30 时的 electron 抖动，与对照源逻辑无关；重跑即恢复 `PASS 191 / FAIL 0`。
   - `scenario-C3-transient-profile-write.log`：`PASS 188 / FAIL 2`，且仅 S1/S2 失败（`identity.db-shm` 变化）。原因是用户自己的 OpenArc OS.app 正以真实 profile 运行（开工前/收工后各 3 个进程），期间写了 `-shm`；本探针全程用隔离 userData，已由 report 的 notVerified 如实登记。重跑恢复 `PASS 190 / FAIL 0`。
6. **本轮未跑**：`npm run build` / `npm test`（按硬约束不跑）；`dxos-ui-mcp` 探针未跑（它不是对照源；mcp 度量来自 dxos-ui-skills 的 report）。
