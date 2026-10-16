# resources/market —— 随包本地市场清单

本目录只放**离线本地市场清单**。`market-service.cjs` 按下面的优先级查找
`catalog.json`（第一个存在的目录胜出）：

1. 显式注入的 `marketDir`（测试用）；
2. **随包目录** `<应用根>/resources/market`（即本目录，打包后随应用分发）；
3. 本地目录 `<userData>/dxos/market`。

目录来源、条目合法性、是否有网络都在这一层定死：**不联网、不下载、不安装**，
不含 `api.dx-os.com` / `fetch` / `http`。云发布 / 审核 / 灰度一律 OUT。

## 当前状态：有效但空

`catalog.json` 现在是一份**合法且为空**的清单（`apps` 与 `skillPacks` 都是空数组）。
空清单不是错误：市场命令会正常返回 0 个条目（`market/health` 报 `present: true, valid: true, appCount: 0`），
不会退回 `MARKET_CATALOG_MISSING`。**不许为了"看起来有内容"编造示例 App / 技能包**。

## 怎么投放条目

直接编辑 `catalog.json` 的 `apps` / `skillPacks` 数组；字段含义见文件内的
`fields` / `appItemFields` / `skillPackItemFields`。要点：

- `version` 必须为 `1`，否则整份清单判 `MARKET_MANIFEST_INVALID`；
- 单条 `id` 只允许 `[a-zA-Z0-9._-]`；`name` / `version` 必填；App 的 `build` 必须是
  大于 0 的整数；缺任一项的条目会被丢弃并计入 `rejected`；
- 某个非空数组若**所有**条目都非法，整份清单判 `MARKET_MANIFEST_INVALID`；
- `skillPacks[].entry` 只允许相对路径，绝对路径与 `..` 会被清空（条目本身仍可列出）；
- `items` 是保留字段，恒为空；条目只从 `apps` / `skillPacks` 读。

## 改成"随用户本地目录"覆盖

想在不改随包文件的前提下投放，把同名 `catalog.json` 放到
`<userData>/dxos/market/`。随包目录仍然优先，只有随包目录没有清单时才会读本地目录。
