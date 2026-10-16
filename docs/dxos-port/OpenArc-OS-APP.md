# OpenArc OS · 新 .app 构建与实时预览

> 角色：N1–N10「新 .app」执行岗。本文只覆盖新增的 .app 与其构建/预览脚本，不改渲染层、不改设计规范。
>
> **命名统一（用户后续指令）**：临时名 `OpenArc OS DX` 已统一为正式名 `OpenArc OS`（显示名、bundle id `com.openarc.os`、载荷名 `openarc-os`、桌面路径 `/Users/wepingli/Desktop/OpenArc OS.app`）。
> 临时名与正式名**只差三个身份字段**，脚本本身与名字无关（`scripts/sync-app.mjs` 由 `.app` 目录名派生 `slug` → 载荷名 → bundle id），因此改名的唯一实际影响是 **userData 目录**（见 §4）。
> 另：本文 §2 提到的"本地既有产品参照 `/Users/wepingli/Desktop/OpenArc OS.app`"在 2026-10-08 14:52 被本会话之外的某个动作从桌面移除（不在废纸篓、不在暂存区、Spotlight 也搜不到）；其 bundle 在移除前完好（`Info.plist` SHA256 `af4aa1e6…`，未被我方改动）。该消失不是本轮任何命令造成的。

## 1. 产物身份

| 项 | 值 |
|---|---|
| 显示名 | OpenArc OS |
| 路径 | `/Users/wepingli/Desktop/OpenArc OS.app` |
| bundle id | `com.openarc.os` |
| 载荷名（载荷 package.json 的 `name`） | `openarc-os` → userData `~/Library/Application Support/openarc-os` |
| 底座 | `node_modules/electron/dist/Electron.app`（Electron 44.3.0，arm64，adhoc+linker-signed） |
| 签名 | adhoc（`codesign --force --deep --sign -`），无 quarantine |
| 首个载荷来源 | 已提交 ref `128e21d`（干净 detached worktree 构建，`dirty=false`） |

## 2. 参照应用的实现类型

两组参照，都不是"从零编译"：

1）**被移植对象 DX OS 0.5.1**（只读 `DXSRC`）：Electron 壳 + `Contents/Resources/app.asar` 打包主进程 + `Contents/Resources/app.asar.unpacked/server/` 的 TypeScript 后端。
- `server/index.ts:2` 写 `// DX OS · API 后端（Express + tsx）`；`server/index.ts:5` `import express from 'express'` —— 后端是 Express。
- `server/dataPaths.ts:10` 默认数据根 `~/DX OS/data`；`server/dataPaths.ts:13` `DATA_ROOT = resolve(process.env.DX_DATA_DIR || process.env.CCS_DATA_DIR || defaultDataRoot())` —— 本地落盘，不是云。
- `server/worker.ts:1-15` 独立 worker（队列/租约/React 任务/视频渲染）。
- `app.asar` 内主进程 `main.cjs` 用内置 node+tsx spawn `server/index.ts` 与 `server/worker.ts`：见计划文档 `DXOS-PORT-IMPLEMENTATION-PLAN.md` §2.2（第 79、372 行）。**未解包 app.asar 逐行核对**（见 §8）。

2）**本地既有产品参照 `/Users/wepingli/Desktop/OpenArc OS.app`**：同样是"复制 Electron.app + 替换 `Contents/Resources/app` 载荷目录"，不是 asar：
- 载荷为目录：`Contents/Resources/app/{dist,electron,package.json,openarc-build.json}`（实测）。
- Info.plist 与 Electron 底座逐字段相同，只有 CFBundleName / CFBundleDisplayName / CFBundleIdentifier 三个字段不同。
- adhoc 签名（`codesign -dv` 实测 `Signature=adhoc`）。

**本次采用与本地参照同源的做法**：复制同一份 Electron 44.3.0 底座，替换载荷目录，只改三个身份字段。理由：与既有产品形态完全一致、与底座版本逐字节对齐、零新增依赖；asar 打包会引入 asar 工具链，本轮不需要。

## 3. 关键文件清单

| 绝对路径 | 一句话作用 |
|---|---|
| `/Users/wepingli/.openarc-worktrees/dxos-port-r1/scripts/sync-app.mjs` | 新增 `--app <路径>`：仍从已提交 ref 干净构建并同步载荷；目标 .app 不存在时按同源底座现造；退出/重启只作用于该 .app |
| `/Users/wepingli/.openarc-worktrees/dxos-port-r1/scripts/dev-app.mjs` | 新增 `--app <路径>`：改用该 bundle 的 `Contents/MacOS/Electron` 做实时预览，userData 默认错开为 `<slug>-preview` |
| `/Users/wepingli/Desktop/OpenArc OS.app` | 新产物：Electron 44.3.0 底座 + 128e21d 载荷 + adhoc 签名 |
| `/Users/wepingli/.openarc-worktrees/dxos-port-r1/docs/dxos-port/OpenArc-OS-APP.md` | 本文件 |

## 4. 启动方式

- **双击**：Finder 双击 `OpenArc OS.app`；命令行等价 `open "/Users/wepingli/Desktop/OpenArc OS.app"`。
- **直接跑二进制**：`"/Users/wepingli/Desktop/OpenArc OS.app/Contents/MacOS/Electron"`。
- ⚠️ 某些自动化 shell 的环境里有 `ELECTRON_RUN_AS_NODE=1`，此时 Electron 会退化成纯 Node 并立刻退出（实测 exit 9，日志 `bad option: --user-data-dir`）。`sync-app.mjs --app` 的自动重启已清掉该变量；手动命令行请用 `env -u ELECTRON_RUN_AS_NODE ...`。Finder 双击不受影响。
- userData：载荷 `package.json` 的 `name=openarc-os`（**只改 .app 内那一份拷贝**，仓库 `package.json` 未动）→ userData = `~/Library/Application Support/openarc-os`，**即产品自身的 profile**。
  这是改名统一后的预期行为（正式应用就该用正式数据目录）；代价见下方"影响面"：该目录里已有 v21 的真实身份库，首次启动本 .app 会把它迁移到 v22。
  需要隔离时用 `--user-data <路径>`（预览态默认仍是 `openarc-os-preview`，见 §5）。

## 5. 实时预览（src 改动 → HMR；electron 改动 → 重启）

```
npm run dev:app -- --app "/Users/wepingli/Desktop/OpenArc OS.app"
# userData 自动 → ~/Library/Application Support/openarc-os-preview
# 其余参数原样转给 Electron，例如 --remote-debugging-port=9224
```

流程：脚本先起 Vite（默认 5173）→ 等 `http://127.0.0.1:5173/` 就绪 → 以 `OA_DEV_SERVER=http://127.0.0.1:<port>` 启动 bundle 的 Electron。`electron/main.cjs:71` 只认显式 `OA_DEV_SERVER` 并据此加载 dev URL（`:73`、`:75`）。因此：
- `src/**` 存盘 → Vite HMR 热更（默认行为）。
- `electron/**` 存盘 → 脚本整组重启 Electron（默认行为；`--no-watch` 关闭）。app path 仍指向仓库（`spawn(electronPath, [".", ...])`），所以重启能吃到仓库新代码；`--app` 只换运行时二进制与 userData。

## 6. 元数据对照表

| 字段 | Electron.app（底座） | OpenArc OS.app（既有参照） | DX OS.app 0.5.1（DXSRC） | OpenArc OS.app（新） |
|---|---|---|---|---|
| CFBundleName | Electron | OpenArc OS | DX OS | **OpenArc OS** |
| CFBundleDisplayName | Electron | OpenArc OS | DX OS | **OpenArc OS** |
| CFBundleIdentifier | com.github.Electron | com.openarc.os | cn.meross.dxos | **com.openarc.os** |
| CFBundleExecutable | Electron | Electron | DX OS | Electron |
| CFBundleIconFile | electron.icns | electron.icns | icon.icns | electron.icns |
| CFBundleShortVersionString / BundleVersion | 44.3.0 / 44.3.0 | 44.3.0 / 44.3.0 | 0.5.1 / 0.5.1 | 44.3.0 / 44.3.0 |
| LSMinimumSystemVersion | 13.0 | 13.0 | 12.0 | 13.0 |
| 载荷形态 | default_app.asar | `Resources/app/` 目录 | app.asar + app.asar.unpacked | `Resources/app/` 目录 |
| 签名 | adhoc（linker-signed） | adhoc | 未核对 | adhoc |

新 .app 的 Info.plist 与底座逐字段 diff **只出现上述 3 行差异**（CFBundleName / DisplayName / Identifier）。

## 7. 验证命令与真实输出（尾部）

```
$ plutil -lint ".../OpenArc OS.app/Contents/Info.plist"
/Users/wepingli/Desktop/OpenArc OS.app/Contents/Info.plist: OK

$ codesign -dv --verbose=4 ".../OpenArc OS.app"
Identifier=com.openarc.os
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=298 flags=0x2(adhoc) hashes=3+3 location=embedded
Signature=adhoc
Info.plist entries=31
Sealed Resources version=2 rules=13 files=267

$ xattr -lr ".../OpenArc OS.app" | grep -c com.apple.quarantine
0

$ file ".../OpenArc OS.app/Contents/MacOS/Electron"
.../Contents/MacOS/Electron: Mach-O 64-bit executable arm64

$ cat ".../OpenArc OS.app/Contents/Resources/app/openarc-build.json"
{ "branch": "(detached)", "commit": "128e21d", "dirty": false, "ref": "128e21d",
  "builtAt": "2026-10-08T06:12:51.432Z", "by": "scripts/sync-app.mjs",
  "app": "/Users/wepingli/Desktop/OpenArc OS.app", "payloadName": "openarc-os" }

$ curl -s http://127.0.0.1:9223/json/list     # 直接启动该 bundle + 独立 userData
[ { "title": "OpenArc OS", "type": "page",
    "url": "file:///Users/wepingli/Desktop/OpenArc%20OS.app/Contents/Resources/app/dist/index.html" } ]
$ CDP Runtime.evaluate
{"w":1440,"h":940,"title":"OpenArc OS","bodyChildren":1,"ready":"complete","hasRoot":true,
 "textHead":"FIRST RUN\n初始化这台机器\n..."}

$ npm run dev:app -- --app ".../OpenArc OS.app" --no-watch --remote-debugging-port=9224
[dev:app] OpenArc OS 实时预览（Electron 来自 /Users/wepingli/Desktop/OpenArc OS.app）
[dev:app] userData   .../openarc-os-preview（与产品的 openarc-os 隔离）
[openarc] 开发预览：加载 http://127.0.0.1:5173/（OA_DEV_SERVER 已设置）
/json/list → title "OpenArc OS", url "http://127.0.0.1:5173/"
CDP → {"w":1440,"h":940,"hasRoot":true,"text":"FIRST RUN\n初始化这台机器..."}

$ npm run build        # 在 worktree 内
> tsc --noEmit && vite build
✓ 1638 modules transformed.
✓ built in 1.16s
BUILD_EXIT:0

$ npm test
# tests 1424
# pass 1402
# fail 22
# duration_ms 180819
```

`npm test` 的 22 条失败**与本次改动无关**，来自同一 worktree 里其他人的未提交改动：`electron/identity-store.cjs` 把 `SCHEMA_VERSION` 由 21 改成 22（并新增 `electron/dxos-foundation-schema.cjs`），导致断言 schema 版本/迁移级别的用例失败。对照实验（同 4 个测试文件）：

```
baseline 128e21d 干净检出：tests 40 / pass 39 / fail 1（仅 D5-03-E ACP SDK 版本用例，基线即失败）
当前 dirty worktree：    tests 40 / pass 36 / fail 4（上述 1 条 + 3 条 schema 断言）
```

本次改动只落在 `scripts/*.mjs`（无任何测试 import）与新增文档，故不引入回归；但本 worktree 的 `npm test` 当前不是全绿。

## 8. NOT VERIFIED

- **`npm test` 全绿**：NOT VERIFIED。当前 worktree 有并行未提交改动（`electron/identity-store.cjs` 等）导致 22 条失败；其中 21 条由 schema 21→22 引起，1 条 ACP SDK 版本用例在基线 128e21d 即失败。修复这些需要改 `electron/**`，不在本岗 write scope。
- **HMR「存盘即刷新」的端到端触发**：NOT VERIFIED。硬约束禁止改 `src/**`，无法真实存盘触发；已验证的是机制（Electron 确实加载 `http://127.0.0.1:5173/`，Vite 在跑）。
- **`electron/**` 改动自动重启**：NOT VERIFIED（同上，禁止改 `electron/**`）；已验证重启路径本身（`sync-app.mjs --app` 的退出/重启分支实跑成功，DX 应用被拉起且参照应用未受影响）。
- **`app.asar` 内 `main.cjs` 行为**：NOT VERIFIED（未解包 asar 逐行核对），仅采信计划文档 §2.2（第 79、372 行）与 `server/` 源码。
- **DX OS.app 的签名类型**：NOT VERIFIED（未对其运行 `codesign -dv`）。
- **图形化截图对照**：NOT VERIFIED。本次是功能/启动/渲染验收，无 UI 视觉改动，未截图。
