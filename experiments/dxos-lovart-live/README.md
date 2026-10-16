# experiments/dxos-lovart-live

Lovart 真实联网验收探针（服务 / 适配器层，不含 UI）。它把 artifacts/lovart-live/ 的手工证据
（真站 chat/result 形状、a.lovart.ai 产物）固化成可复跑的探针，并直接驱动既有实现：

- provider/models → ModelService.listRemoteModels → 适配器 GET /v1/openapi/tools/catalog
- image/generate → ProviderProtocolService.generateImage → 适配器 send→watch→result，
  产物经白名单主机 a.lovart.ai 真实下载并落盘 userData/dxos/media

## 复跑

    NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node experiments/dxos-lovart-live/run.mjs

探针若发现 NODE_USE_ENV_PROXY / HTTPS_PROXY 未设置，会用同一命令自我重入一次，
所以直接 node experiments/dxos-lovart-live/run.mjs 也能跑（Node 只在启动时解析 env proxy）。

- 密钥：/tmp/oa-lovart.keys（AK=… / SK=…；用 OA_LOVART_KEYS 覆盖）。只运行时读取，
  绝不打印、绝不写入报告；报告只留 sha256[:12] 指纹。
- 免额度复验：OA_LOVART_SKIP_GENERATE=1 node ...（只跑 provider/models + model/test）。
- 可覆盖：OA_LOVART_PROMPT / OA_LOVART_MODE（默认 fast）/ OA_LOVART_PROXY /
  OA_LOVART_BASE_URL / OA_LOVART_TIMEOUT_MS。

## 产物

artifacts/dxos-lovart-live/

- report.json：全部检查项、真实请求轨迹、状态序列、生成证据
- REPORT.md：人读版
- lovart-live-generated.png：真实生成的 PNG（字节 / 魔数 / 像素 / sha256 见报告）
- catalog-live.json、mode-query-live.json、chat-result-live.json：真站原始响应

## 额度纪律

只发一次生成请求；失败如实上报原始错误，不重试、不伪造成功。

## 边界

应用内（UI 走 market/ui 链路）未验证：依赖尚未实现的「模型出网代理」功能；
本探针只覆盖服务与适配器层，落地后再补 UI 侧真机验证。
