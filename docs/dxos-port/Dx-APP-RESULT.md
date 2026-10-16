# Dx-APP-RESULT · 新 .app（N1–N10）

> 对应 N 项：在桌面产出与 `/Users/wepingli/Desktop/OpenArc OS.app` 等价的 macOS 应用包。
> 简短说明另见 `OpenArc-OS-APP.md`（执行岗产出）。

## 1. 参照应用的实现类型（实测）

| 项 | 实测 |
|---|---|
| 入口 | `Contents/MacOS/Electron` = **Mach-O 64-bit arm64 原生二进制**（非脚本包装），`otool -L` 仅链 `@rpath/Electron Framework.framework/Electron Framework` + `libSystem` |
| 本质 | **Electron 44.3.0 官方发行包改名**：`Contents/Frameworks` 含 Electron Framework + 4 个 Helper + Mantle/ReactiveObjC/Squirrel；`CFBundleExecutable=Electron`、版本号 = 44.3.0 |
| 载荷 | `Contents/Resources/app/`（**目录，非 app.asar**）：`dist/` + `electron/` + `package.json` + `openarc-build.json` |
| 身份 | `com.openarc.os` / `OpenArc OS`；`LSMinimumSystemVersion=13.0`；`CFBundleIconFile=electron.icns` |
| 签名 | adhoc（`Signature=adhoc`，`TeamIdentifier=not set`），Sealed Resources v2（267 files）；无 quarantine |

## 2. 采用的方案（与参照同源）

复制 `node_modules/electron/dist/Electron.app`（同为 44.3.0）→ 只改 3 个身份字段（Name/DisplayName/Identifier）→ 换载荷 → adhoc 签名。
**不使用 Swift/AppKit 自研**：窗口、交互、实时预览全部由 Electron + 现有代码决定，换技术栈只能做到外观相似，无法满足"保持一致"。

## 3. 产物与实测验证

| 项 | 结果 |
|---|---|
| 路径 | `/Users/wepingli/Desktop/OpenArc OS.app` |
| 身份 | `OpenArc OS` / `com.openarc.os` / 载荷 `openarc-os` |
| 元数据对齐 | `CFBundleExecutable=Electron`、`CFBundleIconFile=electron.icns`、`44.3.0/44.3.0`、`LSMinimumSystemVersion=13.0`；与 Electron 底座 `plutil` diff 仅 3 行 |
| 签名 / 隔离 | `Signature=adhoc`；`xattr` 中 quarantine 计数 **0** |
| 启动 | 双击路径（`open -a`）实跑成功。**改名统一前**临时名为 `openarc-os-dx`（userData `…/openarc-os-dx`，与产品隔离）；**统一为正式名后**载荷名 `openarc-os` → userData = `~/Library/Application Support/openarc-os`（产品 profile 本身；该目录里已有 v21 真实身份库，首次启动会迁移到 v22） |
| 渲染（终态复验，含 P1/P2 全部改动） | `/json/list` → `title "OpenArc OS"`，`url …OpenArc OS.app/Contents/Resources/app/dist/index.html`；CDP `Runtime.evaluate` → `{"w":1440,"h":940,"ready":"complete","root":true,"text":"FIRST RUN\\n初始化这台机器…"}` |
| 载荷来源 | `openarc-build.json`：`branch dxos-port/r1, commit 128e21d, dirty true, app …/OpenArc OS.app, payloadName openarc-os` |

## 4. 实时预览（与参照同一机制）

参照应用的"实时预览"= `scripts/dev-app.mjs`：Vite dev server + `OA_DEV_SERVER`（`electron/main.cjs:71` 只认显式设置），**src/ 改动走 Vite HMR，electron/ 改动自动重启主进程**，userData 隔离。
本轮为 `dev-app.mjs` 增加 `--app <路径>`：指定时 spawn 该 bundle 的 `Contents/MacOS/Electron`，仍注入 `OA_DEV_SERVER`，userData 默认错开为 `openarc-os-preview`。实测：加载 `http://127.0.0.1:5173/`，`hasRoot:true`，进程为 bundle 二进制。

## 5. NOT VERIFIED

- **HMR"存盘即刷新"的真实触发**：NOT VERIFIED（未修改 `src/` 以触发；只证明了 Electron 确实加载 dev URL 与 Vite 就绪）。
- **窗口外观与参照的像素级对照**：NOT VERIFIED（未做截图比对；未申请屏幕录制权限，改用 CDP 读取真实几何 1440×940）。
- **`sync-app.mjs` 默认路径（不带 `--app`）**：未执行（这正是"参照应用不被触碰"的保证）；因此默认分支在本轮 NOT VERIFIED。
- `app.asar` 内 `main.cjs` 未逐行核对（载荷是目录，`main.cjs` 来自仓库源码）。
- 参照应用当前**未在运行**：见 `Dx-ROUND-RESULT.md` §4 的异常说明（其 bundle 未被修改）。
