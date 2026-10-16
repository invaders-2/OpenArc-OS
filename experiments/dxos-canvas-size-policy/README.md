# DXOS-CANVAS-SIZE-POLICY · 画布尺寸策略端点 + 页面 apiImageSize 算法修复

上游 1e20abe51 起画布页用 static/js/shared/size-policy.js 在启动时 GET /api/ai/size-policy
拉尺寸策略（:216 load / :224 constrain / :191 snapEnum）。OpenArc 的桥**没登记该端点 → 501**，
NovaSizePolicy 于是恒为默认 free 模式：gpt-image-2 走显式 size 时不会被吸附（4k 方图会送 4096×4096，
真策略下应吸附成 2048×2048）。

同一批还发现**页面自己的尺寸算法有真实缺陷**（上游 bug）：apiImageSize 的 custom/source 分支只把像素
上限压在一侧，长边恒等于该档 RES_LONG_SIDE，于是出现非方形与超上限结果（custom 1:1 @1k → 1536×1248）。

## 改动

| 文件 | 改动 |
| --- | --- |
| public/novai-canvas/openarc-bridge.js（A） | 登记 GET /api/ai/size-policy → 宿主 model.sizePolicy（只加登记项、不加通配；未登记端点仍 501、出网/只读闸/CSP/token 未动） |
| src/canvas/CanvasHost.tsx（A） | case "model.sizePolicy"：按需取 canvas/models，用与 /api/config **同一份** buildCanvasModelLabelIndex 生成模型显示名，交给 buildSizePolicyTable |
| electron/image-params.cjs（A） | 导出 buildSizePolicyTable / SIZE_POLICY_FORMAT / SIZE_POLICY_FREE：{format, default, models} 表，gpt-image-2 家族挂唯一真源 GPT_IMAGE_2_SIZE_POLICY，其余走 default（free + 同一份 tiers） |
| experiments/d5-02/vendor-novai-app.mjs（B · **第 9 处上游改动**） | CANVAS_JS_PATCHES 新增第 5 条：把 apiImageSize 换成按比例对称求解 + 档位像素上限（与宿主 sizeFromRatio 同口径）。换上游 commit 重跑 vendor 自动带上 |
| public/novai-canvas/openarc-shell.js（C） | **删除**：根外壳删除后全仓零加载；vendor 第 5 步清旧副本，prune-public.mjs 列「必须不存在」 |

策略表的形状（页面 normalizeTable 的输入）：

    {
      "format": "novai-size-policy/v1",
      "default": { "mode": "free", "tiers": [{"id":"1k","maxPixels":1572864},{"id":"2k","maxPixels":4194304},{"id":"4k","maxPixels":8294400}] },
      "models": { "gpt-image-2": { "mode": "enum", "options": ["auto","1024x1024","1536x1024","1024x1536","2048x2048","2048x1152","3840x2160","2160x3840"], "maxEdge": 3840, "minPixels": 655360, "multipleOf": 16, ... } }
    }

models 的键 = 画布页看到的模型显示名（与 /api/config 的 image_models 同一份索引），值就是
electron/image-params.cjs 的 GPT_IMAGE_2_SIZE_POLICY **同一个对象**（不另写一份）。

## 页面尺寸修复前后对照（真机实测值）

| 用例 | 修复前 | 修复后 |
| --- | --- | --- |
| custom 1:1 @1k | 1536x1248（非 1:1） | 1248x1248 |
| custom 4:3 @1k | 1536x1072（超 1k 上限） | 1440x1072 |
| custom 3:4 @1k | 1072x1536（超上限） | 1072x1440 |
| custom 1:1 @4k | 3840x2880（超上限） | 2880x2880 |
| custom 3:2 @4k | 3840x2336（超上限） | 3520x2336 |
| custom 2:3 @4k | 2336x3840（超上限） | 2336x3520 |
| 具名 square @4k | 4096x4096（超上限） | 2880x2880 |

具名比例其余 26 格逐格不变（SIZE_MAP 预设原样保留）。

## 单测

    node --test tests/dxos-canvas-size-policy.test.mjs

- A1/A2：桥登记、实例 token、未登记仍 501、出网仍拒；
- B1/B2：策略表形状、与 GPT_IMAGE_2_SIZE_POLICY 同一对象、页面加载后 gpt=enum 且 4096x4096 → 2048x2048，
  空表（501）时退回 free（缺陷现场对照）；
- C1/C2：**直接执行从 canvas.js 抽出的真实 apiImageSize**（配真实 shared/size-policy.js），
  9 个具名比例 × 3 档位 + 6 个 custom 用例：比例偏差 ≤ 0.025 且面积不超该档上限；并与宿主
  imageParams.sizeFromRatio 同口径交叉验证。

## 真机验证

    node experiments/dxos-canvas-size-policy/real-device-size-policy.mjs
    # artifacts/dxos-canvas-size-policy/RESULT.json（PASS 11 / FAIL 0）+ shots/*.png

真实 Electron（隔离 userData + 唯一 CDP 端口 9856）+ 本地桩 provider（只替代最后一跳网络，
按请求 size 出图以便独立核对产物像素）：
S1 策略端点 200 + 页面 gpt=enum；S2 UI 选 1:1 @1k → size/产物都 1024×1024；
S2b UI 选 custom 1:1 @1k → 1248×1248；S3 gpt-image-2 4k 方图 → 2048×2048（UI 标「4K · 等同 2K」）。
