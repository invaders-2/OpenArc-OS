# experiments/dxos-lovart-protocol

Lovart **官方 OpenAPI（OpenClaw / Agent Skill）**接入本仓的真机验收探针。

## 结论预览

- 协议：`electron/protocol-engine/legacy-protocols.cjs` 的 `PROVIDER_PROTOCOLS.lovart`
  （`auth: hmac_sha256` + `models.endpoint: /v1/openapi/tools/catalog` +
  `operations: image.generate / video.generate / llm.chat`）。
- 适配器（wire 层）：`electron/provider-adapter-lovart.cjs`；由
  `electron/provider-adapter.cjs` 的 `adapterFor(adapterType)` / `lovartFor(protocol)` 分发。
- 出口：`provider/models`（catalog）、`model/test`（凭据探测）、`provider/call`（agent 对话）、
  `image/generate` / `legacy/videos`（send → watch → result 并落盘 `<userData>/dxos/media`）。
- 凭据形态：**两把密钥合成一个 JSON 字符串**（`{"accessKey":"…","secretKey":"…"}`）经既有
  `credential/set` 存进 safeStorage；`providers.json` 的 `api_key` 仍为空串。

## 复跑

```bash
node experiments/dxos-lovart-protocol/run.mjs
OA_LOVART_CDP_PORT=9881 node experiments/dxos-lovart-protocol/run.mjs
OA_LOVART_KEEP=1 node experiments/dxos-lovart-protocol/run.mjs   # 保留隔离 userData 排障
```

## 探针做什么

1. 真实 `electron .` + 隔离 `--user-data-dir` + 唯一 `--remote-debugging-port`，加载产品默认入口 `dist/vue.html`；
2. `identity/initialize` + `identity/login`（首个用户即 ADMIN），Emulation 钉到 1440×900 / dsf=2；
3. 本地 mock（`lovart-mock.mjs`）扮演 `lgw.lovart.ai`：**真校验** AK/SK HMAC-SHA256 请求签名
   （缺头 / 访问键不符 / 方法·路径不符 / HMAC 不符 / 时间戳超窗 → 401），提供
   `GET /v1/openapi/tools/catalog`、`POST /v1/openapi/project/save`、`POST /v1/openapi/chat`、
   `GET /v1/openapi/chat/status`、`GET /v1/openapi/chat/result` 与产物 PNG；
4. `provider/create adapterType=lovart`（两把密钥合成一个 JSON secret）→
   `provider/models`（catalog + 能力映射）→ `model/create` → `model/test`（凭据探测）；
5. `image/generate` → send/watch/result → 产物落盘 `dxos/media`（真读 PNG 魔数）→
   `canvas/importAsset` 把产物写进资源库 → `resource/get` + `resource/list` 读回；
6. 系统设置 › 模型与服务商真机截图（浅色 + 深色）；
7. 收工：真实 profile 只读快照前后比对、杀子进程、删隔离 userData。

## 网络与密钥纪律

- **不做真实联网**：`lgw.lovart.ai` DNS 解析到 `104.244.46.185`，TCP 443 超时；`www.lovart.ai` 同样不可达。
  同一时刻 `api.deepseek.com` 返回 401、`api-inference.modelscope.cn` 返回 200，说明是本机网络对 Lovart 域名不可达。
  真实协议事实取自官方仓库 `lovartai/lovart-skill`（MIT）的 `skills/lovart-skill/scripts/agent_skill.py`
  与 `scripts/sync_models.py`（逐行证据见 `artifacts/dxos-lovart-protocol/REPORT.md`）；
- 探针的 AK/SK 是 mock 专用串，`report.json` 里出现 `ak-`/`sk-` 一律 scrub；隔离 userData 收工即删（除非 `OA_LOVART_KEEP=1`）。

## 产物

- `artifacts/dxos-lovart-protocol/report.json`（原始返回，已 scrub）
- `artifacts/dxos-lovart-protocol/REPORT.md`（人类可读报告）
- `artifacts/dxos-lovart-protocol/shots/*.png`
