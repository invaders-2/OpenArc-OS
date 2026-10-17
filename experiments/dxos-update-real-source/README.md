# dxos-update-real-source · 真实更新源端到端验收

真实 Electron + **真实网络**（ModelScope `bllack/OpenArc-OS`）+ 隔离 userData，验证无限画布的
在线更新链路：检查 → 下载 → 验签 → 逐文件 sha256 → 解压围栏 → 原子切换 → 画布真正加载新包 →
回滚 → 再检查 → 应用商店更新面板截图。

不改任何产品代码；只新增本目录与 `artifacts/dxos-update-real-source/`。

## 运行

```bash
node experiments/dxos-update-real-source/run.mjs
```

前置：仓库已 `npm run build` 出 `dist/`（本 harness 用 `electron .` 加载 `dist/vue.html`），
`resources/app-update-keys.json` 存在。运行时会自建隔离 profile，结束后删除；真实 profile 只做只读快照。

## 输出（artifacts/dxos-update-real-source/）

| 文件 | 内容 |
| --- | --- |
| `report.json` | 全部检查项、原始桥回包、逐请求网络 trace、安装包落地复核、截图元数据 |
| `RESULT.md` | 同一批检查项的可读表格 |
| `fetch-trace.jsonl` | Electron **主进程**真实出网逐请求记录（URL 已脱敏，去掉 LFS 签名参数） |
| `shots/market-canvas-update-{light,dark}.png` | 应用商店 › 无限画布 › 更新面板（浅/深） |
| `shots/canvas-{home,smart}-after-{install,rollback}.png` | 隔离 profile 下画布首页与智能画布 |

## 取证方式

- 隔离：`electron . --user-data-dir=<tmp> --remote-debugging-port=<free>`；主进程 `app.getPath("userData")` 随之隔离。
- 网络：不给任何 mock。唯一注入的是 `NODE_OPTIONS=--require=<fetch-trace-preload.cjs>`，
  它只在 Electron 主进程给 `globalThis.fetch` 与每个响应实例的 `arrayBuffer()` 套一层**只读**记录器
  （不改请求、不改响应、失败也不影响被测行为），因此能拿到：
  - 每个 URL / 主机 / 状态 / 重定向落点 / 耗时；
  - 被完整读出的响应体字节数与 sha256（最新清单 163 B、资产 6,437,523 B）；
  - 小体积 JSON 的原文（latest.json 里 `version` / `sha256` 的直接证据）。
- 落盘复核：安装目录逐文件重算 sha256、用仓库公钥独立验 `manifest.sig`、检查 `current.json` /
  `history.json` / `.staging-*` 残留。
- 画布是否真的用上已安装包：在 `openarc-canvas://` 帧里 fetch 入口，读响应头
  `x-openarc-canvas-source` / `x-openarc-canvas-version`（内置 bundle 与发布包恰好字节相同，只看页面内容无法区分）。

## 2026-10-17 真机结果（Electron 44.3.0）

**34 项通过 / 2 项未通过。**

通过的关键事实：

- check：主进程真的从 `updates/canvas/latest.json` 拿到 `version:"0.01"`、
  `sha256:"692946187d2c…"`；桥调用 657 ms，3 次请求 316/262/71 ms，主机只有 `modelscope.cn`。
- `updateAvailable=false`（`0.01 ≡ 0.1.0`，`compareSemver=0`），`current=null`、`canRollback=false`、`loadable=true`。
- install：桥调用 1,200 ms；3 次发现请求后，资产 `modelscope.cn 302 → cdn-lfs-cn-1.modelscope.cn 200`，
  实际下载 6,437,523 B、sha256 `692946187d2cff2cf68f5c45740ffcdc473ce304665064f30d981fc082ab7d12`
  （与 Release / ModelScope 发布值一致）。
- 落地：`<userData>/dxos/apps/canvas/current.json` = `{version:"0.01", kind:"static-web", entry:"static/canvas-list.html", digest:"a4c46f…"}`；
  69 个文件、12,684,800 B，逐文件 sha256 全命中；仓库公钥验签 OK；无 `.staging-*` 残留；`history.json=["0.01"]`。
- 画布：首页与智能画布都能打开，`openarc-canvas://` 响应头 `source=installed, version=0.01`；
  0 console error / 0 pageerror / 0 404 / 0 5xx（安装后与回滚尝试后各验一次）。
- 更新面板：`state=latest`、badge `已是最新`、`已是最新版本 0.01`、当前 0.01、内置 0.1.0、最新 0.01、
  来源 ModelScope `bllack/OpenArc-OS`、回滚 `暂不可回滚`、无安装按钮。

**未通过的两项是同一件产品行为（不是网络/白名单问题）：**

1. `market/update/rollback` → `{ ok:false, error:"MARKET_UPDATE_ROLLBACK_UNAVAILABLE", detail:"没有可回滚的上一版" }`（4 ms）。
2. 因此 `current.json` 仍是 `0.01`，没有回到内置 `0.1.0`。

原因：回滚只会切到**以前安装过**的版本（`history.json` + 该版本目录），内置 `0.1.0` 没有安装目录，
本轮隔离 profile 只装过 `0.01`，所以没有可回滚对象。产品自己的文案也写着「装过两个及以上版本才能回滚」，
文档语义是「回到上一版」，不是「回到内置版本」。当前真实源（ModelScope 与 GitHub Releases）都只有 `0.01`
一个版本，所以这条路径在真实源上无法走通。

建议（未在本任务中实现）：要么给「无上一版」时提供「回到内置版本」（清掉 / 失效 current.json，
解析器会结构化回退到 `dist/novai-canvas`）；要么先发布第二个版本（如 `0.02`）并安装两版后再验回滚。

## 边界

- 只验证 canvas（唯一接入了已安装包加载路径的应用）。
- 原始 trace 含 ModelScope LFS 签名参数，只留在临时目录；artifacts 里是脱敏副本（`auth_key` 等已移除）。
- 画布内置 bundle 与发布包内容恰好逐字节相同，所以「到底服务的是哪个」只靠响应头断言，不靠像素/文本。
- 结束后删除隔离 userData；`report.json` 里保留了当时的绝对路径与文件摘要作为证据。
