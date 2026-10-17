# DXOS-CANVAS-FIX-LATENCY · 执行结果

日期：2026-10-17
范围：修两处**真实产品问题**（门禁 F3d 的唯一 FAIL + 页面侧静默换模型），阈值与既有断言一律不动。

- 问题 1：宿主 / AI 通过 `canvas/command` 改动后，已打开的智能画布要等页面自己的 **8s** 远端合并轮询才反映
  （实测 7316ms / 本包基线 7496ms；门禁阈值 5000ms）。经典 `canvas.js` 是 2.5s。
- 问题 2：显式默认模型不可用时（跨能力 / 停用 / 无授权），页面会按清单**自动选中另一个可用模型**
  （N5c `settings_model=d502-image`、N5d `chatSelect.value=d502-chat-only`）→ 用户以为用的是自己配的模型。

---

## 1. 问题 1 · 宿主推送 + 2.5s 兜底

### 1.1 实现（两层，主路径 + 兜底）

| 层 | 改动 | 位置 |
| --- | --- | --- |
| 宿主推送（主路径） | `CanvasHost` 的当前画布检测从 2500ms 提到 **800ms**；检测到 revision/updated_at 变化且不是页面自己刚保存的版本时，取 `canvas/get` + `resolveRefs`（与页面自己拉取同一份"可显示形态"），向该 iframe 推 `{ch:"openarc.canvas", dir:"host->canvas", kind:"doc-changed", canvasId, revision, updatedAt, doc, title}`。按 updatedAt 去重，同一次改动只推一遍。 | `src/canvas/CanvasHost.tsx` L938-968（`lastPushed` ref L75） |
| 页面接收（第 16 处改动） | 新模板 `experiments/d5-02/vendor/smart-canvas-live-sync.js`（7,656 B），内联在 `static/js/smart-canvas.js` IIFE 末尾（生成件 **L35937** 起）。收到 `doc-changed` 后走页面**自己的** `applyMergedServerCanvas`（与轮询 / 409 合并同一份语义），不重载 iframe、不整篇替换。 | vendor 模板 → 生成件 L35937+；证据面 `window.__openarcCanvasLiveSync.stats()` |
| 兜底轮询（第 17 处改动） | `startCanvasMetaPoll()` 的 `setTimeout(..., 8000)` → **2500**（生成件 **L11023**；与经典 canvas.js 同口径）。推送丢失 / 帧未就绪 / 宿主不在时最多 2.5s 仍会合并。 | vendor 补丁 `SMART_CANVAS_JS_PATCHES` |
| 编辑安全（第 17 处改动·同批） | `mergeReloadCanvasNow()` 的早退条件从 `dragState || selectionState` 扩为 `|| oaLiveSyncMergeUnsafe()`（生成件 **L10982**）：**正在输入**（焦点在 input/textarea/select/contenteditable）、**保存中**、**本地有未保存改动**（内容签名 ≠ 上次成功保存的签名）时，推送只记 pending、400ms 重试（最多 30 次 / 15s），到点交回兜底轮询。 | vendor 补丁 + live-sync 模板 |

**幂等**：live-sync 与页面轮询共用 `canvas.updated_at` 判据 —— 比页面更新的才合并；
同一条推送（updatedAt 相同）只合并一次；页面保存成功后自己的 updated_at 已经对齐，不会被自己刚保存的内容再刷一遍。

**为什么不重载 iframe**：`reload-doc`（资源失效复核用）是"整篇换内容"；文档变更走 `applyMergedServerCanvas`
才能保住本地的未保存编辑/本地节点。推送只在安全窗口合并，不抢占输入。

### 1.2 F3d 实测（真实 Electron + 隔离 userData + 本地确定性 provider）

| | 修复前 | 修复后 |
| --- | --- | --- |
| 门禁 F3d | **7316ms**（FAIL，阈值 5000ms） | **607ms**（PASS，阈值 5000ms，revision 稳定） |
| 定向探针 `f3d-probe.mjs` | **7496ms** | 609ms / 154–763ms |
| 本包 3 轮探针（`probe.mjs`） | — | **763 / 458 / 154ms**（最差 763ms） |
| 到达内容 | primitives + DOM，本地内容保留 | 同样：primitives + DOM，本地内容保留，revision 不回环 |
| 推送页面侧统计 | 无推送 | 每轮 `pushed +1 / applied +1`；输入中 `deferred +1`，失焦后 153ms 补上 |

证据：`artifacts/dxos-canvas-fix-latency/f3d-before.txt`、`f3d-after.json`、`check` 见
`gate-final.json` 的 F3d（actual.waitedMs=607）。

---

## 2. 问题 2 · 显式默认不可用：不静默换模型

### 2.1 实现

| 层 | 改动 |
| --- | --- |
| 宿主投影（最小） | `buildConfig()` 新增 `default_models: { chat, "image-generation" }` —— **显式默认的标签**，即使它不可用也照实投影；可用性事实仍由既有 `capabilities[cap].defaultUsable/defaultReason` 给出。默认模型已从"可用清单"里被过滤掉（停用/跨能力）时，只在需要时向 `model/list` 补一次身份（displayName / remoteModelId，不含地址与凭据）。不改变 `canvas/models` 的"可用清单"语义。 |
| 页面守卫 v4（第 12 处改动） | `experiments/d5-02/vendor/smart-canvas-guard.js` → 内联在生成件 L34839 起（`window.__openarcSmartGuard = { version: 4 }` L35888） |
| · 生图模型 | `loadConfig` 在渲染参数面板**之前**把 `settings.model` 落成默认标签（否则上游"没有 model 就取清单第一个"会先换掉）；`renderModelControl` / `correctedApiModelForProvider` 不再替换它；pill 标 `data-openarc-unavailable="image-generation"` + `data-openarc-default-unavailable="image-generation"`，挂既有 `.openarc-guard-note[data-openarc-guard-note="default-image-model"]`，popover 里该默认项 disabled（替代模型仍可选）。 |
| · 文本模型 | `initChatModel` 把默认如实列成 `<option disabled data-openarc-unavailable="chat">默认（不可用）</option>` 并保持选中；`#chatModelSelect` 标 `data-openarc-default-unavailable="chat"`，`#chatComposerBox` 内挂 `[data-openarc-guard-note="default-chat-model"]`。`correctedChatModelForProvider` 同样不再替换它。 |
| · 运行入口 | `syncRunButtonState` / `runGeneration` / `runPromptLLMNode`：这次运行真的会用那个不可用的默认时，页面侧直接拒绝（`#runBtn[data-openarc-blocked="MODEL_UNAVAILABLE"]` + `data-openarc-default-unavailable=<cap>`，不发必失败请求）；宿主层 D2/F1 的拒绝语义**一字未改**。 |
| · 显式替代 | 用户点了清单里的替代模型后记 `explicitImageModel / explicitChatModel`，之后配置刷新不再被掰回默认；管理面把**默认本身**换掉时（标签/原因变化）清掉旧标记，让新默认如实呈现。 |
| · 边界 | 整个能力没有可用模型（未配置 / 撤权，`configured=false`）时**不进入**这套呈现，保持既有"唯一占位「未配置」+ 模型 pill 0 个"（门禁 N5a 的契约不变）。 |

### 2.2 前后证据

| 场景 | 修复前（`gate1` 实测） | 修复后（`probe.mjs` + `gate-final`） |
| --- | --- | --- |
| 生图默认被指到只有 chat 的模型（CAPABILITY_UNAVAILABLE） | `settings_model=d502-image`（清单第一个）、runBtn 不拦、无任何提示 | 新建/未绑定节点时 `settings_model=fl-chat-only`（默认本身）、pill/note 明确「默认模型 fl-chat-only 没有这项能力（不会自动改用其它模型）」、`#runBtn[data-openarc-blocked=MODEL_UNAVAILABLE]`；宿主 `canvas/run kind=image` 仍 `CAPABILITY_UNAVAILABLE` + 0 新增请求 |
| 文本默认被停用（MODEL_DISABLED） | `chatSelect.value=d502-chat-only`（另一个可用模型）、runBtn `blocked=null` | `chatSelect.value=fl-chat`（默认本身，option disabled + 文案「（不可用）」）、note「默认模型 fl-chat 已停用（不会自动改用其它模型）」、runBtn `blocked=MODEL_UNAVAILABLE`；宿主 `canvas/modelChat` 仍拒绝 + 0 新增请求 |
| 用户显式选替代模型后刷新配置 | — | 保持用户选择（`chatSelect.value=fl-chat-only`），`data-openarc-default-unavailable` 移除 |

截图（浅色，应用实机）：
- `artifacts/dxos-canvas-fix-latency/shots/model-image-default-unavailable-light.png`
  （composer 模型 pill `fl-chat-only` + note）
- `artifacts/dxos-canvas-fix-latency/shots/model-chat-default-unavailable-light.png`
  （画布助手：下拉 `fl-chat（不可用）` + note）

断言明细：`artifacts/dxos-canvas-fix-latency/probe.json`（M1/M1b/M2/M2b/M2c 全 PASS）。

> 已知语义边界：门禁 N5c 的取证读数是"选中已有 n_gen 节点之后"的 composer —— 该节点在默认还可用时
> 已把自己的 `runSettings.model` 存成 `d502-image`，所以它显示的是**节点自己的模型**（可用、可运行），
> 不是页面替换了默认。新建 / 未绑定节点的 composer 才消费全局默认（本包探针 M1 即该场景）。
> 门禁 N5d 的取证已从 `chatSelect.value=d502-chat-only` 变为 `d502-chat`（默认本身）+ `MODEL_UNAVAILABLE`。

---

## 3. 门禁（`experiments/d5-02/canvas-e2e.mjs`，未改一行）

| 项 | 值 |
| --- | --- |
| 最终 | **PASS 48 / FAIL 0 / TOTAL 48**（notVerified 0，deleted 6，productGaps 2，exit 0） |
| 墙钟 | **80.31s**（`/usr/bin/time` real；同一轮 job 的构建与启动都在内） |
| F3d | **PASS，waitedMs=607**（阈值 5000），revision 稳定、DOM 命中、本地内容未覆盖 |
| 产物 | `artifacts/dxos-canvas-fix-latency/gate-final.log` / `gate-final.json` / `gate-final.time` |

> 修复前同一门禁：PASS 47 / FAIL 1 / TOTAL 48（唯一 FAIL = F3d 7316ms），见
> `experiments/dxos-canvas-revendor-next/GATE-REDIRECT.md` §1/§5。

---

## 4. 测试 / 构建 / 幂等

| 项 | 结果 |
| --- | --- |
| `node --test tests/d5-02-canvas-*.test.mjs tests/dxos-canvas-*.test.mjs` | **243 pass / 0 fail** |
| `npx tsc --noEmit` | **0** |
| `npx vue-tsc --noEmit -p tsconfig.vue.json` | **0** |
| `npm run build` | **exit 0** |
| vendor 连跑两次 | manifest sha256 **cffa65658bbe3e64273e5e6955780a7e05bba732400f0f16dd7981b2c755144d**（两次一致），stdout 一致 |
| vendor `--dry-run` | 新增 0 / 删除 0 / 内容变化 0 / 相同 60 |
| bundle | 67 files / 11,808,169 B；`static/` 60 files / 11,629,670 B（仍无 `canvas.js` / `canvas.html` / `css/canvas.css`） |

---

## 5. vendor 改动编号（顺延）

| # | 改动 | 落点 |
| --- | --- | --- |
| 16 | 宿主推送接收层 `smart-canvas-live-sync.js`（doc-changed → 页面原生三方圆并；输入/未保存不抢；updatedAt 幂等；`__openarcCanvasLiveSync` 证据面） | 模板 `experiments/d5-02/vendor/smart-canvas-live-sync.js` → 内联 `static/js/smart-canvas.js` L35937 起；manifest `smartLiveSyncHash=26f4ee46a7ecf38e` |
| 17 | 兜底轮询 8000 → 2500；`mergeReloadCanvasNow` 接同一条安全判定 | vendor `SMART_CANVAS_JS_PATCHES`；生成件 L11023 / L10982 |
| 12-v4 | 守卫 v4：显式默认不可用如实呈现（不静默换模型）+ 运行入口拦截 + 默认变更重置显式替代 | `experiments/d5-02/vendor/smart-canvas-guard.js`；生成件 L34839 起；manifest `smartGuardHash=13697c8d051585d1` |

manifest `smartJsHash=e875dc4c5dd14fee`；源 157 → 保留 60 / 裁剪 97。

---

## 6. 遗留 / 降级策略

1. **推送失败**：宿主 `toShell` 是 fire-and-forget（不阻塞轮询），iframe 未就绪 / 帧刚重置 / 宿主窗口关掉时
   推不进去不影响任何内容；页面 2.5s 兜底轮询会补齐。若用户一直处于输入/未保存状态，推送标记 pending 重试
   最多 15s，之后也交给兜底轮询（同一安全判定），**不会**为了"看起来实时"打断输入。
2. **同一次改动的重复刷新**：宿主按 `updatedAt` 去重；页面按 `canvas.updated_at` 幂等，旧包/重发一律跳过；
   页面自己保存成功后 updated_at 已对齐，不会把刚保存的内容再合并一遍（F3d 的 revision 5s 稳定）。
3. **宿主检测粒度 800ms**：`canvas/meta` 是只读内存查询；引用资源复核仍按原 2.5s 量级（每 3 个 tick），
   没有把 assetStates 提高到 800ms。
4. **其它轮询点**：站点自己的 WebSocket `canvas_updated`（`connectAssetLibrarySyncSocket`）在 iframe 里
   仍按上游设计直接 return（iframe 没有 host 的 ws）；本轮没有改它 —— 宿主推送 + 2.5s 轮询已覆盖 iframe 场景。
5. **节点级模型**：节点在默认还可用时保存的 `runSettings.model` 属于节点自己的配置；选中节点时 composer 显示
   该模型（可用则允许运行），不把它当成"默认被替换"。若要求"默认坏了时所有节点都提示"，属于新的 UI 需求。
6. **并发写入方**：本包未改画布域契约 / 权限语义 / `electron/canvas-domain|store|bootstrap`；
   `electron/canvas-service.cjs` 未改（推送在宿主渲染层完成，不需要主进程新事件通道）。
