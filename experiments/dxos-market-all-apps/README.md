# dxos-market-all-apps · 应用商店升级（全应用）真机探针

被测对象：默认 Vue 壳（`dist/vue.html`）→ 应用市场 →
`src-vue/apps/MarketApp.vue`（每个应用的版本条目）+ `src-vue/apps/CanvasUpdatePanel.vue` /
`src-vue/apps/appUpdateLogic.ts`（按 appId 驱动的通用更新面板）。

## 跑法

```bash
npm run build                                   # 探针跑的是 dist/vue.html，必须先构建
node experiments/dxos-market-all-apps/run-all.mjs
OA_MARKET_ALL_APPS_RUNS=light node experiments/dxos-market-all-apps/run-all.mjs   # 只跑一个场景
```

产物：`artifacts/dxos-market-all-apps/{report.json,checks.json,SELECTORS.md,screens/*.png}`。
exit 0 = 全部断言通过。三组：light（参考视口）、dark（参考视口）、narrow（820 窄窗）。

## 为什么不是「stub 渲染层桥」

`contextBridge.exposeInMainWorld("openarc", …)` 暴露的属性不可写、不可配置，页内 stub 换不掉
`window.openarc.marketUpdate.command`。本探针用**真桥 + 真服务 + 只换网络传输**：

```
真实 Vue 面板 → contextBridge → market:command
  → electron/market-update-service.cjs（真实验签 / 摘要 / 解压围栏 / 原子切换 / 审计）
  → globalThis.fetch ← 被 fixture-source.cjs 顶替（NODE_OPTIONS=--require <无空格临时 shim> 预加载）
      https://modelscope.cn/...  → 内存里的 fixture 源
         canvas: updates/canvas/latest.json + canvas-0.2.0.zip（真签名，install 会成功）
         notes : updates/notes/latest.json  + notes-0.2.0.zip（真包，但渲染层没有加载路径）
         photos: 什么都不发（无发布包）
      https://api.github.com/... → 空 Release 列表
      其它主机                    → 原样透传（探针断言 passthrough = 0，即全程不联网）
```

因此「有新版本 / 安装成功 / 暂不支持加载 / 无可用更新」都是真实执行结果。

## 覆盖

| # | 断言 | 真实来源 |
| --- | --- | --- |
| ① | 商店列出全部 23 个应用，每个都有版本、版本来自注册表 | `src-vue/apps.ts` 的 APPS |
| ② | 画布显示「有新版本 0.2.0」→ 二次确认 → 真实 install 成功（隔离 userData 里 current.json=0.2.0） | 真实 `market/update/install` |
| ③ | notes 有发布包但渲染层不支持加载：如实标注、不出现安装按钮 | `loadable=false` → `MARKET_UPDATE_NOT_LOADABLE` |
| ④ | photos 没有发布包：latest 为空、state=latest，不是错误 | 源里没有该应用的清单 |
| ⑤ | 回到列表后卡片状态刷新：canvas「已是最新」/ notes「有新版本 + 暂不支持」/ photos「无可用更新」 | 关面板重读本机状态 |
| ⑥ | 0 console error / 0 pageerror / 0 非本地请求 | CDP 事件 |

## data-* 选择器

完整清单见 `artifacts/dxos-market-all-apps/SELECTORS.md`（每次运行重写）。
通用契约 `data-app-*` 的单一权威在 `src-vue/apps/appUpdateLogic.ts` 的 `APP_UPDATE_SELECTORS`；
画布历史契约 `data-canvas-update-*` 继续保留（`CANVAS_UPDATE_SELECTORS` 未变）。

## 不在本探针范围

- 真实公网更新源（ModelScope / GitHub）的可用性与 CDN 行为 —— 后端单测覆盖。
- 安装后画布本体的加载 —— 由 `tests/dxos-canvas-online-update.test.mjs` / `d5-02` 的协议用例覆盖。
