# dxos-update-rollback-builtin · 真机端到端验收（回退到内置版本）

## 这个验收要证明什么

2026-10 的真实源端到端验收（`experiments/dxos-update-real-source/`）暴露了一个**真实产品缺口**：

- 从 ModelScope 真实装好 `canvas 0.01`（6,437,523 B，验签 + 逐文件 sha256 + 原子切换全通过，画布确实由已安装包服务）；
- 随后 `market/update/rollback` 回 `MARKET_UPDATE_ROLLBACK_UNAVAILABLE`（"没有可回滚的上一版"）——
  因为回滚只会切到 `history.json` 里"以前装过的版本目录"，而内置 `0.1.0` 没有安装目录。
- 结论：**装了一个有问题的包之后，用户无法退回内置版本**。

本实验验证修复后的产品行为：回退到内置版本必须真的发生、原子、可重复、可审计，并且画布真的改由内置 bundle 服务。

## 怎么跑

```bash
node experiments/dxos-update-rollback-builtin/run.mjs
```

- 真机：真实 `electron .`（隔离 `--user-data-dir`）+ 真实 CDP 驱动界面，不 stub 任何产品代码；
- 真联网：默认源 `modelscope-repo bllack/OpenArc-OS`，真实下载 `updates/canvas/canvas-0.01.zip`；
- 网络取证：`fetch-trace-preload.cjs` 通过 `NODE_OPTIONS=--require=` 注入主进程，只记录不改语义；
  原始 trace 含 ModelScope LFS 签名参数，只把脱敏副本写进 artifacts。

产物：`artifacts/dxos-update-rollback-builtin/{report.json,RESULT.md,fetch-trace.jsonl,shots/*}`。

## 验收步骤与断言（32 项）

| 组 | 断言 |
| --- | --- |
| P1 | harness 独立直连真实源 `updates/canvas/latest.json`：version 0.01 + sha256 6929461… |
| A0 | 真机启动 + 隔离 userData + 登录后 `gate=ready` |
| B1–B2 | 初始 status：current=null、builtin=0.1.0、**rollbackTarget=null**、canRollback=false；check 后 latest=0.01、updateAvailable=false（0.01 ≡ 0.1.0） |
| C1–C4 | 真实 install 0.01 成功；下载走 ModelScope 302 → cdn-lfs-cn-1 200，落盘 6,437,523 B、sha256 命中；安装目录独立复核（验签 + 69 个文件逐文件 sha256 + 无穿越 + entry 落盘） |
| C5 | 装完之后 **rollbackTarget={kind:"builtin",version:"0.1.0"}**、canRollback=false（没有上一版） |
| D1–D3 | 画布首页 + 智能画布可打开，且 `x-openarc-canvas-source=installed`、`x-openarc-canvas-version=0.01`；0 console error / 0 pageerror / 0 404 / 0 5xx |
| E1–E2 | 更新面板：回滚入口文案 **「回退到内置版本 0.1.0」且可点**（不是灰掉），设置行「可以回退到内置版本 0.1.0」 |
| F1–F3 | 面板里真实点按钮 → 二次确认（标题/正文/主按钮「确认回退到内置版本」）→ 确认 → 回退完成；status 如实：current=null、canRollback=false、rollbackTarget=null、latest 仍 0.01、updateAvailable=false |
| G1–G2 | `current.json` 变成内置标记 `{mode:"builtin",version:null,rolledBackFrom:"0.01"}`、无临时文件残留；**0.01 目录与 history 保留** |
| H1–H3 | 重载后画布首页 + 智能画布仍能打开，且 `x-openarc-canvas-source=dist`（不再是 installed）、`x-openarc-canvas-fallback=pointer-cleared`、无已安装版本号；0 console error / 0 pageerror / 0 404 / 0 5xx |
| I1–I3 | 再装一次 0.01 仍成功（可再切回，previous=null）；第二次回退仍成功（previous={version:"0.01"}）；第三次回退幂等（previous=null，不报错） |
| J1 | 最终面板：当前=0.1.0（内置）、入口「已在用内置版本」不可点、latest 仍显示 0.01、无错误码 |
| K1–K5 | 全场 0 console error / 0 pageerror / 0 404 / 0 5xx；所有真实出网主机都在白名单内 |

## 截图（浅/深）

- `shots/panel-rollback-builtin-light.png` / `-dark.png`：装完 0.01 后，入口是「回退到内置版本 0.1.0」且可点
- `shots/panel-confirm-builtin-light.png`：二次确认层（从 0.01 回退到 0.1.0、版本目录保留）
- `shots/panel-after-rollback-light.png` / `-dark.png`：回退完成后（当前 0.1.0、notice「已回退到内置版本。」）
- `shots/panel-final-builtin-light.png` / `-dark.png`：重载后再进面板的最终态（入口「已在用内置版本」）
- `shots/canvas-home-*` / `canvas-smart-*`：安装后与回退后的画布两页

## 注意

- 本实验只验证，不修改产品代码；产品改动见 `electron/market-update-service.cjs`、
  `electron/canvas-package-resolver.cjs`、`src-vue/apps/{appUpdateLogic.ts,CanvasUpdatePanel.vue}`、
  `src/types/openarc-ipc.d.ts`，对应单测见 `tests/dxos-market-rollback-builtin.test.mjs` 与
  `tests/dxos-canvas-*.test.mjs`。
- 真实网络下 ModelScope 的 LFS 下载有偶发慢/超时，重跑一次即可；报告里的 `ms` 是当次实测值。
