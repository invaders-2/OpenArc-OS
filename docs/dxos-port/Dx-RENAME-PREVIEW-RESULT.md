# Dx-RENAME-PREVIEW-RESULT · 命名统一 + 实时预览生效

> 本轮两件事：① 临时名 `OpenArc OS DX` → 正式名 `OpenArc OS`；② 排查并修复"实时预览打开后没有任何变化"。
> 工作区：`/Users/wepingli/.openarc-worktrees/dxos-port-r1`（分支 `dxos-port/r1`）。未 commit / 未 push。

## 1. 命名统一

### 1.1 全工作区出现位置（实测 grep）

| 位置 | 改动前 | 改动后 |
|---|---|---|
| 桌面 .app 路径 | `/Users/wepingli/Desktop/OpenArc OS DX.app` | `/Users/wepingli/Desktop/OpenArc OS.app` |
| Info.plist `CFBundleName` / `CFBundleDisplayName` | `OpenArc OS DX` | `OpenArc OS` |
| Info.plist `CFBundleIdentifier` | `com.openarc.os.dx` | `com.openarc.os` |
| 载荷 `package.json` 的 `name` | `openarc-os-dx` | `openarc-os` |
| 载荷 `openarc-build.json` 的 `payloadName` / `app` | `openarc-os-dx` / `…DX.app` | `openarc-os` / `…OpenArc OS.app` |
| 预览 profile | `openarc-os-dx-preview` | `openarc-os-preview`（由 .app 名派生，无需硬编码） |
| docs：`OpenArc-OS-DX-APP.md` | 文件名 + 27 处 | 重命名为 `OpenArc-OS-APP.md`，标识符全部替换 |
| docs：`Dx-APP-RESULT.md` / `Dx-ROUND-RESULT.md` | 各 7 处 | 已替换（历史叙述保留"改名统一前"限定语） |
| 脚本注释/示例：`scripts/{sync-app,dev-app}.mjs` | 4 处示例路径 | 已替换（纯注释/报错示例，行为不变） |
| 产品 UI | 一直是 `OpenArc OS`（`index.html:10` `<title>`、`electron/main.cjs:279` 窗口标题） | **无需改动**：UI 从未显示过 DX |

### 1.2 明确**不改**的 `DX` / 缩写（有实际语义，非临时命名）

| 名称 | 为什么保留 |
|---|---|
| `DX OS` / `DXSRC` / `server/*.ts` 引用 | 指被移植的**上游产品**（DX OS 0.5.1），是移植对象的名字，不是我们的临时名 |
| worktree 目录 `dxos-port-r1`、分支 `dxos-port/r1` | 指"DX OS 移植"这件事；改名会牵动 git 分支/worktree 注册，属外部引用 |
| `<userData>/dxos/` 数据目录、`electron/dxos-foundation-*.cjs`、`tests/dxos-*.test.mjs` | 数据域/模块命名空间，用于区分"来自 DX OS 的能力"，与临时应用名无关 |
| `experiments/dxos-p2/` | 同上 |
| `.dx-runtime`（下载目录内） | 上游分发结构，只读参照 |

判定口径：只有**指向"我们这个新造出来的 .app/产品身份"**的写法才算临时命名；指向**上游 DX OS 或移植域**的一律不动。

### 1.3 影响面（改名引发的真实后果，已按安全方式处理）

1. **userData 切换**：载荷名 `openarc-os` → userData = `~/Library/Application Support/openarc-os`，**即产品自身的 profile**（该目录里是 v21 真实身份库，2,744,320 B，最后写入 14:33）。
2. **首次双击该 .app 会把真实 profile 迁移到 v22**（P1 的 DX 表并入）。这是移植自身的需求；但迁移后 **v21 的旧构建将拒绝打开该库**（`identity-store.cjs:1707` "库版本高于程序版本则拒开"），例如从主仓库跑 `npm run desktop`。
   - 已做的安全措施：迁移前把 `identity.db` 备份到 `~/.openarc-backups/20261008-pre-v22/identity.db`（附加操作，未删改原库；本轮**没有**用真实 profile 启动过该 .app，其 mtime 保持 14:33）。
3. bundle id `com.openarc.os` 原属桌面上那个已消失的参照应用（见 §3）；LaunchServices 里可能残留旧注册，实际影响未验证。
4. 仓库脚本 `scripts/oa-status.mjs` 硬编码读取 `/Users/wepingli/Desktop/OpenArc OS.app` 的构建标记 —— 现在它读到的就是本 .app，与统一后的命名一致（未改脚本）。
5. 无 CI、无部署配置、无已发布链接、无仓库改名涉及；`package.json` 的 `name` 始终是 `openarc-os` 未改动。

## 2. "实时预览没有变化" 的排查与修复

### 2.1 复现与加载链路

- 入口：`npm run dev:app`（`scripts/dev-app.mjs`）→ 起 Vite dev server → 以 `OA_DEV_SERVER` 启动 Electron → `electron/main.cjs:71` 据此加载 `http://127.0.0.1:<port>/`（否则加载 `../dist/index.html`）。
- `REPO = path.resolve(__dirname, "..")`：**预览加载的是"脚本所在仓库"的代码**。

### 2.2 实测证据（CDP 直连渲染进程）

| 预览入口 | `model:command {command:'protocol/list'}` | `manifest/get` |
|---|---|---|
| worktree `:5199`（含移植） | `{ok:true, itemCount:53}` | `{ok:true, protocolHash:"e7b99192…"}` |
| 主仓库 `:5198`（基线 128e21d） | `MODEL_COMMAND_NOT_ALLOWED` | `MODEL_COMMAND_NOT_ALLOWED` |
| 桌面发布 .app（终态复验） | `{ok:true, itemCount:53}` | `{ok:true, protocolHash:"e7b99192…"}` |

**结论：移植在 IPC 层确实生效**（主仓库完全没有这些命令），所以"没有变化"不是"移植没生效"，而是下面 4 个原因叠加：

1. **入口指错地方**：项目根目录是主仓库（基线），移植只存在于 worktree；从主仓库起预览 = 看到旧代码，命令被白名单拒绝（上表第 2 行即证据）。
2. **页面停在 FIRST RUN**：预览 profile 未初始化时只渲染"初始化这台机器"向导，设置页根本没挂载，任何移植面都不可见。
3. **唯一被授权的 UI 落点几乎与被移植前同构**：`ModelSettings` 的 `data-d4-01-manifest-fields`（manifest 驱动的参数表单）在旧实现里**只在用户往注册表单输入过 `remoteModelId` 时才渲染**；正常进页面/刷新时 `mForm.remoteModelId` 为空 → 字段块直接不渲染 → 肉眼零差异。
   （更正我先前的假设：`Limits:` 那一行在旧实现里**已经**能显示真实值，不需要新修。）
4. **环境缺陷**：本 shell 带 `ELECTRON_RUN_AS_NODE=1`，而 `dev-app.mjs` 的**默认分支**没清掉它 → Electron 秒崩（`main.cjs:57 TypeError: Cannot read properties of undefined (reading 'isReady')`）；上一轮只在 `--app` 分支修过。

### 2.3 改动（两处最小修复）

| 文件 | 改动 |
|---|---|
| `scripts/dev-app.mjs:171,180` | 抽出 `electronEnv()`，**两种运行时都删 `ELECTRON_RUN_AS_NODE`**；默认分支其余行为不变 |
| `src/settings/ModelSettings.tsx:117-132` | 新增 `manifestModel`/`manifestIntent` 派生量：注册表单为空时回退到 `models[0]`，**进页面即自动 `manifest/get` 并渲染参数表单**；复用既有 DOM 标记与 `className="d401-caps"`，无新增样式/token/依赖/界面 |

### 2.4 可见性验证（真实预览 + 截图）

同一已存在模型（`gpt-image-1` + image-generation）、注册表单为空的两次全新进程：

| | `[data-d4-01-manifest-fields]` 组数 | 字段 |
|---|---|---|
| 修复前（before.png） | **0** | `[]` |
| 修复后（after.png） | **1** | `图片尺寸=1024x1024`、`质量=auto` |

- 截图：`artifacts/dxos-p2-ui/before.png`、`artifacts/dxos-p2-ui/after.png`、`artifacts/dxos-p2-ui/evidence.md`
- `npm run build` → exit 0；`npm test` → `# tests 1447 / pass 1446 / fail 1`（唯一失败为基线环境项 #337，无新增失败）

## 3. 未决与需你确认

1. **参照应用 `/Users/wepingli/Desktop/OpenArc OS.app` 在 14:52 被本会话之外的某个动作移除**（14:46 仍在且完好；不在废纸篓/暂存区，Spotlight 搜不到）。现在该路径上是**我们的移植版本**。是否要恢复原参照应用？（可用 `sync-app.mjs` 按同源底座重造，但会覆盖该路径。）
2. **真实 profile 迁移**：首次双击新 .app 会把 `~/Library/Application Support/openarc-os` 迁移到 v22，之后 v21 旧构建打不开它。已备份 `identity.db`。是否接受？（不接受就用 `--user-data` 隔离运行。）
3. **预览入口**：是否要把移植结果合并/同步到主仓库（`/Users/wepingli/Desktop/OpenArc OS`），让"项目根目录起预览"也能看到？这涉及主工作区写入与分支合并，属外部影响，等你确认。

## 4. NOT VERIFIED

- 未在真实 profile 上启动过新 .app（刻意避免迁移其数据），故"迁移后旧构建拒开"只有代码依据与备份，无实机复现。
- LaunchServices 中 `com.openarc.os` 的残留注册未清理也未验证。
- 非 image-generation 模型（如 chat）的字段自动渲染未实测；多模型时固定取 `models[0]`，选择合理性未验证。
- `test:model-settings-ui` 等 UI 子套件未跑（其 fixture 选择器 `[data-app-id=settings]` 在当前 src 中已不存在，疑探针本身失效，未改动）。
- HMR"存盘即刷新"的真实触发仍未演示（本轮未改动 `src/` 触发存盘）。
