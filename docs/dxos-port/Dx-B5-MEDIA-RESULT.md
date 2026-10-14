# Dx-B5-MEDIA-RESULT · 媒体域补齐 + ComfyUI 移除（范围变更）报告

> 依据：本轮任务「ComfyUI 就不要了吧，其他继续」。分支 `dxos-port/r1`，起点 `b4034b1`（B7 收口）。
> 本次两件事：① **按用户决定把 ComfyUI 从移植范围移除**；② 补齐 §2.1 媒体清单里此前未做的剩余部分（B5 只完成了 FFmpeg 渲染那一半）。

## 1. 范围变更：ComfyUI 移除

| 项 | 内容 |
|---|---|
| 决定 | 用户明确「ComfyUI 就不要了吧」（2026-10-14），不再作为可选插件/域提供 |
| 删除 | 8 个模块 `comfy-{domain,workflow,store,worker,service,bootstrap,bridge,projects}.cjs` + 4 个测试文件，共 **−3,994 行**（`git diff --stat` 28 文件） |
| 接线清理 | `main.cjs`（去 bundle 与 `registerComfyIpc`）、`preload.cjs`（去顶层键 `comfy`，**26→25**）、`src/types/openarc-ipc.d.ts`（去 `OpenArcComfy*` 与 P1 的 `comfy?`）、`dxos-foundation-paths.cjs` 目录表、`developer-service.cjs` 悬空注释、`agent-cli-bridge.cjs` 兼容候选 |
| 随之丢失的能力 | ComfyUI 受监督实例监督 + 工作流执行 + 桥接安装；需恢复时须重建上述模块并重新接线（含 `comfy:command` 域与 preload 键） |
| 合理保留（非残留缺陷） | 既有 D5-02 画布的 `NODE_TYPES "comfy"` 与 `CanvasHost` 引用（属既有界面且一直显示"未接入（不可用）"）；`plugin-runninghub.cjs` 的第三方上游 URL；`experiments/d5-02`、`experiments/d5-03` 历史实验与 vendored 代码；历史文档中作为"上游能力"的提及（只加注移除日期与原因，不改写原结论） |
| 文档 | `Dx-B7-RESULT.md` 追加 §8「范围变更：ComfyUI 移除」；6 份历史文档在提及处加注 |

## 2. 媒体域补齐（§2.1 剩余部分）

| 源文件 | 落点 | 关键点 |
|---|---|---|
| `backgroundRemoval.ts`(282) | `media-background-removal.cjs`(327) | onnxruntime + sharp **惰性**；本机缺依赖 → `MEDIA_DEPENDENCY_UNAVAILABLE` 且 detail 写明"装什么、模型放哪"，**不下载模型、不返回假图**；注入假 session 时真实推理路径可跑通（产出真 PNG 头） |
| `aiImageDeclaration.ts`(373) | `media-ai-image-declaration.cjs`(593) | JPEG/PNG/WebP 声明写入→解析往返；单图直出与 ZIP 打包；二进制出口用 base64url（绕开绝对路径脱敏误伤字节） |
| `shortDrama.ts`(515) | `media-short-drama.cjs`(687) | 分镜编排（Timeline）与渲染提交，与 B5a 受监督渲染 worker 对接；分镜图落 DX 虚拟树 |
| `library.ts`(535) | `media-library.cjs`(544) | 扫描根注入、标签与元数据、artwork 目标与写入；`streamTrack`（Express Range）按 OUT 未纳入命令面并注明 |
| `illustratorConfig.ts`+`illustratorTempExports.ts` | `media-illustrator.cjs`(252) | 配置与临时导出；本机无 Illustrator 时结构化不可用（探测到也用同一闸门，不假驱动） |
| `figmaPreview.ts`(43) | `media-figma-preview.cjs`(117) | 注入 fetch 的清单解析 + 白名单过滤（`../evil.ts` 被剔除） |
| `director3dModels.ts`(147) | `media-director3d.cjs`(151) | 本地扫描与条目投影、非法条目剔除；模型下载（联网/商业化）OUT |
| `publicMedia.ts`(84) | `media-public-media.cjs`(126) | **只做本地部分**（本地映射 + 路径穿越拒绝）；临时上传与外部图床按 OUT 删除并注明 |

**命令面**：并入既有 `media:command`（**不新建域、不新增 preload 键**），命令表 16 → **50** 条，每条含 risk/credential/中文 summary；测试强校验"命令表↔dispatch↔实现"一一对应。

## 3. 真实依赖接线（关掉"已实现未接通"）

B5e 交付时自报：`main.cjs` 未接线，短剧渲染/Figma 构建/Illustrator/音乐库刮削在真实 App 一律结构化不可用。本次接线（`main.cjs` + `media-service.cjs`）：

- `fsAdapter` ← B6d 的 `createDxosFsAdapterForUserData`（与 agent/skill **同一份实例**，落 `<userData>/dxos/fs`）
- `fetchImpl` ← `createGuardedFetch(全局 fetch)`：**拒绝 `api.dx-os.com` 与 `*.dx-os.com`**，只放行本地/用户自配端点（探针实测抛 `MEDIA_FORBIDDEN`）
- `providerStore` / `modelGateway` ← B2 既有出口（`call` / `generateImage` / `legacyExecute(editImages)`），密钥只在 service 内解出
- `onnxRuntime` / `modelDir` / `modelPath` / `illustratorAvailable` ← 依赖探测结果
- `viteBuild` ← **保持 null**（本仓 vite 仅在 devDependencies，无随包构建器）——如实不可用，不假接
- `media/health` 与 `bundle.dependencies` 合并**同一份** `extensionDependencies` + `dependencyNotes`（每条 false 的原因）；未注入分支**未放松**，仍结构化 `MEDIA_DEPENDENCY_UNAVAILABLE`

## 4. 真实命令与真实输出

```
$ npm run build                                              BUILD_EXIT=0

$ npm test                    （独占）
1..2418
# tests 2418 / # pass 2417 / # fail 1                      TEST_EXIT=1
唯一失败：not ok 337 - D5-03-E（基线既有环境项）
（总数由 B7 的 2443 降为 2418：移除 ComfyUI 的 4 个测试文件约 −51 例，新增媒体 3 个测试文件 +45 例）

$ npm run test:model-ipc-ui   （真实 Electron，preload 25 键）
10/10 IPC checks passed                                     MODELIPC_EXIT=0
$ npm run test:design-system                                 DS_EXIT=0
$ node experiments/dxos-b5/run-all.mjs   真实 ffmpeg 全链路通过  MEDIA_EXIT=0

$ node --test tests/dxos-media*.test.mjs                     # tests 46 / pass 46
$ node --test tests/dxos-media-extensions.test.mjs           # tests 16 / pass 16
$ node --test tests/dxos-media-wiring.test.mjs               # tests 10 / pass 10
$ node --test tests/dxos-foundation.test.mjs tests/dxos-plugin-ipc.test.mjs tests/dxos-platform-ipc.test.mjs tests/dxos-developer-ipc.test.mjs tests/dxos-canvas-capabilities.test.mjs tests/dxos-plugin.test.mjs
                                                             # tests 62 / pass 62
```

## 5. 未验收 / NOT VERIFIED

1. **真实 Electron 启动**：媒体接线靠"源码级装配契约 + 同一 helper 进程内真跑"覆盖，不等同真实 app 启动（未跑 build/启动 GUI 的约束仍在）。
2. **真实 onnxruntime 推理**：本机未装 `onnxruntime-node` 也无 `.onnx` 模型 → 抠图"可用分支"只用注入假 session 验证；本机为依赖缺失态且如实报错。
3. **Illustrator 真导出**：本机探测到 Illustrator 2026，但 B5e 命令面本就只做配置/临时导出、不驱动 Illustrator，真实导出未验证。
4. **Figma 构建**：`viteBuild` 保持 null，真实 App 仍结构化不可用（如实未接线，不是遗漏）。
5. **真实上游模型调用**：只验证了经 B2 既有出口的映射与失败不假成功，未联网。
6. **ComfyUI 移除后的画布表现**：既有画布 `comfy` 节点类型保留且一直为"未接入"，移除后行为不变（未做真机截图复核）。

## 6. 结论

媒体域补齐（8 模块、命令表 16→50、真实依赖接线与出口护栏）与 ComfyUI 干净移除均已完成并通过门禁：build ✅、全量测试 ✅（唯一失败为基线 #337）、真机 preload 探针 ✅（25 键）、design-system ✅、媒体真机探针 ✅。ComfyUI 的移除有完整台账（被删清单、丢失能力、恢复前提、合理保留项），历史文档只加注不改写。


## 7. 独立验证与收口

**验证岗结论**：A（媒体域剩余）**结构/语义/接线成立** —— 8 个 `.cjs` 与 9 个源文件逐一对上（4 个未搬函数均为已注明 OUT：`downloadBackgroundRemovalModel`/`streamTrack`/`downloadDirector3DModel`/`uploadCanvasFreeMedia`），语义抽查 8 处无功能偏差；接线真实（`main.cjs:676-700` → `media-service.cjs:419-443` → `configureMediaExtensions`，`media/health` 与 `bundle.dependencies` 展开同一份 `extensionDependencies/dependencyNotes`，未注入分支实测仍结构化拒绝）；运行 46/46。B（ComfyUI 移除）**干净、残留缺陷 0**：代码内仅 5 处 comfy 且全为合理保留（D5-02 画布、RunningHub 上游 URL、负向断言/注释），`require(...comfy...)`/`createComfyBundle`/`comfy:command` 全为 0，preload 恰 25 键、类型与 main 已清、文档台账齐全。C 约束零违规（7 个受约束文件相对 `dc3bfa6^` 零改动、无新增依赖）。

**验证岗发现并在本批关闭的三处真缺陷**（B5g，含修复前/后对照证据）：

| 严重度 | 问题 | 处置与证据 |
|---|---|---|
| 低-中（本批新增） | `media-short-drama.cjs:121` 使用**未导入**的 `MEDIA_ERR_CONFLICT` → "项目文件夹丢失/在废纸篓"分支抛 `ReferenceError`，稳定错误码退化为内部码 | 补导入（`media-domain.cjs:41`，值 `MEDIA_CONFLICT`）；新增回归用例。**修复前**：`ReferenceError: MEDIA_ERR_CONFLICT is not defined` → **修复后**：`MediaError MEDIA_CONFLICT` |
| 低（B5a 既有） | `media-store.cjs:461/462/471` 使用**未导入**的 `MEDIA_ERR_POSTER_FAILED` → 封面"失败退避/队列满/空封面"三分支抛 `ReferenceError` | 补导入（`media-domain.cjs:47`，值 `MEDIA_POSTER_FAILED`）；三分支各加用例。**修复前** 3 条 `ReferenceError` → **修复后** 稳定码 + 中文原因 |
| 低（纵深防御） | 出口护栏只识别 string/input.url，`new URL('https://api.dx-os.com/x')` 与尾点域名 `api.dx-os.com.` 可绕过 | 改为统一取 URL 文本（string/URL/Request/带 url\|href 对象）→ `hostname` 小写化 → **剥离尾随点** → 后缀匹配；新增矩阵用例：string/Request/URL × {api.dx-os.com, sub.dx-os.com, API.DX-OS.COM, api.dx-os.com:8443, api.dx-os.com.} **全部 MEDIA_FORBIDDEN**，同时 `127.0.0.1`/`example.com`/`notdx-os.com`/`api.dx-os.com.evil.example` 仍放行（防过度拦截） |

**验证岗如实登记的观察项（未改，非缺陷）**：`director3d` 未注入目录时返回空列表（源为云端 OUT，属静默空目录、无假数据）；依赖注入为模块级单例（生产单 bundle，测试 `afterEach` 已 reset）。**未验证项**：真实 Electron 启动、真实 onnxruntime 推理、真实网络往返、真机 25 键探针（Lead 门禁已覆盖）、`experiments/dxos-b5` 真实 ffmpeg（验证岗为避免写 artifacts 未跑；Lead 门禁已跑并通过）。

**收口后验收**：`node --test tests/dxos-media*.test.mjs` → **52/52**；`npm test` 与 `npm run build` 见 §8。

## 8. 收口后最终门禁

```
$ npm run build                                              BUILD_EXIT=0
$ npm test                    （独占）
1..2424
# tests 2424 / # pass 2423 / # fail 1                      TEST_EXIT=1
唯一失败：not ok 337 - D5-03-E（基线既有环境项）
$ node --test tests/dxos-media*.test.mjs                     # tests 52 / pass 52
```

