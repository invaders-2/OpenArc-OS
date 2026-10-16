# dxos-canvas-update-ui · 无限画布「在线更新」界面真机探针

被测对象：默认 Vue 壳（`dist/vue.html`）→ 应用市场 → 画布卡片「在线更新」→
`src-vue/apps/CanvasUpdatePanel.vue` + `src-vue/apps/canvasUpdateLogic.ts`。

## 跑法

```bash
node experiments/dxos-canvas-update-ui/run-all.mjs
OA_CANVAS_UPDATE_RUNS=light node experiments/dxos-canvas-update-ui/run-all.mjs   # 只跑一个场景组（排查用）
```

产物：`artifacts/dxos-canvas-update-ui/{report.json,checks.json,SELECTORS.md,screens/*.png}`。
exit 0 = 全部断言通过。共三组：light（参考视口）、dark（参考视口）、narrow（820 窄窗 + 减少动态）。

## 为什么不是「stub 渲染层桥」

`contextBridge.exposeInMainWorld("openarc", …)` 暴露出来的属性是 **不可写、不可配置** 的
（`diagnose-bridge.mjs` 有实测：`writable:false configurable:false`，赋值静默失败、
`Object.defineProperty(window,"openarc")` 抛 "Cannot redefine property"）。
所以页内 stub 根本换不掉 `window.openarc.marketUpdate.command`。

本探针改用**真桥 + 真服务 + 只换网络传输**：

```
真实 Vue 面板 → contextBridge（39 键，未顶替）→ market:command
  → electron/market-update-service.cjs（真实验签 / 摘要 / 解压围栏 / 原子切换 / 审计）
  → globalThis.fetch ← 被 fixture-source.cjs 顶替（NODE_OPTIONS=--require <无空格临时 shim> 预加载）
      https://modelscope.cn/...  → 内存里的 fixture 更新源（无 Release / 0.1.0 / 0.2.0 / 0.3.0 / 坏签名）
      https://api.github.com/... → 空 Release 列表
      其它主机                    → 原样透传（探针断言 passthrough = 0，即全程不联网）
```

因此「有更新 / 安装成功 / 可回滚 / 回滚完成 / 坏签名失败」都是**真实执行结果**：
- 合法包用仓库真实私钥 `.keys/update-signing.key` 签（与 `resources/app-update-keys.json` 的公钥配对）；
- 坏签名包在探针里现生成另一把 Ed25519 私钥签同一个 manifest → 主进程验签必然失败
  （`MARKET_UPDATE_SIGNATURE_INVALID`）；
- 安装成功会真的把 `current.json` / 安装目录写进**隔离 userData**（探针另外断言这两个文件）。

## 口径

- 真实 electron 进程 + `--user-data-dir=<临时目录>`（隔离，绝不动真实 profile）+ 唯一 CDP 端口。
- 参考视口 1440x900 @ dsf2 → 截图像素 2880x1800；窄窗 820x720 @ dsf2。
- 深浅主题走真实 UI「顶栏控制中心 → 外观」；减少动态走「控制中心 → 减少动态」。
- 不新增依赖（zip 用既有 `electron/canvas-dxos-zip.cjs`）、不改产品代码、不 commit。

## 状态覆盖

| # | 状态 | 真实来源 | 断言要点 |
| --- | --- | --- | --- |
| 01 | 源里没有发布版本 | fixture `Files: []` → `latest:null` | 是正常状态不是失败；文案「还没有发布版本」 |
| 02 | 已是最新 | 清单 0.1.0 = 内置版本 | 标题「已是最新版本 0.1.0」 |
| 03 | 有更新 | 清单 0.2.0 | 版本 / 发布时间 / 说明链接 / 来源仓库 bllack-OpenArc-OS |
| 04 | 二次确认弹层 | — | 文案含来源、目标版本、不静默安装；Esc 取消后没有安装 |
| 05 | 安装进行中 | fixture 延迟 zip 响应 | busy=install、有进行中文字状态、无伪造百分比 |
| 06 | 安装成功 | 真实验签通过并落盘 | current=0.2.0 + 成功文案 + 隔离 userData 里真实 current.json |
| 07 | 可回滚 | 再真装 0.3.0 | current=0.3.0、canRollback=true、回滚按钮可用 |
| 08 | 回滚确认 + 回滚 | 真实 rollback | 独立确认层；回滚后 current 回到 0.2.0 + 回滚文案 |
| 09 | 失败（坏签名） | 现生成另一把私钥签 manifest | state=failed、中文错误、原始码在 data-*、可重试、版本未被改动 |

另测：窄窗 820 六态不溢出 / 面板不横向滚动；减少动态下按钮 transition=0s 且确认层仍可打开；
切源换 kind 写回、同 kind 不重写 `source.json`（不覆盖已保存的选择）。

## data-* 选择器

完整清单见 `artifacts/dxos-canvas-update-ui/SELECTORS.md`（每次运行重写）。
单一权威在 `src-vue/apps/canvasUpdateLogic.ts` 的 `CANVAS_UPDATE_SELECTORS`；
`tests/dxos-canvas-update-ui.test.mjs` 会对着组件源码逐条核对这些属性真实存在。

## 不在本探针范围

- 真实公网更新源（ModelScope / GitHub）的可用性、限流与 CDN 行为 —— 由 Stage 1 后端单测覆盖，
  本探针只证明「网络之外的整条链路 + 界面」正确。
- 更新后画布本体的运行 —— Stage 2 的范围。
