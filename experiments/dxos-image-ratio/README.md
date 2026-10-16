# dxos-image-ratio · 图像分辨率/比例参数链实测

结论先行（2026-10-16，网关 `http://43.130.6.197:8080`，token sha256_12 = `3add1f09763f`）：

1. **size 原样透传，是否被改写取决于上游模型。** 实机 3 尺寸：请求 1024x1024 → 实得 1024x1024；请求 1536x1024 → 实得 1264x848；请求 1024x1536 → 实得 848x1264。
   **比例被保留**（3:2 / 2:3），但像素被上游重排到约 1.07MP；只有正方形正好命中。
2. **比例/分辨率在画布页本来就映射成 size 发送**（`public/novai-canvas/static/js/canvas.js` 的 `apiImageSize` / `generatorSizeForRun`），
   但 **electron 侧（canvas-service/modelCall、canvas/modelImage IPC）没有映射**：只有显式 size 会进请求。
   现已补上宿主侧映射（`electron/image-params.cjs` + `canvas-service.#imageSizeForRun`），显式 size 仍优先。
3. **mime 硬编码已修**：b64 分支按 `mime_type/mimeType` → 魔数 → 回退；实机返回的就是 JPEG（magic ffd8ffe0），修复前 dataURL 会被标成 image/png。
4. **params 白名单**：`sanitizeParams` 会把 `quality/aspect_ratio/resolution/mime_type` 等图像键丢掉（`response_format/seed` 因在 chat 白名单里幸存）。
   图像专属白名单已备好（`image-params.IMAGE_PARAM_ALLOWLIST / pickImageParams`），但接线要改 `model-domain.cjs / model-service.cjs`（本次被其他执行者占用，未动）。
5. **`response_format:"url"` 不会导致空结果**：v2 `openai-images` 模板同时声明 `resultUrls` 与 `resultData`（`$.data[*].b64_json / image_base64`），
   D5-02 的 `mapImages` 两种形态都收。上游忽略该字段回 b64 时仍能取到图。

## 文件

| 文件 | 作用 |
| --- | --- |
| `measure.mjs` | 零依赖解析：PNG/JPEG/WEBP/GIF/BMP 真实宽高 + 魔数 |
| `live-probe.mjs` | **真机**：对网关逐尺寸 POST，落盘原始字节并测量（token 只运行时读、绝不打印） |
| `live-retry.mjs` | 后台恢复重试（该网关图像路由会在 404/200 之间抖动） |
| `discover-models.mjs` | 哪些图像模型真的支持 `/v1/images/generations` |
| `gateway-health.mjs` | 网关可达性与图像账号状态 |
| `chain-probe.mjs` | **协议级**：真实 `provider-adapter` + 本地 OpenAI 兼容 stub（返回真实编码图片），
含画布页 `apiImageSize` 与本模块逐项对照 |

## 真机像素表（`live-probe.mjs`，模型 gemini-3.1-flash-image）

| 请求 size | HTTP | 耗时 | 返回字段 | 字节数 | 魔数 | 实际像素 | 匹配 | 比例 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1024x1024 | 200 | 64846 ms | b64_json | 684317 | ffd8ffe000104a46 | **1024x1024** JPEG | ✅ | 1:1 |
| 1536x1024 | 200 | 77806 ms | b64_json | 660225 | ffd8ffe000104a46 | **1264x848** JPEG | ❌ | 1.4906 (≈3:2) |
| 1024x1536 | 200 | 80409 ms | b64_json | 672658 | ffd8ffe000104a46 | **848x1264** JPEG | ❌ | 0.6709 (≈2:3) |

判定：**size 原样发出、上游按比例重排像素**（不是我们改写了 size）。要"请求什么就得到什么"必须选支持精确尺寸的模型
（如 OpenAI `gpt-image-*` 的离散枚举），Gemini 图像走的是"比例 + 1K 档"。

## 复跑

```bash
# 真机（需要 /tmp/oa-relay.token）
node experiments/dxos-image-ratio/live-probe.mjs

# 协议级链路（无网络、无凭据、本地 stub）
node experiments/dxos-image-ratio/chain-probe.mjs

# 单测
node --test tests/dxos-image-params.test.mjs
```

产物：`artifacts/dxos-image-ratio/{live-probe,chain-probe}.json` 与原始图片字节 `*.bin`。
