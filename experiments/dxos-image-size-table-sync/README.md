# DXOS-IMAGE-SIZE-TABLE-SYNC · 宿主尺寸表对齐 APIMart 官方 15 比例表

## 结论

- 上游 public/novai-canvas/static/js/smart-canvas.js 的 SIZE_MAP 是 **APIMart 官方 gpt-image-2
  size×resolution 映射表（15 比例 × 1k/2k/4k）**。
- 对齐前宿主 electron/image-params.cjs 的 IMAGE_SIZE_TABLE 是 **re-vendor 前上游
  static/js/canvas.js 的旧通用 9 比例表**（git show HEAD:public/novai-canvas/static/js/canvas.js
  可逐字对照），**不是** APIMart 官方表。
- 两表共 **13 个差异格**；13 格全部采纳上游官方值。另补齐官方新增的 6 个比例
  （portrait12 / landscape21 / landscape54 / portrait45 / landscape31 / portrait13），
  宿主表从 9 比例 → **15 比例**。

## 判定依据

1. 官方文档：<https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation>。
   size 支持 15 个比例，resolution 独立给 1k/2k/4k，两者共同决定实际像素；同一比例同一档位
   官方偶尔列两组等价像素（例如 1:1@1k = 1024×1024 / 1254×1254），前端预置取“比例精确”的第一组。
2. 上游实现与测试三处同源：
   - static/js/smart-canvas.js 的 SIZE_MAP 注释（“APIMart gpt-image-2 generation，15 比例 × 1k/2k/4k”）；
   - tests/test_size_map_official.js 内联官方表，逐格断言两套画布的 apiImageSize；
   - main.py 的 APIMART_OFFICIAL_PIXELS（15 比例 × 档位，1k 保留全部等价像素）。
3. 宿主旧值不是“另一份官方表”，而是旧版上游画布页的通用表；因此差异格以官方表为准。

## 13 个差异格（逐格）

| 比例 | 档位 | 宿主旧值 | 上游官方值（采纳） | 谁对 | 判定依据 |
| --- | --- | --- | --- | --- | --- |
| square | 4k | 4096x4096 | 2880x2880 | 上游 | APIMart 官方 gpt-image-2 映射表 |
| portrait | 4k | 2352x3520 | 2336x3520 | 上游 | 同上 |
| portrait43 | 1k | 1008x1344 | 768x1024 | 上游 | 同上 |
| portrait43 | 4k | 2448x3264 | 2480x3312 | 上游 | 同上 |
| landscape43 | 1k | 1344x1008 | 1024x768 | 上游 | 同上 |
| landscape43 | 4k | 3264x2448 | 3312x2480 | 上游 | 同上 |
| landscape | 4k | 3520x2352 | 3520x2336 | 上游 | 同上 |
| story | 1k | 720x1280 | 864x1536 | 上游 | 同上 |
| wide | 1k | 1280x720 | 1536x864 | 上游 | 同上 |
| ultrawide | 1k | 1280x544 | 2016x864 | 上游 | 同上 |
| ultrawide | 2k | 2048x880 | 2688x1152 | 上游 | 同上 |
| ultratall | 1k | 544x1280 | 864x2016 | 上游 | 同上 |
| ultratall | 2k | 880x2048 | 1152x2688 | 上游 | 同上 |

新增的 6 个比例（全部按官方表补齐）：

| 比例 | 1k | 2k | 4k |
| --- | --- | --- | --- |
| portrait12（1:2） | 1024x2048 | 1344x2688 | 1920x3840 |
| landscape21（2:1） | 2048x1024 | 2688x1344 | 3840x1920 |
| landscape54（5:4） | 1280x1024 | 2560x2048 | 3216x2576 |
| portrait45（4:5） | 1024x1280 | 2048x2560 | 2576x3216 |
| landscape31（3:1） | 1536x512 | 3072x1024 | 3840x1280 |
| portrait13（1:3） | 512x1536 | 1024x3072 | 1280x3840 |

机器可读证据：artifacts/dxos-image-size-table-sync/size-table-diff.json（含每格
hostBefore / upstream / adopted / verdict / reason）与 size-table-diff.md。

## 对齐做法（只对齐数据与派生，不改宽高算法）

- IMAGE_SIZE_TABLE：改成官方 15 比例 **原样像素**（与 SIZE_MAP 逐格一致）。
- ASPECT_RATIO_ALIASES：补齐 1:2/2:1/5:4/4:5/3:1/1:3 及对应表键。
- GPT_IMAGE_SIZE_TABLE：从新的官方表重新派生 15 行（仍由 GPT_IMAGE_2_SIZE_POLICY 的 enum
  吸附得到，与页面 NovaSizePolicy.constrain 同结果）。
- fitSizeToTier：命名比例实际下发前按该档位像素上限等比收窄 + 16 对齐
  （与页面 apiImageSize 的 oaTierFit 同口径，不夹长边）。**算法本身未改**；它只是把页面
  已有的档位像素上限派生到宿主命名比例上。因此：
  - IMAGE_SIZE_TABLE 保留官方原值（如 ultrawide@1k = 2016x864）；
  - resolveImageSize 实际返回与页面一致的收窄值（如 1904x816）；
  - 6 个官方像素本身超过该档上限的格子（ultrawide@1k、ultratall@1k、portrait12@1k、
    landscape21@1k、landscape54@2k、portrait45@2k）两边都按同一口径收窄，不放宽。
- /api/ai/size-policy 的返回物新增 sizes / gptSizes 两个只读投影（页面 normalizeTable
  不读未知字段），让端点本身能被逐格核对；format/default/models 契约不变。

## 复现

    node experiments/dxos-image-size-table-sync/probe.mjs
    node --test tests/dxos-image-params.test.mjs tests/dxos-canvas-size-policy.test.mjs
    npx tsc --noEmit
    npm run build

探针做四件事：
1. 解析 smart-canvas.js 的 SIZE_MAP，与宿主 IMAGE_SIZE_TABLE 逐格对表，并算旧表 13 个差异格；
2. 用真实 openarc-bridge.js 调 GET /api/ai/size-policy（宿主 model.sizePolicy 返回物），
   核对 sizes / gptSizes；
3. 用端点真实回包加载页面 shared/size-policy.js + 从 smart-canvas.js 抽取的 apiImageSize，
   15×3 逐格比较页面出图尺寸与宿主 resolveImageSize（free + gpt-image-2），再跑 custom 用例；
4. 用真实 CanvasService.modelCall + 本地确定性 provider（按请求 size 出 PNG）跑 7 条生图链路，
   核对 provider 收到的请求 size、像素与宿主/页面一致。

最近一次结果：**149 pass / 0 fail**（artifacts/dxos-image-size-table-sync/probe-result.json）。

## 遗留 / 边界

- 上游 SIZE_MAP 的官方像素有 6 格超过 OpenArc 页面的档位像素上限。本包保持“官方原值留在表里、
  实际下发按现有档位上限收窄”的两层口径（页面补丁原本就这么做），没有为了贴官方原值去放宽
  档位上限；如果后续确认 APIMart 接受这些超上限官方像素，应同时改页面补丁与宿主派生，而不是只改表。
- 宿主 GPT_IMAGE_2_SIZE_POLICY 仍是旧 pin 的 enum 快照；上游本地工作树 22feb298 已把
  gpt-image-2 策略改成 bounds。本次任务只对齐比例表，未改策略模式（改它会影响页面吸附与既有测试）。
- 页面侧补丁、public/novai-canvas/** 未动；src/** / src-vue/** / dist/** / 其它 tests 未动。
