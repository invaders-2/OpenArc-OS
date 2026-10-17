# D5-02 画布全量门禁 · 重定向到智能画布（GATE-REDIRECT）

日期：2026-10-17
目标：`experiments/d5-02/canvas-e2e.mjs` 从传统编辑器（`static/canvas.html` + `static/js/canvas.js`，已删除）
重定向到唯一编辑器 `static/smart-canvas.html`（`static/js/smart-canvas.js` + `openarc-smart-adapter.js` +
注入守卫 `window.__openarcSmartGuard`）。原则：能重指向就重指向，确实没有对应物的登记删除，不降强度、不静默跳过。

## 1. 门禁结果（真实跑完）

| 项 | 值 |
| --- | --- |
| 最终 | **PASS 47 / FAIL 1 / TOTAL 48**（notVerified 0，deleted 6，productGaps 3） |
| 退出码 | 1（F3d 产品问题；其余全绿） |
| 墙钟耗时 | **94.6s**（job startedAt→finishedAt：1792234265627→1792234360271；上一轮 91.4s） |
| 产物 | `artifacts/d5-02/d5-02-canvas-e2e.json`、`artifacts/d5-02/gate-run.log` |
| 运行方式 | `node experiments/d5-02/canvas-e2e.mjs`（真实 Electron + 隔离 userData + 本地确定性 provider） |

## 2. 改动清单

| 文件 | 改动 |
| --- | --- |
| `experiments/d5-02/canvas-e2e.mjs` | 帧选择器 `canvasFrame()→smartFrame()`（95 处）；`.smart-back` 取代 `#backToManagerBtn`；A2 子页清单去掉 smart-canvas；N1/N3/N4/N5a 按智能画布真实契约重写；B2/B3/B4 改走 `.prompt-node-run` / `#runBtn` + 生成日志；F3a–F3c 改读 `node.images[0].url`；F3d/F3e 适配智能节点与原生 409 合并；E2 白名单资源改 `smart-canvas.js`；F3h 重命名改断应用内模态；F3f 删除；输出新增 `deletedCases` / `productGaps`；新增 `nRefreshConfig()`（页面自己的 `providers-changed` 契约，事实仍由页面 fetch 真源） |
| `experiments/dxos-canvas-revendor-next/GATE-REDIRECT.md` | 本清单 |
| `experiments/dxos-canvas-revendor-next/gate-facts-probe.mjs` | 只读事实探针（采集智能画布 DOM/守卫/运行链路，供重定向取证） |
| `experiments/dxos-canvas-revendor-next/f3d-probe.mjs` | F3d 定向探针（测出 7.3–7.5s 的远端合并延迟） |

未改：`electron/**`、`src/**`、`src-vue/**`、`public/novai-canvas/**`、`tests/**`、`dist/**`；未加依赖；未 git commit/push。

## 3. 逐用例处置（原 52 条）

| 编号 | 原意图 | 处置 | 智能画布落点 |
| --- | --- | --- | --- |
| A0×2 | 启动 / 登录 | 保留 | 不变 |
| A1 | 入口=列表首页 | 保留 | 不变 |
| A2 | 其他子页不可达 | 重指向 | `SUBPAGES` 去掉 `smart-canvas`（它已是唯一编辑器，不算被裁子页）；其余 5 个仍 0 命中 |
| A3 | 开始创作直达编辑器 | 重指向 | `smartFrame()` + `__openarcCanvas.state()`；遮挡层判定保留 |
| A4 | 返回列表 | 重指向 | `.smart-back` |
| A5 | 继续上次 | 重指向 | `smartFrame()` + canvasId 断言保留 |
| A6 | 卡片直达 | 重指向 | `.smart-back` 回列表 + 卡片点击 |
| A7 | 命令层 add/connect/move → 落库 | 保留（节点类型按映射） | `prompt/llm → smart-prompt`；存储断言不变 |
| A8 | undo/redo | 保留 | 页面原生 undo/redo + `primitives.getNode` |
| N1 | 无模型契约 | 重指向 | `facts()` + `#chatModelSelect`（唯一占位「未配置」）+ `#engineSelect` option 标记 + 创建菜单视频入口 + pill 0 + /comfly/i 0 命中 + 记忆键锁 |
| N2 | 引导→打开设置 | **删除** | 见 §4 |
| N3 | 视频未接通 | 重指向 | 创建入口 / engine option / 选中视频节点后 `#runBtn[data-openarc-blocked=video-generation]` / facts / 501 / 0 视频 pill；节点徽标子断言删除 |
| A9 | 返回列表有卡片 | 重指向 | `.smart-back` + 列表断言不变 |
| A10 | 再打开同一本 | 重指向 | smartFrame + 节点/连线/坐标断言不变 |
| B1 | provider 投影 | 保留 | frame=smart |
| B2 | 文本真实调用 | 重指向 | `smart-prompt` ▶ `.prompt-node-run → runPromptLLMNode`；node.text 前缀 + provider 凭据 |
| B3 | 图片真实调用 | 重指向 | 选中 `smart-image` → 编辑栏提示词 → `#runBtn`；`images[]≥1` + 文档落库 + provider 收到请求 |
| B4 | 失败如实 | 重指向 | 生成日志 `status=failed` + error 非空 + images=0/pending=0（不假装成功） |
| N4 | 真源渲染 / 无第二来源 | 重指向 | 平台控件 / provider pill / 模型 pill / chat 下拉 / 页面与节点当前模型全部 ⊆ 真源；4 把 smart_* 键锁死 |
| N6 | 清单外模型拒绝 | 保留 | frame=smart |
| B5 | 视频 501 | 保留 | frame=smart |
| B6 | 更新禁用 / 宿主信息 | 保留 | frame=shell |
| D1 | 撤权调用级拒绝 | 保留（一字未改） | — |
| N5a | 撤权/恢复页面模型区 | 重指向 | `facts()` configured + `#chatModelSelect` + pill 0/真源 + `#runBtn` blocked by 选中节点 |
| D2 | 跨能力拒绝 | 保留 | — |
| N5c | 跨能力页面呈现 | **删除** | 见 §4 + 产品缺口 |
| D3/D4/D5 | 预算/停止/失败收敛 | 保留 | — |
| F1 | 任务模型绑定 | 保留 | — |
| N5d | 停用默认页面呈现 | **删除** | 见 §4 + 产品缺口 |
| F3a | 资源只存 ref | 重指向 | `node.images[0].url === openarc-asset:*` |
| F3b | 重开仍可解析 | 重指向 | 页面 images[0]=data URL；存储仍 ref |
| F3c | 删除后不可用 | 重指向 | 宿主缓存失效 + reload-doc → 非 data:image 占位；存储仍 ref；重开不复活 |
| F3d | 宿主新增 ≤5s 进编辑器 | 重指向（**FAIL**） | 实测 7316ms（页面轮询 8s），见 §5 |
| F3e | 500ms 交错两边都保留 | 部分重指向 | 不同节点两边都在（页面+DOM+IPC+重开）；`<id>-remote` 子断言删除 |
| E1/E2/E3/E4/E5/E5b/E6/E7/E8 | 宿主隔离/账号边界 | 保留（E2 资源改 smart-canvas.js） | — |
| F3f | AI 标记 + 淡入 | **删除** | 见 §4 |
| F3g | 回收站 FAB | 重指向 | `.smart-back`，列表页断言不变 |
| F3h | 卡片菜单真实路径 | 重指向 | 重命名改断应用内模态（标题 + 预填 + 可见尺寸），其余保留 |
| Z1 | 主进程无错误 | 保留 | — |

## 4. 删除用例（随经典编辑器移除，门禁里逐条打印）

1. **N2**（引导按钮 → 打开设置）：智能画布守卫 v3 无页头状态位、无 `[data-openarc-open-model-settings]`。替代覆盖：**无等价**；最接近 N1 / D1 / E2c。
2. **N5c**（跨能力页面「显式默认不可用」呈现）：无 `data-openarc-default-unavailable` 契约。替代覆盖：D2（宿主拒绝 + 0 请求）+ N4（清单如实）；页面侧静默换模型缺口见 §5。
3. **N5d**（停用默认的页面呈现）：同上。替代覆盖：F1（宿主拒绝停用/跨能力/不存在 + 0 请求）。
4. **N3·节点徽标**：节点级 `data-openarc-capability/available` 未移植；替代：N3 的 `facts()` + `#runBtn[data-openarc-blocked]`。
5. **F3e·同字段副本**：无 `<id>-remote` / conflictLog；替代：F3e 不同节点并集 + D1/F4 的 revision 校验。
6. **F3f**（AI 标记 + 160ms 淡入）：`canvas-ai-marks.js` 只服务经典 `renderNode`；替代：F4（AI 节点落地/保存重开），动效无替代。

## 5. 真实产品问题（门禁未能通过，原因是产品问题）

### F3d：宿主/AI 改动进入已打开编辑器的延迟 7.3s > 5s

- 证据：`artifacts/d5-02/d5-02-canvas-e2e.json` F3d `actual` →
  `appeared:true, waitedMs:7316, thresholdMs:5000, revisions.stable:true, page.hasHost:true, domHost:true, ipcHost/local 正确`。
- 根因（静态证据）：智能画布自己的远端合并轮询是
  `public/novai-canvas/static/js/smart-canvas.js:11012-11023` 的 `setTimeout(..., 8000)`；
  经典 `canvas.js` 是 `startCanvasRemotePolling()` 的 `2500`（git HEAD 版本 L2603-2616）。
  宿主 `CanvasHost.tsx` 没有 `canvas_updated` 推送（只有资源失效的 `reload-doc`），所以页面只能等 8s 轮询。
- 结论：D1「永不进来」的缺陷已修复（一次轮询内到达、内容不丢、revision 稳定），但**呈现延迟从 2.5s 退化到 8s**，
  旧门禁的 ≤5s 预算不成立。**未改门禁阈值、未删用例**。

### 页面侧「显式默认不可用」未移植（N5c / N5d 的产品面）

- N5c 实测：`/api/config.capabilities["image-generation"] = {defaultUsable:false, defaultReason:"CAPABILITY_UNAVAILABLE"}`，
  但页面 `settings.model = d502-image`、`n_gen.runSettings.model = d502-image`、`#runBtn` 未 blocked ⇒ 静默换模型。
- N5d 实测：chat 默认被停用后 `chatModels=[d502-chat-only]`，页面 `#chatModelSelect.value = d502-chat-only`、
  `n_llm.llmModel = d502-chat-only` ⇒ 静默换模型；F1 的宿主拒绝仍成立。
- 处置：N5c/N5d 删除并登记；产品如需恢复该契约，需在 `public/novai-canvas/**` 补 `data-openarc-default-unavailable` 呈现（本批写范围外）。

## 6. 遗留 / 待裁决

1. F3d 的 ≤5s 预算是否保留由产品裁决：要恢复 5s 需宿主在 `canvas/command` 后推送 `reload-doc`（或页面轮询降回 2.5s）；
   若产品接受 8s，则应显式改口径（本批不自行放宽）。
2. 智能画布未移植 AI 来源标记/淡入（F3f）与 `<id>-remote` 副本（F3e）；如需保留这两个契约，需要产品侧实现。
3. F3h 的重命名已改应用内模态；原生 `alert/confirm` 仍是上游行为（Electron 支持）。
