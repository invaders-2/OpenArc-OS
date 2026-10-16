# dxos-insecure-http · 显式明文 HTTP 放行（真机端到端）

对应产品改动：远程明文 HTTP 默认仍拒绝（`remote-requires-https`），放行只能来自
设置 › 模型与服务商「添加服务商」表单里**用户显式勾选**的「允许不安全 HTTP（明文直连）」；
勾选后 `validateEndpoint` 返回独立 scope `REMOTE_HTTP_EXPLICIT`，`model_providers.allow_insecure_http=1`
（v28 迁移加列），并写一条 `authorization_audit`（`model.insecureHttpAuthorized` / `INSECURE_HTTP_EXPLICIT`）
与授权人 + providerId。标记随单向镜像进 `providers.json`，技能 / 短剧 / 协议 / 图像出口按同一标记放行。

## 运行

```
node experiments/dxos-insecure-http/run-all.mjs
```

- token 只在运行时从 `/tmp/oa-relay.token` 读取（可用 `OA_II_TOKEN_FILE` 覆盖）；**绝不打印、绝不落盘**，
  报告里只出现 sha256 前 12 位。
- 隔离 userData（`mkdtemp`）+ 唯一 CDP 端口；默认结束后删除隔离目录，`OA_II_KEEP=1` 保留。
- token 不存在时打印 SKIP 并 exit 0，不伪造。

## 产物

- `artifacts/dxos-insecure-http/report.json` —— 全部断言 + 证据（无 token 明文）
- `artifacts/dxos-insecure-http/media/insecure-http-image.*` —— 真实出图原文件
- `artifacts/dxos-insecure-http/shots/` —— 2880x1800@2 截图：
  `01-form-insecure-opt-{light,dark}`（表单开关 + 警示）、
  `02-form-unchecked-blocked-{light,dark}`（未勾选结构化拦截）、
  `03-detail-insecure-badge-{light,dark}`（详情「不安全 HTTP」徽标）、
  `04-generated-image-render-dark`（真实产物渲染）

## 断言（12 项）

D1 未勾选仍 `ENDPOINT_BLOCKED`；A1 勾选后可建且 scope / 字段正确；A2 真实 `/v1/models`；
A3 注册图像模型；G1 `image/generate` 真实出图；U1 开关 + 诚实文案；U2 表单未勾选被拦；
U3 详情徽标 + tooltip；M1 标记进 `providers.json` 且 `api_key` 仍为空串；
X1 授权审计；X2 `model_providers` 持久化；I1 初始化 + 登录。
