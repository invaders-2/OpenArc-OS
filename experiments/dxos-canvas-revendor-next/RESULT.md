# DXOS-CANVAS-REVENDOR-NEXT · 执行结果

日期：2026-10-17
范围：重新从本地源 vendor → 只保留「列表页 + 智能画布」→ 删传统编辑器 → 守卫 / 适配器 / 只读闸 / 应用内模态移植 → 两处测试 fixture 改读取来源。

---

## 0. 前置检查（RUNBOOK 5 项）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | 源目录结构 | `/Users/wepingli/Desktop/NOVAI-Infinite-Canvas-main/NOVAI-v16/static`（唯一命中） |
| 2 | 样本身份 | git HEAD `22feb2988570bfce5b7476e26d7e0d313ab681db`；工作区脏 **161 个改动文件**；`matchesPin=false`（pin `1e20abe5…`） |
| 3 | 干跑 | exit 0；24 条脚本锚点 **MISS 0**；不落盘 |
| 4 | 锚点探针 | 66 条 MUST **全中**（MISS 0）；6 条 ABSENT 仍全部 absent |
| 5 | 干跑零落盘 | 干跑前后 `git status public/novai-canvas` 逐字节一致 |

**源身份（写入 manifest / SOURCE.md 来源块）**

```json
{
  "type": "git",
  "identity": "22feb2988570bfce5b7476e26d7e0d313ab681db",
  "capturedAt": "2026-10-17T10:22:48.547Z",
  "mode": "local-source",
  "matchesPin": false,
  "dirty": true,
  "changedFileCount": 161,
  "contentFingerprint": "sha256:771802e7b4e44feaacfb737d05d505fd1b45f369cb7ef0b1cd42f14881ff2b05",
  "files": 60,
  "bytes": 11539262
}
```

> 抓取时间在「源身份 + kept-set 内容指纹」都不变时复用上一次的值，所以连跑两次 manifest 逐字节一致；
> 源内容一变就自动写新时间。

---

## 1. `apiImageSize` 处置：**在新锚点重写**（不删）

**证据**：`artifacts/dxos-canvas-revendor-next/api-size-evidence.json`（真实 `/api/ai/size-policy` 表 + 宿主 `image-params.sizeFromRatio`）。

| 用例 | 上游新实现 | 本包补丁 | 宿主 `sizeFromRatio` |
| --- | --- | --- | --- |
| custom 1:1 @1k | 1536x1536 | **1248x1248** | 1248x1248 |
| custom 4:3 @1k | 1536x1152 | **1440x1072** | 1440x1072 |
| custom 1:1 @4k | 3840x3840 | **2880x2880** | 2880x2880 |
| custom 3:2 @4k | 3840x2560 | **3520x2336** | 3520x2336 |
| square @4k（free） | 2880x2880 | 2880x2880 | 2880x2880 |
| ultrawide @1k（free） | 2016x864（超 1k 档 1,572,864） | **1904x816** | — |
| square @4k（gpt-image-2 enum） | 2048x2048 | 2048x2048 | 2048x2048 |

**为什么不能删**：上游只做「长边定档 + 等比」，最后一步 `NovaSizePolicy.constrain` 只在宿主策略显式给了
`maxEdge/maxPixels` 时收口；default（free）策略的 `maxPixels=0`，档位像素上限被丢掉。于是
custom 1:1@1k 仍是 1536x1536、1:1@4k 仍是 3840x3840，与既有口径（1248x1248 / 2880x2880）不一致。

**补丁做法**（新锚点 = 上游 22feb298 的 `function apiImageSize(...)` 全文）：
保留上游的新能力（长边定档、官方 `SIZE_MAP`、`MODEL_TIER_PIXELS`、`NovaSizePolicy.constrain`），只补：
1. `fitApiSizePair()`：按该档位像素上限等比收窄 + 16 对齐；
2. custom/source 分支按「长边定档」收口；
3. 命名比例**不按档位长边二次收窄**（官方表 2k 超宽 2688、1k 宽屏 2016 的长边本来大于
   `RES_LONG_SIDE`，按长边夹会把 21:9 改成 2048x864，比例漂移 3.7%）；
4. 枚举模型（gpt-image-2）仍交给 `NovaSizePolicy.constrain` 吸附，不被档位收窄抢先改掉。

---

## 2. 收窄产物：删除清单与体积

白名单：`PAGE_WHITELIST = ['canvas-list.html', 'smart-canvas.html']`
排除页集合：`PAGE_EXCLUDE = ['canvas.html']`（否则 `extractStaticRefs` 会从列表页入口改向前留下的
kind 三元 / 注释里把 `/static/canvas.html` 再抽回来）。

### 2.1 真正删除的 3 个文件（闭包实测）

| 文件 | 字节 | 删除前被谁引用（证据） |
| --- | --- | --- |
| `static/canvas.html` | 45,629 | 只被 `canvas-list.html` 的 kind 三元引用（`openCanvas` / `createCanvasFromPicker` / `btnContinueLast`）；入口改向补丁落盘后列表页 0 处 `/static/canvas.html` |
| `static/js/canvas.js` | 824,303 | 只被 `canvas.html` 的 script 标签引用 |
| `static/css/canvas.css` | 168,364 | 只被 `canvas.html` 的 link 标签引用 |

合计 **1,038,296 B**。没有多删/少删：`tools/lossless-edit/index.html`（智能画布的 iframe 依赖）
及其 PSD 依赖 `vendor/ag-psd.js` 仍由闭包 + `EXTRA_KEEP` 保留。

### 2.2 前后对照

| 项 | 上一轮（HEAD 9e43b8d） | 本轮 | 差 |
| --- | --- | --- | --- |
| bundle 总文件 | 69 | **67** | −2 |
| bundle 总字节 | 12,684,800 | **11,784,658** | **−900,142 B** |
| `static/` 文件 | 63 | **60** | −3 |
| `static/` 字节 | 12,530,609 | **11,606,625** | **−923,984 B** |
| `static/` 页面 | 3 个（canvas-list / canvas / smart-canvas） | **2 个**（canvas-list / smart-canvas）+ 闭包带入的 lossless-edit | 传统编辑器下线 |
| bundle 根 | 6 个 | **7 个**（新增 `openarc-smart-adapter.js`） | +1 |

**`prune-public.mjs --check`（自洽）**

```
[prune] 源 static/ 文件 60；保留 60；删除 0
[prune] 保留 11605600 bytes；删除 0 bytes
[prune] vendor-manifest: 源 157 / 保留 60 / 裁剪 97（本次 bundle 内再删 0）
```

---

## 3. vendor 改动编号

| # | 改动 | 位置 / 结果 |
| --- | --- | --- |
| 1 | 每个保留页 `<head>` 注入 CSP meta + `openarc-bridge.js` | 3 个 HTML：canvas-list / smart-canvas / tools/lossless-edit/index.html |
| 5 | 清掉 bundle 根 `index.html` / `openarc-shell.js` 旧副本 | 仍然生效 |
| 10 | `prompt()` → 应用内模态 | 新源码 3 处（列表 1 / 智能画布 2），全部覆盖；模态脚本注入两个产品页 head:6 |
| 11 | 列表页入口全部改向 `smart-canvas.html` | LIST_PATCHES **14/14 命中**；改后列表页 `/static/canvas.html` 0 处、`createCanvasFromPicker('classic')` 0 处；参数仍是 `id` / `project`（智能画布 `params.get('id')/('project')`） |
| 12 | 智能画布守卫 **v3（重写）** | `experiments/d5-02/vendor/smart-canvas-guard.js` → 内联在 `static/js/smart-canvas.js` IIFE 尾（生成件 **L34838** 起）；**174** 个函数闸、**0** 缺失 |
| 13 | 收窄白名单 + 删传统编辑器 | `PAGE_WHITELIST` 2 页 + `PAGE_EXCLUDE`；删除 3 文件（见 §2） |
| 14 | 智能画布命令面移植 | `smart-canvas-internals.js`（生成件 **L34674** 起，`window.__openarcCanvasInternals`）+ `openarc-smart-adapter.js`（`static/smart-canvas.html:755`，`window.__openarcCanvas` / adapter-ready / command / undo / redo / state-request / reload-doc） |
| 15 | `apiImageSize` 在新锚点重写 | 见 §1 |

**注入点（生成件）**

- `static/js/smart-canvas.js`：internals `L34674` → guard `L34838` → 原 IIFE 收尾 `})();`
- `static/smart-canvas.html`：head `L5` bridge、`L6` rename-modal；`L755` smart adapter（在 smart-canvas.js 之后，defer 顺序）
- `static/canvas-list.html`：head `L5/L6`；入口补丁 14 处

**幂等**：连跑两次 vendor，`vendor-manifest.json` sha256 完全一致（`995828ad…e1c3`），stdout 逐字节一致；
随后 `--dry-run` ⇒ `新增 0 / 删除 0 / 内容变化 0 / 相同 60`。

### 3.1 新源码 vs 旧 pin：锚点移动 / 行为变化（下一包重定向必读）

| 项 | 旧 pin `1e20abe5` / 上一包 | 新源码 `22feb298`（本地脏 161） | 影响 |
| --- | --- | --- | --- |
| IIFE 收尾 | 旧 bundle `34579` | 新源码 `34633` | 注入点仍是 `lastIndexOf('\n})();')`，无需硬编码行号 |
| 视频入口 | `#apiKindToggle [data-kind=video]` | **已删除**；改成创建菜单 `[data-create-type="video"]` → `createImageNodeAt(..., {type:'smart-video'})` | 旧守卫对 `apiKindToggle`/`syncApiKindToggleVisibility` 的引用会抛 ReferenceError；v3 已按新符号重写 |
| `SIZE_MAP` | 9 个通用比例 | **15 个 APIMart 官方比例**（square 4k 2880x2880、ultrawide 1k 2016x864 等） | 命名比例像素变了；宿主 `IMAGE_SIZE_TABLE` 仍是旧 9 比例（13 个已知差异格，见 §6） |
| `apiImageSize` | 旧实现（custom/source 只压一侧） | 重写为「长边定档 + 等比 + NovaSizePolicy.constrain」；仍缺档位像素上限 | 补丁在新锚点重写（§1） |
| 尺寸能力表 | 无/较少 | 新增 `MODEL_CAPABILITIES` / `MODEL_TIER_PIXELS` / `imageResLevelsFor` / `imageRatiosFor` / `apiRatioSnap*` | 支持 0.5k/1.5k/3k 与比例吸附；守卫不碰这些（交给页面原生） |
| 节点类型 | `smart-image` 为主 | 新增 `smart-video`（`isSmartVideoNode` / `isSmartMediaNode` / `smartNodeCarriesVideo`） | 适配器做 `video → smart-video` 映射；只读闸覆盖视频节点创建 |
| 函数增删 | — | 删 `createLoopNode` / `renderSizeControls` / `renderRatioControl` / `renderResolutionControl` / `syncApiKindToggleVisibility`；增 `pickLocalMediaForNode` / `applySmartMediaTypeForKind` / `arrangeSmartGroupMembersInFrame` 等 | 守卫函数闸 174 个、0 缺失；新增的可变文档函数已补包 |
| 锚点行号漂移（旧→新） | `DEFAULT_VIDEO_MODELS` 4074 / `volcengineProvider` 3767 / `modelscopeImageModels` 4064 / `resolveChatModel` 3899 / `apiImageSize` 4331 / `runGeneration` 27628 / `saveCanvas` 11653 | 4081 / 3774 / 4071 / 3906 / 4338 / 27666 / 11660 | 所有守卫/适配器锚点已按**符号名**而非行号定位；`anchor-probe.mjs` 66 MUST 全中 |
| 列表页 | 入口 14 处 | 上游只改了 2 行；14/14 入口补丁仍命中 | 入口改向无需改锚点 |
| 智能画布 HTML | `#apiKindToggle` + 创建菜单「上传」 | 删除 kind toggle；创建菜单拆成「图片节点 / 视频节点」 | E3b/E3c 用新选择器；`apiKindToggle:false` 已成为断言 |


---

## 4. 守卫 / 适配器 / 只读闸 / 模态：注入点与覆盖清单

### 4.1 单一真源（C1）

| 页面侧兜底（新源码实际符号） | 处置 | 证据面 |
| --- | --- | --- |
| `DEFAULT_VIDEO_MODELS`（11 个写死模型） | 数组就地清空 | `__openarcSmartGuard.hostVideoModels()` |
| `volcengineProvider()`（凭空造火山） | 只返回宿主真实 provider，否则空模型 stub | `facts().providers` / `providers()` |
| `volcengineVideoModels()` | 宿主 `video_models` 才返回 | `hostVideoModels('volcengine') = []` |
| `modelscopeImageModels()`（默认 Tongyi-MAI） | 无宿主 modelscope ⇒ `[]` | `hostImageModels('modelscope') = []` |
| `resolveChatModel()`（不再有 gpt-4o-mini） | 只从宿主 chat 模型取，无则空串 | `hostChatModels()` |
| `unifiedPlatformEntries()`（恒列 4 引擎） | 「其它引擎」只列真实 provider | 平台控件 0 个页面内置引擎（真机 E2） |
| `renderModelControl()` / `renderVideoModelControl()` | 清单外 `settings.model/videoModel` 不再渲染 | 真机 E2 + `providers()` |
| `MS_GEN_MODELS` / 默认 `msgenModel='zimage'` | 无宿主 modelscope ⇒ `[data-smart-param=msgenModel/msCustomModel]` disable + 运行入口拒绝 | 真机 E3/截图 |
| `comfyInstanceCount = Math.max(1, …)` | 宿主未投影 ComfyUI ⇒ 置 0 | `facts().comfy` |
| 四把记忆键 `smart_chat_model` / `smart_chat_provider` / `smart_agent_image_provider` / `smart_canvas_recent_run_settings_v1` | 实例 + 原型两层锁：读恒 null、写丢弃、旧值清除 | 真机 E2b（写 FAKE 后读回 null） |

### 4.2 未接通能力如实禁用（C2）

- 创建菜单 `[data-create-type="video"]`：`disabled` + `aria-disabled=true` + `data-openarc-unavailable="video-generation"` + `title`；
  `createNodeFromMenu('video')` 页面侧拒绝；可编辑态截图里是 0.45 透明、不可点（`smart-video-menu-light.png`）。
- 既有 `.openarc-guard-note[data-openarc-guard-note="video-generation"]` 文案：
  **「OpenArc 未接通视频传输（不可用）」**（与经典守卫逐字一致），挂在 composer head；
  comfy 在选中 comfy 引擎时同样出现 note。
- `#engineSelect` 的 `volcengine/modelscope/comfy/runninghub` option：未投影/未接通 ⇒ `disabled` +
  `data-openarc-unavailable`。
- 视频参数 pill、ModelScope 功能/自定义模型、ComfyUI 模式/工作流：不可用时 `disabled`；
  历史 `settings.engine` 指向未接通引擎时在 `loadConfig` / `renderDynamicParams` 两处回落 `api`。
- 运行入口：`runGeneration` / `runApiVideoGeneration` / `runModelscopeGeneration` / `runComfyGeneration` /
  `runPromptLLMNode` / `createSmartComfyTask` 按能力事实拒绝；`runBtn` 打 `data-openarc-blocked`。
- `/api/canvas-video`、`/api/canvas-comfy-tasks`：页面侧 501 `CAPABILITY_UNAVAILABLE`（真机 E3 实测）。

### 4.3 只读闸（C3，四层）

| 层 | 做法 |
| --- | --- |
| 上下文 | 桥 `openarc-canvas-context` → `window.__openarcCanvasReadOnly`（`readOnly`/`canEdit` 都认；后到 context 同样生效） |
| 事件闸 | window 捕获阶段拦 `mousedown/pointerdown/click/dblclick/contextmenu/dragstart/dragover/drop/paste/cut/beforeinput/input/change`；编辑面含 `#world/#composer/#createMenu/#smartTitle/#imageEditModal/#smartTextModal/#promptTemplatePanel/#promptPresetPanel/#assetPanel/#versionPanel/#chatModal/.smart-control/.nie-outpaint-panel` 等；键盘 Delete/Backspace/方向键/Cmd+Z、Y、V、A、D、G、X |
| 函数闸 | **174** 个改文档闭包函数（增删/分组/连线/拖动提交/缩放/图片编辑/参数/模板库/素材库/Agent ops/生成落图/保存/撤销重做…）；被 `window.*` 提前导出的重新指到包装实现 |
| 写闸 | fetch 只读时非 GET/HEAD/OPTIONS ⇒ 页面侧 403 `READ_ONLY`，后端收不到写请求 |

**真机逐条用例（58 PASS / 0 FAIL）**：P01 拖动、P02 缩放、P03 框选、P04 多选、P05 底栏新增、
P06 右键创建菜单、P07 Delete、P08 工具条删除、P09 端口连线、P10 断线、P11 分组、P12 取消分组、
P13 表格内联、P14 参数/引擎、P15 右键菜单、P16 方向键、P17 粘贴、P18 素材拖入、P19 图片编辑/版本、
P20 Agent applyOps、P21 撤销重做、P22 模板库、P23 saveCanvas + 直接 PUT、**P24 视频节点创建**、
**P25 标题就地重命名**；S4 后到 context 的 L01–L08；S3 可编辑回归 R01–R09；S2.1 服务端 revision 不变。
每条断言 = 被拒（blocked+） + 文档逐字节未变 + 0 后端写请求。

### 4.4 应用内模态

新源码 prompt 调用点：`canvas-list.html` 1 处（重命名画布）、`smart-canvas.js` 2 处（模板分组新建/重命名）。
3 处全部走 `window.__openarcPrompt`；`openarc-rename-modal.js` 注入两个产品页 head:6。真机 E8 实测
（打开 + 预填 + Esc 关闭）。

### 4.5 适配器（第 14 处）

`window.__openarcCanvasInternals`：`getState / isReadOnly / setReadOnly / primitives`（`addNode / deleteNodes /
pushUndo / performUndo / performRedo / canUndo / canRedo / render / scheduleSave / saveNow / sanitizeConnections /
setNodes / setConnections / setCanvasMeta / setViewport / getNode / serializableNodes / markSynced / applyDoc /
snapshotDoc / runNode`）。撤销/重做直接用页面原生 `undoStack/redoStack`，不另造第二条 redo 栈；
`runNode` 与节点 ▶ 同一条 `runGeneration`。

`openarc-smart-adapter.js`：同一套宿主协议（`adapter-ready / command / undo / redo / state-request / reload-doc`），
命令映射按智能节点模型：`image/generator/output → smart-image`、`llm/prompt → smart-prompt`、
`video → smart-video`、`group → smart-group`、`table → table`；`openarc-asset:` 引用先经桥
`library.resolve` 换成可显示地址；`window.__openarcCanvas` 暴露 `state/applyCommand/runNode/getNode/undo/redo/canUndo/canRedo/readOnly`。

### 4.6 明确拦不住的（如实登记）

| # | 拦不住的点 | 原因 / 兜底 |
| --- | --- | --- |
| 1 | 拖动/缩放**过程中**节点已在屏幕上移动 | 手势处理器是闭包内匿名/const，capture 闸只能拦「手势开始」；运行中切只读的极端时序会留一帧位移，`commitPendingUndo` 会回滚快照 |
| 2 | 节点内联 `contenteditable` 直改 DOM 文本 | 只读时事件闸挡住 `beforeinput/input`，但它本身不是函数；纯本地输入不等于改文档 |
| 3 | 服务端副作用（版本还原/删除、Agent apply、生成） | 拦的是页面侧入口函数；宿主权限（`model.use` / 画布写权限）仍是最后一道 |
| 4 | 别的窗口 / 宿主 IPC 对同一本画布的写入 | 不是「页面只读闸」的职责（经典画布也一样） |
| 5 | 表格/批量节点用外部 `shared/table-node.js` | 模块内部没有可包装的注入点，靠事件闸整体挡在交互层之前 |

---

## 5. 真机证据（真实 Electron + 隔离 userData + 唯一 CDP）

### 5.1 入口 / 单一真源 / 未接通 / 真实模型 / 返回列表 / 模态 / 0 错误
`entry-probe.mjs` ⇒ **22 条检查全部 PASS / 0 FAIL**（控制台 `PASS 21` 之后还有 1 条收工 profile 检查）

| 用例 | 结果 | 证据 |
| --- | --- | --- |
| E1 新建 → `smart-canvas.html`（不是经典） | PASS | `entry-probe.json` E1 |
| E2 供应商/模型只来自宿主 | PASS | providers = 宿主 provider；平台控件 0 个页面内置引擎 |
| E2b 四把记忆键锁死 | PASS | 写 FAKE 后读回 null，`locked=true` |
| E2c 命令适配器就绪 | PASS | `window.__openarcCanvas.state().canvasId` 与宿主一致 |
| E2d 命令适配器真实执行 | PASS | `node.add → node.move(x=260) → node.delete → undo/redo` 全部经 `window.__openarcCanvas` 生效 |
| E3/E3b/E3c 视频未接通如实禁用 | PASS | disabled + `data-openarc-unavailable` + 既有文案；创建菜单里 0.45 透明不可点 |
| E4 编辑 + 真实模型调用 | PASS | 本地确定性 provider 真实 SSE，页面文本 === 期望文本 |
| E5/E6/E7 返回列表 / 继续上次 / 卡片直达 | PASS | 同一本 canvasId |
| E8 重命名走应用内模态 | PASS | 打开 + 预填 + Esc 关闭 |
| E9 只读 context | PASS | `data-openarc-readonly=1` + composer `pointer-events:none`；恢复 = 0 |
| E11 0 console error / 0 pageerror / 0 条 404 / 0 条 5xx | PASS | 全 0 |
| f 真实 profile 收工前后未变 | PASS | 只读快照完全一致 |

### 5.2 只读逐条
`readonly-probe.mjs` ⇒ **PASS 58 / FAIL 0**（见 §4.3）。

### 5.3 截图（浅/深）

| 浅色 | 深色 |
| --- | --- |
| `shots/list-light.png` | `shots/list-dark.png` |
| `shots/smart-edit-llm-light.png`（真实模型调用后） | — |
| `shots/smart-video-disabled-light.png` | `shots/smart-video-disabled-dark.png` |
| `shots/smart-video-menu-light.png`（创建菜单里视频节点禁用） | — |
| `shots/smart-readonly-light.png` | — |
| `shots/list-rename-modal-light.png` | — |
| `shots-readonly/editable-seeded-light.png` / `editable-after-edits-light.png` / `readonly-blocked-toast-light.png` | — |

---

## 6. 测试与构建

| 项 | 结果 |
| --- | --- |
| `node --test tests/d5-02-canvas-*.test.mjs tests/dxos-canvas-*.test.mjs tests/canvas-library-list.test.mjs tests/dxos-canvas-size-policy.test.mjs tests/dxos-image-params.test.mjs` | **252 pass / 0 fail** |
| `npm run build` | **exit 0**（含 `tsc --noEmit`） |
| `npx tsc --noEmit` | **0** |
| `npx vue-tsc --noEmit -p tsconfig.vue.json` | **0** |
| `prune-public.mjs --check` | bundle 60/60/0；manifest 157/60/97 |
| vendor 幂等 | 两次 manifest sha256 相同；dry-run 0/0/0/60 |

两处测试 fixture 只改读取来源：

- `tests/dxos-canvas-size-policy.test.mjs`：`canvas.js → smart-canvas.js`；抽取 `SIZE_MAP / API_RES_LEVELS /
  RES_LONG_SIDE / RES_PIXEL_LIMIT_FALLBACK / parseRatioValue / parseSizePair / resPixelLimitFor /
  fitApiSizePair / oaTierFit / apiImageSize`；C1/C2 断言口径未放宽，另加 `gpt-image-2 4K 方图 = 2048x2048`。
- `tests/dxos-image-params.test.mjs`：`canvas.js → smart-canvas.js`。上游 `SIZE_MAP` 已换成 APIMart 官方
  15 比例表，宿主 `IMAGE_SIZE_TABLE` 仍是旧 9 比例表；测试改为**逐格钉住两边 + 13 个已知差异格**，
  并把旧的 `<select>` 比例下拉断言换成 `apiRatioText` 标签表（新 UI 没有 select）。

---

## 7. 门禁重定向清单（`experiments/d5-02/canvas-e2e.mjs`，本包**未改**）

> **后续包已完成**：重定向执行记录、逐用例处置、删除登记与最终门禁数字见
> `experiments/dxos-canvas-revendor-next/GATE-REDIRECT.md`（2026-10-17，PASS 47 / FAIL 1 / TOTAL 48）。

> 行号 = HEAD `9e43b8d` 的 1714 行版本。核心变化：`canvasFrame()` 现在永远匹配不到（canvas.html 已删）；
> 编辑器唯一是 `smart-canvas.html`；智能画布现在有 `window.__openarcCanvas` / `__openarcCanvasInternals`；
> 视频从 `#apiKindToggle` 改成创建菜单的 `[data-create-type=video]`；经典守卫的页头状态位 / 引导按钮 /
> `data-openarc-default-unavailable` 在智能画布**没有**。

| 用例 | 现依赖（行） | 处置 | 改法 |
| --- | --- | --- | --- |
| 帧选择器 | `canvasFrame()` L71、`shellFrame()` L75 | **必须改** | 正则换成 `/static/smart-canvas\.html/`；`shellFrame = listFrame() \|\| smartFrame()` |
| `reopenCurrentCanvasFromHome` | L192-209 | **改** | `#backToManagerBtn` → `.smart-back` |
| A0/A1 | L227/249/259 | 保留 | 页面无关 |
| A2 | L266-269 | **改** | `SUBPAGES` 去掉 `smart-canvas`（它现在是唯一编辑器，再列就自相矛盾） |
| A3 | L285-296 | **改指向智能画布** | `canvasFrame → smartFrame`；适配器断言保留（`__openarcCanvas.state()` 现在存在）；`#canvasPickerOverlay` 遮挡层判定保留 |
| A4 | L298-304 | **改** | `#backToManagerBtn` → `.smart-back` |
| A5 | L312-318 | **改** | frame → smart；`__openarcCanvas.state()` 可直接用 |
| A6 | L326-330 | **改** | frame → smart；canvasId 断言保留 |
| A7 | L333-344 | **改（命令语义）** | 命令面现在存在，但 `prompt → smart-prompt`、`llm → smart-prompt`（不是可运行 LLM 节点）、`generator → smart-image`；断言要按新类型改，或改用 `__openarcCanvasInternals.primitives` |
| A8 | L347-356 | **改** | 用页面原生 `window.__openarcCanvas.undo/redo` + `primitives.getNode`；节点类型按上条映射 |
| A9/A10 | L442-455 | **改** | `.smart-back`；frame → smart；节点/连线计数按智能模型 |
| N1 | L365-390 | **改** | 经典 `.canvas-nav-meta[data-openarc-model-status]` / `.llm-provider-select` 不存在；换 `#engineSelect` / `#unifiedPlatformControl [data-unified-engine]` / `[data-smart-param=provider_id/model]` / `#chatModelSelect`；状态 chip 未实现，需裁决「补契约」或「删该断言并登记」 |
| N2 | L393-405 | **改/待裁决** | 智能画布没有 `[data-openarc-open-model-settings]` 引导按钮；要么下一包补引导，要么删用例并登记缺项 |
| N3 | L408-436 | **改** | 换 `#createMenu [data-create-type=video]`、`[data-smart-param=videoProvider/videoModel]`、`[data-openarc-guard-note=video-generation]`；`data-openarc-capability/available` 节点徽标未实现；运行按钮 `data-openarc-blocked` 已实现 |
| B1 | L477-505 | **保留 + frame** | `/api/config` 投影不变 |
| B2 | L507-517 | **改** | 经典 LLM 节点 → 智能 `smart-prompt` + `.prompt-node-run` / `runPromptLLMNode`；或 `__openarcCanvas.runNode` |
| B3 | L519-529 | **改** | `generator → smart-image`；智能画布会新建 pending 分支输出，断言要按 `pending/output` 语义改 |
| B4 | L531-540 | **改** | 失败展示换 `runError` / 日志；不再有经典 `runStatus` 口径 |
| N4 | L544-575 | **改** | 经典四下拉 + 三把 `canvas_*` 键 → 智能锚点 + 四把 `smart_*` 键（已锁） |
| N6 | L580-597 | **保留 + frame** | `/api/canvas-llm` 清单外模型 502 与页面无关 |
| B5 | L599-604 | **保留** | `/api/canvas-video` 页面侧 501 仍然成立 |
| B6 | L606-611 | **保留 + frame** | `shellFrame` 改 smart |
| D1 | L614-627 | 保留 | IPC |
| N5a | L622-634 | **改** | 经典模型区快照 → 智能模型区（`#engineSelect` / pill / `#chatModelSelect`） |
| D2 | L636-653 | 保留 | IPC |
| N5c | L655 | **改/缺项** | 智能守卫没有 `data-openarc-default-unavailable` 契约；需补或删用例并登记 |
| D3/D4/D5 | L669-710 | 保留 | IPC / 预算 / 停止 |
| F1 | L722 | 保留 | 任务模型绑定 |
| N5d | L731 | **改** | 同 N5a |
| F3a/F3b/F3c | L750-791 | **部分改** | 存储/资源引用断言保留；页面呈现换 smart |
| F3d | L795-834 | **改** | `__openarcCanvasInternals` 现在存在；经典 D1 `saveTimer` 补丁已随 canvas.js 删除；智能画布用 `canvasSyncInFlight/dragState/selectionState` 轮询，需按新结构重写「本地保存后宿主新增能进来」 |
| F3e | L836-915 | **改/待裁决** | 智能画布有原生 409 合并（`applyMergedServerCanvas/setSmartServerBase`），但**没有** `<id>-remote` 副本语义；要么移植，要么降级并登记缺项 |
| E1 | L918-923 | **保留 + frame** | 无桥/Node/IPC |
| E2 | L925 | **必须改** | 抓 `/static/js/canvas.js` → `/static/js/smart-canvas.js`（否则断言打到已删文件，404） |
| E3 | L932 | 保留 | 伪造身份 |
| E4 | L951-988 | 保留 | 伪造帧用 canvas-list |
| E5/E5b/E6 | L988-1003 | **保留 + frame** | 出网拦截 |
| E7/E8 | L1016-1029 | 保留 | 账号边界 |
| F4 | L1044+ | **改** | AI 编辑链依赖命令层；智能适配器已有 `applyCommand/runNode`，但节点类型/输出语义要改 |
| F3f | L1096-1150 | **改/删除** | AI 来源标记 + 淡入未移植（`canvas-ai-marks.js` 只服务经典 `renderNode`）；下一包要么按智能 `render()` 重写，要么删用例并登记 |
| F3g | L1195+ | 保留 | 回收站 FAB（列表页） |
| F3h | L1307+ | 保留 | 卡片菜单（列表页） |
| Z1 | L1320 | 保留 | 主进程错误 |
| F4b | L1685+ | **改** | 同 F4 |

**同批必须一起改的**：`tests/dxos-canvas-asset-refs.test.mjs` 已按「实际存在的页面」动态断言，删 canvas.html
后自动只剩两页，**不用改**；`tests/dxos-canvas-size-policy.test.mjs` / `tests/dxos-image-params.test.mjs`
本包已改（见 §6）；`experiments/dxos-canvas-llm-stream/real-device-smart-canvas-stream.mjs` 的 C7（经典画布回归）
下一包重定向/删除。

---

## 8. 遗留

1. `experiments/d5-02/canvas-e2e.mjs` 未改；按 §7 重定向后，N1/N2/N5c 的「状态位 / 引导按钮 /
   `data-openarc-default-unavailable`」需要先决定「补契约」还是「删用例并登记缺项」。
2. 智能画布没有移植 AI 来源标记 / 淡入（F3f）与 `<id>-remote` 副本（F3e）；智能原生 409 合并已覆盖
   「双方内容都不丢」，但两者语义不完全等价。
3. 宿主 `electron/image-params.cjs` 的 `IMAGE_SIZE_TABLE` 仍是旧 9 比例表，与上游新官方 15 比例表有
   13 个已知差异格；测试已逐格钉住，宿主是否跟进属于 `electron/**` 的后续改动。
4. 经典 `openarc-adapter.js` / `openarc-canvas-guard.js` 仍留在 bundle 根（已无页面加载）；可在下一个
   清理包删除，或保留作为门禁重定向前的对照。
5. 只读闸拦不住的 5 类见 §4.6。
