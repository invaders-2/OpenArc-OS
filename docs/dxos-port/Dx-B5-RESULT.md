# Dx-B5-RESULT · B5（媒体 + 画布）+ UI-1（Skill 中心）测试与验收报告

> 依据：本轮任务「继续」= 按 §5 推进 B5，并按用户指示**同步开始前端 UI、采用 OpenArc 自己的设计语言**。
> 分支 `dxos-port/r1`，起点 `4cfbf01`（B4 收口）。真实命令与真实输出见下；未验证项显式标注。

## 1. 交付对照

| 要求 | 落点 | 状态 |
|---|---|---|
| B5 · FFmpeg 渲染 worker | `video-render-worker.cjs`（受监督子进程唯一入口 probe/poster/render/health，自持 deadline 先 kill ffmpeg 防孤儿）+ `media-service.cjs` 经 `dxos-foundation-runner.cjs` 拉起 | ✅ |
| B5 · 探测与封面缓存 | `media-domain.cjs`（ffprobe 解析）+ `media-store.cjs`（封面 single-flight/失败退避/失效） | ✅ |
| B5 · 媒体域 IPC | `media:command`(16 条) + `media:event`；preload 第 20 键 `media`；v24 只新增三表 | ✅ |
| B5 · 画布素材库 / .dxcanvas 打包 / 本机与 LAN 协作 | `canvas-dxos-asset-library.cjs`（素材字节仍走既有 `resource_*`）、`canvas-dxos-package.cjs`（零依赖 ZIP + SHA-256 + 危险路径拒绝）、`canvas-dxos-collab.cjs`（房间 + 三方合并）；云同步 `canvasCloudSync`/`dx-canvas-cloud` 按 OUT 排除 | ✅ |
| B5 · 画布内核能力 / Agent 附件 | `canvas-dxos-capabilities.cjs`（18 条能力投影 + 目录契约）、`canvas-dxos-agent-attachments.cjs`（挂载/卸载/预算） | ✅ |
| B5 · 命令面与迁移 | 扩展既有 `canvas:command`（不改第二套通道）+ v25 迁移 | ✅ |
| UI-1 · Skill 中心（按 `Dx-UI-PLAN.md`） | `src/skills/SkillCenter.tsx` + `skillCenterLogic.ts`；`main.tsx` 2 处改动；`styles.css` 纯追加 | ✅ |

规模：媒体域 2,002 行 + 画布域 2,312 行 + UI 逻辑/组件；测试 `dxos-media*` 19 例 + `dxos-canvas*` 44+4 例 + `dxos-skill-center` 24 例 + 探针 33 项。

## 2. UI 验收记录（UI-1 · Skill 中心）

**规范依据**：`DESIGN_SYSTEM.md` §1–§11、`MOTION_SYSTEM.md` §1–§11、`PLAN.md` §4 与 §42（规范文件本批零改动，已核验）；计划见 `Dx-UI-PLAN.md`。

| 验收项 | 结果与证据 |
|---|---|
| 页面与状态 | appId `skills`（左侧三分类导航保留）。九类状态实机截图：`artifacts/dxos-ui-skills/{01-loading,02-empty,03-ready,04-error,05-running,06-disabled,07-import-failed,08-unauthorized,09-dependency}.png` + 窄宽 `10-narrow-640.png` |
| 复用 token 与组件 | 只用 `primitives.tsx` 的 Button/IconButton/TextField/SearchField/Tooltip/Badge/ScrollArea/Surface/Toast 与 `page-states.tsx` 的 `PageState`；布局类与信息密度对齐基准 `src/mcp/McpCenter.tsx`。**tokens.css 零改动**（`git diff` 为空） |
| 基准对照（同 light / 1440×900 / dSF 2 / reducedMotion=reduce） | `compare-skill.png` 与 `compare-mcp.png` 均 2880×1800；关键度量同源读出：行标题 14px、元信息 11px、行 padding 12px、圆角 `--radius-lg`、行底 `--sunken`、列表 gap 16px **一致**；页面标题 21px vs 14px 记为**待修（UI-2）**；外壳与侧栏差异记为**保留**并写明理由（`compare-notes.md`） |
| 动效 | 连续录屏 `skill-center-flow.webm`（814,757 B，就绪→选技能→输入→运行中→成功→切分类）；运行中按钮禁用（连点不叠加）；`reducedMotion=reduce` 下仍产出完整状态截图；状态反馈不靠颜色单独传意 |
| 焦点与可访问性 | Tab 顺序只在界面内推进（越界停留 0 次、body 1 次）、焦点 13 步逐步前进；无 console error |
| 边界 | 只发白名单命令（`skill/health|list|pack/list|get|run`）、载荷不含身份字段、无跨源/非本地请求；不 fetch、不读凭据、不写 localStorage |
| 探针结论 | `node experiments/dxos-ui-skills/run-all.mjs` → **PASS 33/33，exit 0**；`report.json` 记录 0 consoleError / 0 externalRequests；`node --test tests/dxos-skill-center.test.mjs` → **24/24** |

## 3. 真实命令与真实输出

```
$ npm run build                                              BUILD_EXIT=0

$ npm test                    （独占，无其它负载）
1..2038
# tests 2038 / # pass 2037 / # fail 1                       TEST_EXIT=1
唯一失败：not ok 337 - D5-03-E · ACP SDK 只认项目内那一份（worktree node_modules 符号链接的基线既有环境项）
对照：B4 1945/1944/1 → B5 2038/2037/1（新增 93 例）

$ npm run test:model-ipc-ui   （真实 Electron，preload 20 键）
10/10 IPC checks passed                                      MODELIPC_EXIT=0

$ npm run test:design-system
5 个探针：PASS 4 / PARTIAL 1 / FAIL 0                         DS_EXIT=0

$ node experiments/dxos-b5/run-all.mjs      （真实 ffmpeg/ffprobe 7.1.1 全链路）
health → ffmpeg 合成 → ffprobe 探测 → 素材落盘 → 封面缓存幂等 → 渲染成片 → 成片校验 → 事件信封 22 条
[B5] 全部通过                                                 B5PROBE_EXIT=0

$ node experiments/dxos-ui-skills/run-all.mjs
UI-1 Skill 中心探针：结论 PASS — {"total":33,"failed":0}       UISKILL_EXIT=0

$ node --test tests/dxos-canvas*.test.mjs tests/dxos-agent-tool-catalog.test.mjs tests/migration.test.mjs tests/identity-store.test.mjs
# tests 91 / # pass 91 / # fail 0
$ node --test tests/dxos-media*.test.mjs                      # tests 19 / pass 19
$ node --test tests/d5-03-reset-authorization-consistency.test.mjs   # tests 9 / pass 9
```

## 4. 门禁期间发现并收口的问题（都在本批内解决）

| 问题 | 性质 | 处置 |
|---|---|---|
| `test:model-ipc-ui` 由绿转红 | 契约扩展未同步探针：B5a 新增 `media` 顶层键（19→20） | 探针 `expectedTopKeys` 19→20 并写明"为什么改"；负向断言（无 raw credential/无 ipcRenderer/桥值只允许 function）**一字未放松**；重跑 10/10 |
| `#411/#417` D5-03 重置守卫失败 | **守卫按设计跳闸**：新增 `canvas_dxos_asset_libraries` 带 `organization_id`，"带 org 的表集合"28→29 | 显式登记该表 + 记录处置决策（素材字节仍在 `resource_*`，非授权事实、不能恢复设备身份 → **不删**），并新增 pin 断言把"重置删除集合恰为七张表"写死；守卫未放宽；重跑 9/9 |
| `#303` D5-02 画布命令层失败 | **负载敏感抖动**（`canvas-service.cjs`/`canvas-domain.cjs` 本批零改动；单独复跑 9/9 全绿） | 不改代码；口径记录（同 B3 已定性的并发 spawn/时序抖动） |

## 5. 未验收 / NOT VERIFIED

1. **真实 Electron 端到端仍未跑**：`media:command`/`canvas:command`/扩展接线的真机投递只做 `node --check` + 离线夹具；`test:model-ipc-ui` 覆盖的是 preload 键契约，不是这些命令。
2. **LAN 协作的 ws 路径未启动**：`ws` 仅惰性 require（未写入 package.json），只验证了 hub 语义与不变量。
3. **docx/xlsx/PDF 解析未实现**：禁新增依赖 → 返回结构化错误（不假解析）。
4. **媒体后台连续消费未做**：`media/render/submit` 只入队，执行由 `media/render/run` 驱动。
5. **UI 未接的动作**：`skill/analyze`、`skill/save`、`skill/workspace/list` 与媒体类技能运行入口（界面给出"属后续批次"的禁用原因）；"市场"按 OUT 改写为"技能包（本机导入）"。
6. **UI-2 待修项**（`compare-notes.md`）：页面标题字号未统一（21px vs 14px）；两页都未使用 `ScrollArea`（与 DESIGN_SYSTEM §2 组件清单不一致）——登记为 UI-2/MCP 扩展波。
7. **文档漂移**：`electron/identity-store.cjs:1613` 注释仍写"其余 20 张带 organization_id 的表"（实际应为 29−7=22），本批未改（越出该波可写范围），登记为待收口。
8. **UI 未与真机窗口对照**：探针 harness 不含 `.window-body/.window-title`，外层顶距与真实窗口存在已知近似；绝对像素基线需真机复核。

## 6. 结论

B5（媒体 + 画布）与 UI-1（Skill 中心）**均已落地并通过门禁**：build ✅、全量测试 ✅（唯一失败为基线既有 #337）、真机 preload 探针 ✅（20 键）、design-system ✅、真实 ffmpeg 全链路探针 ✅、UI 探针 33/33 ✅（含基准对照与连续录屏）。门禁期间暴露的两处真问题（探针契约、重置守卫）已在本批内按"不放宽安全/守卫"的口径收口，一处负载敏感抖动已定性且未改代码掩盖。UI 证据（截图 + 录屏 + 度量对照 + 差异结论）落在 `artifacts/dxos-ui-skills/`（`artifacts/` 为 gitignore，不入提交）。


## 7. 独立验证（只读，与移植岗分离）与收口

**验证岗结论（它自己重跑证据、不采信报告）**：

- **结构对照**：媒体源 `server/video/*.ts` 的运行时导出逐名落在 `media-{domain,store,service}.cjs` + `video-render-worker.cjs`（重命名/拆分处已列明，非缺失，仅 3 个 type-only 不在）；画布源同名/重命名移植与"复用既有 OpenArc 能力"逐条给出既有模块:行号（`canvas-service.cjs:105/124/148/182/205/218/535/560`、`canvas-store.cjs:11/14/19/22/24/26`、`canvas-domain.cjs:32/36`）；`canvasCloudSync` 13/13 与 `canvasPlugins` 7/7 未移植（前者 OUT、后者不在 B5 声明内）。
- **语义抽查 10 处**（ffmpeg 参数与 deadline/kill 顺序、ffprobe 字段、封面键与失效、租约 SQL、.dxcanvas 校验、协作三方合并、能力投影、附件预算、canvas:command 分发）逐一给源行号与代码行号，未发现功能性偏差。
- **约束**：`package.json`/`package-lock.json`/`index.html`/`tokens.css`/`DESIGN_SYSTEM.md`/`MOTION_SYSTEM.md` **零改动**；`styles.css` +350/−0（无新增 token 定义）；preload **恰好 20 键**、`ipcRenderer` 仅 invoke/on/removeListener/send；云符号仅出现在 OUT 注释；无新增依赖（sharp/ws 仅惰性）；trusted(event) 三处真实存在。
- **运行**：167/167 测试全绿（含 19 个进程 socket 级守护、**BLOCKED=0**）；真 ffmpeg 全链路 exit 0；UI 探针 33/33（0 consoleError / 0 externalRequests）。
- **UI 证据复核**：12 张 PNG 全 2880×1800（窄宽 1280×1800）、亮度 246.8–251.8 一致；`skill-center-flow.webm` vp8/1440×900/10.72s；重跑后 **12/15 产物字节级相同**、`compare-notes.md` 字节完全相同、`report.json` 仅时间戳不同 → **度量可复现**；并从源码 CSS+token 独立量出 21px vs 14px 等对照结论成立。

**验证岗发现并在本批内关闭的问题**（B5f，15 个文件）：

| 严重度 | 问题 | 处置 |
|---|---|---|
| 中（安全） | LAN 协作 `authorize` 缺省放行 | 改为**默认拒绝**（未注入/抛错/undefined/false/{ok:false} 一律 FORBIDDEN），LAN server 构造期强制显式 authorize（在惰性 require("ws") 之前） |
| 中（功能） | `upsertItem` 拒绝 `kind=asset`，源 `relation*`/`coverDataUrl`/`sourceNodeId` 语义缺失 | 按源补齐字段名与默认值 + `updateLibrary`（改名/可见性/version+1/基准冲突）；v25 内幂等补 5 个 relation 列（未升版本） |
| 中（可靠性） | 附件挂载中途失败留残留 | 改"先导入字节 → 单事务落节点+行，全成或全回滚"；失败 detail 带 stage/附件序号/依赖 |
| 中 | `canvas/collab/sweep` 等有 handler 未登记（死代码） | 登记进命令表并新增"命令表↔REGISTRY↔handler 一一对应"断言 |
| 低 | `media/poster/get` 恒 `cached:true` | 按真实缓存命中返回（生成 false / 命中 true） |
| 低 | 测试文案仍写 v20→v21；`identity-store.cjs:1613` 注释"20 张"应为 22 | 按当前真实版本 25 订正；注释改为脚本实测值 29−7=22 |

**验证岗未验证项**（与本报告 §5 一致）：真机 Electron IPC 投递、LAN ws 路径、docx/xlsx/PDF 解析、媒体后台连续消费、真实窗口像素基线、真机 20 键探针。

## 8. 提交

`0db6b43` 媒体域 / `5617629` 画布域 / `310235b` UI-1 / `0f361e2` 接线与守卫 / `8201340` UI 计划 / （B5f 与本报文同批提交）。

