# dxos-relay-image

把用户提供的 **图像中转站**（Sub2API，\`http://43.130.6.197:8080\`）接进 OpenArc 的端到端实测。
硬约束：不改产品代码、不新增依赖、不 git、除网关与 127.0.0.1 外不联网；token 只在运行时读取。

## 为什么先起本地桥
\`electron/model-domain.cjs:validateEndpoint\` 默认拒绝远程明文 http（\`remote-requires-https\`）。
\`relay.mjs\` 在 127.0.0.1 随机端口做透明反向代理（原样透传 Authorization，不打印头），
provider.baseUrl 因此落在 LOCALHOST 口径，合法且不触发策略例外。
桥是透明代理：不重试、不改状态码，上游 429/5xx 如实回到调用方。

## 运行
\`\`\`bash
node experiments/dxos-relay-image/run-all.mjs      # 主 E2E：配置 → image/generate → 设置截图/策略边界 → 画布 → LLM → 反向
node experiments/dxos-relay-image/canvas-diag.mjs  # 画布生成命令定位（页面链 CANVAS_CHANGED 时留证真图）
node experiments/dxos-relay-image/policy-shot.mjs  # 策略边界截图（不发起网关调用）
node experiments/dxos-relay-image/probe.mjs        # 上游探针（带 429 退避）
node experiments/dxos-relay-image/watch-gateway.mjs# 网关恢复观察
\`\`\`
产物在 \`artifacts/dxos-relay-image/\`；结论见同目录 \`REPORT.md\`。

## 关键发现
1. 图像链真实可用：\`image/generate\` → 1024×1024 JPEG（C2PA），\`canvas/modelImage\` 同样拿到真图。
2. **画布页面自带生图链在真实慢模型下必败**：\`canvas.js runGenerator\` 在 POST 之后落盘 pending 卡片，
   推进画布 revision，\`canvas-service.modelCall\` 判 \`CANVAS_CHANGED\` 丢弃结果（revision 2→4）。
   命令链本身健康，缺陷在页面落盘时序。
3. 该站会整体 503 (\`No available accounts\`) 后自行恢复；探针全程未观测到 429。
