# experiments/dxos-anthropic-protocol

Anthropic **官方 Messages API**（不是 OpenAI 兼容绕路）接入本仓的真机验收探针。

## 结论预览

- 协议：\`electron/protocol-engine/legacy-protocols.cjs\` 的 \`PROTOCOLS.anthropic\`
  （\`auth: x-api-key\` + \`headers.anthropic-version: 2023-06-01\` + \`models.endpoint: /v1/models\`
  + \`operations: llm.chat / llm.chat.stream / llm.chat.vision\` + \`categories: llm, vision, tools\`）。
- 适配器：\`electron/provider-adapter-anthropic.cjs\`；\`electron/provider-adapter.cjs\` 的
  \`adapterFor(adapterType)\` / \`chatProtocolFor(protocol)\` 负责分发，未登记类型一律回落既有 OpenAI 兼容实现。
- 出口：\`model:command\` 的 \`provider/call\`、\`provider/callStream\`、\`provider/models\`、\`model/test\`
  对 \`adapterType=anthropic\` 的服务商全走官方线路（由 \`electron/provider-protocol-service.cjs\` 的
  \`adapter.chatProtocolFor(provider.protocol)\` 完成协议分派）。

## 复跑

\`\`\`bash
node experiments/dxos-anthropic-protocol/run.mjs
OA_ANTHROPIC_CDP_PORT=9877 node experiments/dxos-anthropic-protocol/run.mjs
OA_ANTHROPIC_KEEP=1 node experiments/dxos-anthropic-protocol/run.mjs     # 保留隔离 userData 排障
OA_ANTHROPIC_ENTRIES=1,2 node experiments/dxos-anthropic-protocol/run.mjs
\`\`\`

## 探针做什么

1. 真实 \`electron .\` + 隔离 \`--user-data-dir\` + 唯一 \`--remote-debugging-port\`，加载产品默认入口 \`dist/vue.html\`；
2. \`identity/initialize\` + \`identity/login\`（首个用户即 ADMIN），Emulation 钉到 1440×900 / dsf=2；
3. 本地 mock（\`anthropic-mock.mjs\`）扮演 \`api.anthropic.com\`：校验 \`x-api-key\` + \`anthropic-version\`，
   提供 \`POST /v1/messages\`（非流式 + 具名 SSE 流式）与 \`GET /v1/models\`；
4. \`provider/create adapterType=anthropic\` → \`provider/models\` → \`model/create\` → \`defaults/set\`；
5. \`model/test\`（设置页「测试连接」的真实通道）→ \`provider/call\`（非流式对话出口）→
   \`provider/callStream\`（增量经 \`model:event\` 分块到达）；
6. 真实 UI：系统设置 › 模型与服务商、对话 App（\`task/run\` → 全局 AI 通道）各截图（浅色 + 深色）；
7. 收工：真实 profile 只读快照前后比对、杀子进程、删隔离 userData。

## 网络与密钥纪律

- **不做真实联网**：\`api.anthropic.com\` 对本机匿名探测返回 \`403 {"type":"forbidden","message":"Request not allowed"}\`
  （WAF/地域拦截，不是 401），因此真实调用需要用户自己的 key；本探针由本地 mock 只替代最后一跳网络；
- 官方文档站（platform.claude.com / docs.claude.com）对本机同样地区拦截，模型 id 与协议形状取自
  本仓 \`node_modules/@anthropic-ai/sdk\`（官方 SDK 0.123.0，见 \`artifacts/dxos-anthropic-protocol/REPORT.md\`）；
- 探针密钥是 mock 专用串，report.json 里出现 \`sk-\` 一律 scrub；隔离 userData 收工即删。

## 产物

- \`artifacts/dxos-anthropic-protocol/report.json\`（原始返回，已 scrub）
- \`artifacts/dxos-anthropic-protocol/REPORT.md\`（人类可读报告）
- \`artifacts/dxos-anthropic-protocol/shots/*.png\`
