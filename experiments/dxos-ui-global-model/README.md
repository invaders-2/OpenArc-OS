# experiments/dxos-ui-global-model

「模型接上去之后是否**全局生效**」的端到端实测探针。全部实测都在真实产品入口 `dist/vue.html`（Vue 壳）里跑，
经真实 `window.openarc.*` 桥与真实主进程完成，没有 fake、没有 mock、没有跳过 UI。

## 产物

- `artifacts/dxos-ui-global-model/report.json` —— 全部原始返回（已 scrub 密钥）
- `artifacts/dxos-ui-global-model/REPORT.md` —— 人类可读报告（由 `render-report.mjs` 从 report.json 生成）
- `artifacts/dxos-ui-global-model/shots/*.png` —— 12 张 1440×900@2（2880×1800）截图，浅色 + 深色

## 复跑

```bash
node experiments/dxos-ui-global-model/run-all.mjs            # 全量（约 60s）
OA_GM_ENTRIES=1,2 node experiments/dxos-ui-global-model/run-all.mjs
OA_GM_CDP_PORT=9831 node experiments/dxos-ui-global-model/run-all.mjs
OA_GM_KEEP=1 node experiments/dxos-ui-global-model/run-all.mjs   # 保留隔离 userData 排障
node experiments/dxos-ui-global-model/render-report.mjs
```

## 探针做什么

1. 真实 `electron .` + 隔离 `--user-data-dir` + 唯一 `--remote-debugging-port`，加载产品默认入口 `dist/vue.html`；
2. `identity/initialize` + `identity/login`（租户第一个用户即 ADMIN），Emulation 钉到 1440×900 / dsf=2；
3. 配置一次真实 DeepSeek（`provider/create` → `credential/set` → `provider/models` → `model/create` → `defaults/set` → `defaults/get`）；
4. 逐个「真的会调模型」的入口实测（对话 / 全局 AI / 画布 / 技能 / 短剧，含真实 UI 交互与截图）；
5. 反向对照：`image/generate`、`video.generate`、`llm.chat.vision`（相册反推提示词）；
6. 收工核对真实 profile（只读 stat + sha256，前后全量比对）、杀子进程、删隔离 userData。

## 密钥纪律

- 密钥只在探针进程内从 `$HOME/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY` 读取；
- 只经 `page.evaluate` 参数传给 `credential/set` / `provider/create`，不写文件、不打印；
- 所有落盘字符串都过 `scrub()`：出现 `sk-` 或 `Bearer <...>` 一律替换为 `[REDACTED_KEY]` / `Bearer [REDACTED]`；
- 隔离 userData 里会有 safeStorage 加密的测试密钥副本，收工即整目录删除（`report.json.userDataRemoved` 记录）。

## 硬约束（本探针遵守）

- 只新建 `experiments/dxos-ui-global-model/**` 与 `artifacts/dxos-ui-global-model/**`，**不改任何产品代码**；
- 不新增 npm 依赖、不跑 `npm test` / `npm run build`、不 `git commit/push`；
- 除 DeepSeek API 与 `127.0.0.1` CDP 外不联网；
- 发现缺陷只记录（见 REPORT.md 第五节），不修。

## 平台限制

- 模型 HTTP 由 Electron 主进程发出，渲染层的 request 监听看不到 DeepSeek 请求，所以 `deepseekRequestCount` 恒为 0；
  「真的调到了 DeepSeek」由真实返回文本（`ok`）、`usage` token 计数、`provider/models` 拿到的真实模型清单与 `model/test` 的 `inference:true` 共同佐证。
