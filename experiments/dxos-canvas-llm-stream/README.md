# 智能画布流式 LLM（D5-02 上游升级回归修复）

上游 `1e20abe514` 起，`static/js/smart-canvas.js` 的 LLM 节点改走 **`POST /api/canvas-llm/stream`（SSE）**；
旧版 `6ce1a646` 走非流式 `/api/canvas-llm`。桥的端点白名单当时只登记了非流式那条，页面因此拿到 **501**。

## 改动（只加登记项，不放宽白名单）

| 文件 | 改动 |
| --- | --- |
| `public/novai-canvas/openarc-bridge.js` | 登记 `POST /api/canvas-llm/stream → model.chatStream`（`stream:true`）；新增 `streamCall`：把宿主 `stream-open/stream-chunk/stream-end/stream-error` 消息拼成 `Response(body=ReadableStream)`；页面 abort → 带实例 token 的 `abort` 消息 |
| `src/canvas/CanvasHost.tsx` | `handleStreamCall`：走 `canvas/run` + `canvas/modelChatStream`，把 `model:event`（payload.type=`canvas.stream`）增量转成 SSE 帧回 iframe；页面 abort / 整帧重置 / 卸载 / beforeunload → `canvas/runStop` |
| `electron/canvas-bootstrap.cjs` | 登记命令 `canvas/modelChatStream` |
| `electron/canvas-service.cjs` | `modelChatStream`：与 `modelCall` 同一套前置（权限/run/预算/Task 记账）→ `ModelService.chatStream`；增量经既有 `model:event` 下行；取消复用 `abortOf`（`canvas/runStop` 中止在途 HTTP） |
| `src/canvas/canvasLlmStream.ts` | 纯逻辑：事件→SSE 帧、开流时机、无正文时的如实收口（409 降级 / 502 / 504） |

## 端点登记清单

**新增登记 1 条**

- `POST /api/canvas-llm/stream` → `model.chatStream`（流式，真实 SSE 分块）

**保持 501（结构化 `OPENARC_UNSUPPORTED`）—— OpenArc 没有语义对等的既有能力**

- `/api/agent/*`（plan/apply/preview/rollback/sessions/run/undo/review/memory/thread/apply-prompt）—— 页面自带画布 Agent
- `/api/image/upscale*`、`/api/image/matting*`、`/api/image/select-region`、`/api/matting/model/*` —— 放大概/抠图本地运行时
- `/api/video/frame|concat|blur-faces|segments`、`/api/angle/generate`、`/api/jimeng/query-media`、`/api/ms/generate`、`/api/runninghub/*` —— 视频/第三方站点
- `/api/personas`、`/api/smart-canvas/prompt-templates`、`/api/prompt-libraries*` —— 提示词库/人设数据面

未登记端点仍由桥的 `unsupported()` 返回 501 + 一次性"未接入"提示；出网仍 `OPENARC_EGRESS_BLOCKED`；
CSP / 只读闸 / 实例 token 一律未动；流式数据只在 iframe ⇄ 宿主之间走既有 `postMessage`。

## 真机验证

```
node experiments/dxos-canvas-llm-stream/real-device-smart-canvas-stream.mjs
# artifacts/dxos-canvas-llm-stream/RESULT.json（PASS 16 / FAIL 0）+ shots/*.png
```

单测：

```
node --test tests/dxos-canvas-llm-stream.test.mjs tests/dxos-canvas-llm-bridge-stream.test.mjs
```
