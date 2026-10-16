# dxos-model-proxy · 模型/协议出网代理真机验收

验证「模型与协议出口可选代理」（默认关闭、只作用于模型域、有审计）在**真实 Electron + 真实 Lovart + 真实本机代理**下成立。

## 运行

```bash
node experiments/dxos-model-proxy/run.mjs
# 可选：OA_MODEL_PROXY_URL=http://127.0.0.1:7897  OA_MODEL_PROXY_CDP_PORT=9894  OA_MODEL_PROXY_KEEP=1
```

密钥文件默认 `/tmp/oa-lovart.keys`（0600，两行 `AK=…` / `SK=…`）。**只在运行时读取，绝不打印、绝不入报告**；
报告里只有 `sha256(ak)[0:12]` / `sha256(sk)[0:12]` 指纹。

## 覆盖

| 步骤 | 断言 |
| --- | --- |
| A | 代理默认关闭；`provider/models` 直连 lgw.lovart.ai 失败（如实记录原始错误与耗时） |
| B | 模型代理指向关闭端口时，同一时刻 `market/update/check` 仍直连成功（只影响模型出口）；`provider/models` 失败并带原始出网码 `PROXY_UNREACHABLE` |
| C | `model/proxy/set` 打开真实代理（无需重启）→ 真站 catalog（IMAGE/VIDEO 工具计数）→ `model/create` → `model/test` |
| D | `image/generate` 真实出图：字节 / PNG 魔数 / 真实像素 / sha256 / 耗时，产物下载主机 = `a.lovart.ai` |
| E | 产物经 `canvas/importAsset` 入资源库，`resource/get|list` 读回 |
| F | 「模型与服务商」真机截图（浅/深）；UI 反映已启用与代理地址 |
| G | 关停后读隔离 identity.db：`system_preferences` 落库 + `authorization_audit` 有 `model.proxyEnabled` |

## 已知限制

- **不支持带认证的代理**：代理返回 407 时结构化 `PROXY_AUTH_REQUIRED`，不静默降级成直连。
- **http 目标只用于回环 / 本地测试**：经代理发 absolute-form；远程明文目标仍受模型域既有 SSRF 策略约束。
- 隧道内**不自动跟随重定向**（与既有调用方传入的 `redirect:"error"` 同向：不跟随、按非 2xx 返回）。
- 出口适配器会把网络失败归一成既有 provider 错误码；原始出网码通过命令结果里的 `proxyError` 字段带出。

## 产物

- `artifacts/dxos-model-proxy/report.json`
- `artifacts/dxos-model-proxy/shots/01-settings-model-egress-{light,dark}.png`
