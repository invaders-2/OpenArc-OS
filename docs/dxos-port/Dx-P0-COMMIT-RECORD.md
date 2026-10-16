# Dx-P0 · 提交记录（R1 未提交改动收口）

> 依据本节任务「先把这批未提交改动处理干净（提交或明确 stash 并记录）」。
> 分支 `dxos-port/r1`，工作区 `/Users/wepingli/.openarc-worktrees/dxos-port-r1`。**未 push**。

## 1. 处理方式：提交（不 stash）

2026-10-13 将 R1 遗留的 35 项未提交改动按阶段拆成 4 个提交，工作树此后为 clean。
此前 `Dx-ROUND-RESULT.md` §5 记录的「未 commit / 未 push（提交前需你确认）」状态终结。

| 提交 | 内容 |
|---|---|
| `56026f8` docs(dxos-port): P0 契约冻结与 P1/P2/APP 结果文档入档 | `docs/dxos-port/` 11 份文档 |
| `2713908` feat(dxos-p1): B1 地基 | `electron/identity-store.cjs`（SCHEMA_VERSION 21→22）、`electron/dxos-foundation-*.cjs` ×7、`src/types/openarc-ipc.d.ts`、`tests/dxos-foundation.test.mjs`、12 个既有迁移测试断言更新 |
| `ae6eafd` feat(dxos-p2): B2 模型与协议 | `electron/provider-protocol-*.cjs` ×3、`electron/protocol-engine/` ×15、`electron/model-manifest-*.cjs` ×2、`electron/model-bootstrap.cjs`、`src/settings/ModelSettings.tsx`、`tests/dxos-protocol.test.mjs`、`experiments/dxos-p2/` |
| `f5a5f29` build(app): 打包/实时预览脚本支持 --app | `scripts/dev-app.mjs`、`scripts/sync-app.mjs` |

基线 commit 仍为 `128e21d`（`integration/ui-core`）；`main` 未改动。

## 2. 提交前复验（真实命令与真实输出）

```
$ npm run build
✓ 1638 modules transformed.  ✓ built in 1.60s          BUILD_EXIT=0

$ npm test
1..1441
# tests 1447 / # pass 1446 / # fail 1 / # skipped 0 / duration_ms 145919

$ node --test tests/d5-03-dsh-runtime-pin.test.mjs
not ok 5 - D5-03-E · ACP SDK 只认项目内那一份，版本 1.4.0（与锁文件一致）
# tests 7 / # pass 6 / # fail 1
```

唯一失败与 `Dx-P0-BASELINE.md` §3 登记的基线环境性失败 **#337 同一项**（worktree 的 `node_modules` 为指向主仓库的符号链接）：
**改动前后一致，无新增失败**。

## 3. 本轮起点

- 已完成：P0（契约冻结）、P1 = B1 地基（主体）、P2 = B2 模型与协议（主体）。
- B2 遗留：v2 模型协议仅移植 `openai-images` 1 个（余 17 个 `ported:false`）、legacy 执行器未搬、`protocolInference` 未逐条搬、真实调用凭据缺失（NOT VERIFIED）。
- 本轮（R2）起点 = **B3 任务 / Agent / 工具**；B1、B2 已完成部分不重做。
- 已声明但未实现的新 IPC 域：`skill` `media` `comfy`（2026-10-14 随 B7i 从移植范围移除，原因与恢复前提见 `Dx-B7-RESULT.md` §8） `automation` `integration` `developer` `market` `cloud` `update` `diagnostics`；
  待补充声明：`agent`（Agent 内核/运行时/工具）、`project`（项目快照/记忆）、`platform`（安全/代理，可并入 `diagnostics`）。
