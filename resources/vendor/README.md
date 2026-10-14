# resources/vendor —— 厂商二进制 / 运行时放置目录（本仓不随附）

## 结论先行：本仓不随附任何第三方二进制

以下内容**不入仓、不随包**，需要使用者自行按其许可条款获取并放置：

| 厂商 | 缺失内容 | 说明 |
|---|---|---|
| 夸克网盘 | `quark-drive.cjs`（约 486 KB 的官方 CLI） | 官方 Node CLI，本仓只调用、不改写、不复制 |
| 紫鸟浏览器 | Python 运行时 / 紫鸟 MCP server（`server/ziniao/*.py` 及其运行环境） | 本仓不携带 Python 运行时，未配置即结构化不可用 |

**为什么不入仓**：厂商二进制的版权、许可证与版本归属厂商；把它复制进本仓会
把第三方内容随产品再分发，且升级/校验不可控。合规做法是"按路径调用"，
缺则**结构化不可用**（`INTEGRATION_UNAVAILABLE`），绝不假成功、绝不偷偷下载。

## 支持的三种提供方式（按优先级）

`electron/integration-quark.cjs` 与 `electron/integration-ziniao.cjs` 解析厂商路径时，
按下面的顺序查找（先命中者胜出）：

1. **插件配置项注入绝对路径**（最高优先级）
   - 夸克：`createPluginBundle({ quarkCliPath: "/绝对路径/quark-drive.cjs" })`，或
     `createQuarkIntegration({ cliPath })`；
   - 紫鸟：`createZiniaoIntegration({ runtimePath: "/绝对路径/ziniao-runtime" })`。
   - 注入路径必须是绝对路径、且不含 `..` 越界段；夸克必须是**存在的文件**，
     紫鸟可以是**目录或可执行文件**。越界 / 非文件会以
     `INTEGRATION_INVALID_INPUT` 结构化拒绝。
2. **环境变量**
   - 夸克：`DX_QUARK_CLI_PATH`（备用 `QUARK_DRIVE_CLI`）；
   - 紫鸟：`DX_ZINIAO_RUNTIME`（指向运行时目录或可执行文件）；
   - 可选通用：`DX_VENDOR_DIR` 作为厂商目录根，夸克按 `<DX_VENDOR_DIR>/quark-drive.cjs` 查找。
3. **文件放置**
   - `<userData>/dxos/vendor/`：用户级放置，优先于随包目录；
     - 夸克：`<userData>/dxos/vendor/quark-drive.cjs`
     - 紫鸟：`<userData>/dxos/vendor/ziniao/`
   - **本目录**（`<应用根>/resources/vendor/`）：随包放置；
     - 夸克：`<应用根>/resources/vendor/quark-drive.cjs`
     - 紫鸟：`<应用根>/resources/vendor/ziniao/`

> 说明：`resources/` 会由 `scripts/sync-app.mjs` 一起同步进 `.app` 的
> `Contents/Resources/app/resources`，所以放在本目录的文件随应用分发；
> 但**本仓不预置任何厂商文件**，该目录默认是空的。

## 全部缺失时的行为

不静默降级、不联网下载：

- 夸克：`integration/quark/*` 返回 `INTEGRATION_UNAVAILABLE`，
  `detail` 列出上述四个放置位置；`integration/quark/status` 的
  `cliPath` / `cliSource` / `cliExists` 如实报告解析结果。
- 紫鸟：`integration/ziniao/status` 的 `runtime` 字段如实报告
  `{ configured, source, path, available }`；调用 `requireRuntime()` 时
  以 `INTEGRATION_UNAVAILABLE` + 放置说明拒绝。

## 自检

```bash
# 夸克：显式注入时状态可见（不启动任何进程）
node -e "const{createQuarkIntegration}=require('./electron/integration-quark.cjs');console.log(createQuarkIntegration({dataDir:require('node:os').tmpdir()}).status())"
```

离线测试：`node --test tests/dxos-vendor-paths.test.mjs`。
