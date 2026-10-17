# 无限画布在线更新（Stage 2 · 装得上，也真的生效）

本文档说明如何在线更新「无限画布」应用。Stage 1 交付后端核心 + 打包/签名工具链；
Stage 2 把包格式扩展为**静态 Web 应用包**，并让渲染层**优先加载已安装版本、没有安装包时回退内置 bundle**。
渲染层的「检查更新」界面由另一包负责（`src-vue/apps/CanvasUpdatePanel.vue`）。

- 命令通道：`market:command`（命令族 `market/update/*`）
- preload 键：`window.openarc.marketUpdate.command({ command, payload })`（第 39 个顶层键）
- 更新源：**适配器注册表**，目前两个实现，默认源为 **ModelScope 仓库**（`bllack/OpenArc-OS`），
  GitHub Releases 保留为可显式切换的源
  | kind | 说明 | 默认 owner/repo |
  | --- | --- | --- |
  | `modelscope-repo` | ModelScope 仓库 + 约定清单（**默认源**） | `bllack/OpenArc-OS` |
  | `github-releases` | GitHub Releases + 资产（可显式切换） | `invaders-2/OpenArc-OS` |

## 0. 源适配器

统一接口（`electron/market-update-sources.cjs`）：

```
describeSource()                      → { kind, label, owner, repo, apiUrl, allowedHosts,
                                          configurableFields, defaultRepository, manifestPath }
listReleases({ channel })             → 候选数组（语义化版本降序；无可用版本回 []，不是报错）
resolveAsset(version, { channel })    → 单个候选或 null
downloadAsset(candidate)              → { bytes, sourceSha256 }
```

- `github-releases`：现有 GitHub Releases 逻辑原样搬移，行为不变。
- `modelscope-repo`：走 ModelScope 匿名 API + 约定清单，见下。
- 注册表是显式的（`sourceKinds() / isSourceKind() / getSourceDescriptor() / createSource()`），
  服务里不再堆 if-else；选择持久化在 `<userData>/dxos/apps/canvas/source.json`。
- **持久化优先**：只有从没选择过（`source.json` 缺失或非法）才用默认源；一旦存在合法的显式选择
  （包括旧版本默认的 `github-releases`），一律以保存的选择为准，新默认值不会覆盖它。

## 1. ModelScope 版本发现（无 release/tag 语义）

约定仓库内清单文件 **`updates/canvas/latest.json`**：

```json
{ "version": "0.1.0", "build": 1,
  "asset": "updates/canvas/canvas-0.1.0.zip",
  "sha256": "<asset zip 的 sha256hex>",
  "notes": "可选，URL 时作为 notesUrl",
  "publishedAt": "可选，ISO 字符串或毫秒数" }
```

发现路径（两条都给）：

1. **分支**：`GET /api/v1/models/{owner}/{repo}/revisions` → `Data.RevisionMap.Branches`，
   取第一个分支（当前为 `master`）作为 `Revision`，读同一 revision 的清单。
2. **tag**：同一响应里 `Data.RevisionMap.Tags` 非空时，**每个 tag 也按同一清单探测一遍**，
   取该 tag 的 revision 读清单。两个路径的候选合并去重后按语义化版本降序取最高。
   （注意：`/repo/branches` 与 `/repo/tags` 都是 404，不要用；只用 `/revisions`。）

每次发现先取该 revision 的文件清单
（`GET /api/v1/models/{owner}/{repo}/repo/files?Revision={rev}&Recursive=true`，`Data.Files[]`
每项含 `Path / Size / Sha256 / Revision / Type`）；**清单路径不存在 = 该 revision 无可用版本**
（如实回「无可用更新」，不是报错）。清单引用的 asset 必须在同一文件清单里。
下载走 `GET /api/v1/models/{owner}/{repo}/repo?Revision={rev}&FilePath={path}`（匿名可下）。

## 2. 信任模型（缺一段都不安装）

1. **逐源主机白名单 + 必须 HTTPS**：每个源只允许自己那一组主机，下载重定向**逐跳**校验，
   越界即 `MARKET_UPDATE_HOST_NOT_ALLOWED`；渲染层只能配置 `kind + owner/repo`，不能填任意 URL。
   | 源 | 允许主机 |
   | --- | --- |
   | `github-releases` | `api.github.com`、`github.com`、`objects.githubusercontent.com`、`github-releases.githubusercontent.com`、`release-assets.githubusercontent.com` |
   | `modelscope-repo` | `modelscope.cn`、`cdn-lfs-cn-1.modelscope.cn`（2026-10-16 实测的 LFS 重定向落点） |

   > **重定向实测**（2026-10-16）：ModelScope 小文件（如 README）直接 200 返回；**LFS/大文件**
   > 会 `302` 到 `https://cdn-lfs-cn-1.modelscope.cn/prod/lfs-objects/...`（用 Qwen 多个仓库的
   > `model.safetensors` / `pytorch_model.bin` 实测一致）。因此只为该源加入
   > `cdn-lfs-cn-1.modelscope.cn` 这一个精确主机。**已知限制**：其他 CDN 分片
   > （例如 `cdn-lfs-us-1.modelscope.cn`）与对象存储域名未被观测到，保持拒绝；
   > 若将来真实出现，需先实测再单独加白并更新本文档。
2. **Ed25519 验签**：用内置公钥（`resources/app-update-keys.json` 的 `canvas` 字段）
   对 zip 里 **manifest.json 的原始字节** 验 `manifest.sig`。缺签名、签名不符、公钥不可用一律拒绝。
   ModelScope 用可变的 `master` 不降低安全性：信任锚始终是签名，不是分支不可变性。
3. **摘要校验**：逐个比对 `manifest.files` 里每个文件的 sha256；不匹配即 `MARKET_UPDATE_DIGEST_MISMATCH`。
4. **纵深交叉比对（ModelScope）**：下载到的 asset 字节 sha256 必须等于 ModelScope 文件清单里该文件的
   `Sha256`（并顺带核对清单文件自身与 manifest 声明的 `sha256`）；不一致即
   `MARKET_UPDATE_SOURCE_DIGEST_MISMATCH`。文件清单不能被渲染层影响。
5. **解压围栏**：只写 `manifest.files` 里经过白名单校验的相对文件名；出现绝对路径、`..`、
   反斜杠等条目直接拒绝（`MARKET_UPDATE_INVALID_INPUT`）。
6. **原子切换**：解压到同目录 staging → `rename` 到位；`current.json` 用临时文件 + rename 原子替换；
   **激活前**把落盘后的整包再验一次签名 + 再比一次文件摘要（防止落地后被改）。
7. **审计**：每次 `install` / `rollback`（成功 ALLOW、失败 DENY）写
   `authStore.auditAuthorization`（`action=canvas.update.install|canvas.update.rollback`）。
   `rollback` 额外用既有 `oldPermissions` / `newPermissions` 两列留痕 from → to
   （已安装目标 `{kind:"installed",version}`，内置目标 `{kind:"builtin",version:"0.1.0"}`，
   `resourceRef` 记为 `<appId>@builtin`）。详见 5.1。

安装目录：`<userData>/dxos/apps/canvas/<version>/`；
指针：`<userData>/dxos/apps/canvas/current.json`（正常 `{version,digest,kind,entry,installedAt}`；
回退到内置版本后为内置标记 `{mode:"builtin",version:null,builtinVersion,rolledBackFrom,clearedAt}`）；
历史：`history.json`（回滚依据）；最近检查结果：`check.json`；源选择：`source.json`。
回退到内置版本**只原子替换 `current.json` 这一个文件**，版本目录与 `history.json` 一律保留 ——
想切回已安装版本，重新 `install` 同一版本即可。

## 3. 冻结的包格式（`openarc-app/v1`）

资产文件名固定 `canvas-<version>.zip`，两种**形态**共用同一签名与逐文件 sha256：

### 3.1 `static-web`（Stage 2 默认，画布用这个）

画布是多页静态树（`static/canvas-list.html` / `static/canvas.html` / `static/smart-canvas.html` + `static/**`），
不是 JS 模块应用，所以用静态 Web 包发布**整棵树**：

```
manifest.json   { format:"openarc-app/v1", id:"canvas", kind:"static-web", name, version, build,
                  entry:"static/canvas-list.html",
                  files:{ "static/canvas-list.html":"<sha256>", "static/js/app.js":"<sha256>", ... } }
static/**       要发布的整棵静态树（逐文件 sha256）
manifest.sig    对 manifest.json **原始字节** 的 Ed25519 签名（base64）
```

- `entry` 必须是安全的相对 `.html` 路径，且出现在 `files` 里；`files` 不能为空。
- 文件名沿用 `isSafeEntryName`：拒绝绝对路径、盘符、反斜杠、`.`、`..`、空段。

### 3.2 `js-module`（Stage 1 老格式，继续兼容）

`manifest` 不带 `kind`（或显式 `kind:"js-module"`）时按老形态校验，行为与 Stage 1 完全一致：

```
manifest.json   { format:"openarc-app/v1", id:"canvas", name, version, build,
                  entry:"index.js", styles:["index.css"],
                  files:{ "index.js":"<sha256>", "index.css":"<sha256>" } }
index.js / index.css
manifest.sig
```

老包仍能验签、验摘要、安装；只是它不是 `static-web`，画布协议不会拿它当画布加载（如实回退内置）。

### 3.3 占位包

`--placeholder` 产出的占位包必须在 `manifest.placeholder:true`；**安装与加载一律拒绝**
（`MARKET_UPDATE_UNSUPPORTED`），防止被当成真产物发布。默认打包不再产出占位产物。

两个源用同一个 zip；ModelScope 只是多一个 `updates/canvas/latest.json` 清单。

## 3.4 画布 bundle 的解析顺序与回退矩阵

`openarc-canvas://` 协议（`electron/canvas-package-resolver.cjs`）按下面顺序取根目录：

1. `<userData>/dxos/apps/canvas/current.json` 指向的已安装版本目录（整包校验通过才用）；
   指针是回退到内置版本时写入的内置标记 `{mode:"builtin",version:null,...}` 时，
   按 `pointer-cleared` 直接走 2 / 3（这是用户显式选择的状态，**不是损坏**）；
2. `dist/novai-canvas`（构建产物）；
3. `public/novai-canvas`（随仓库内置，保底、离线可用）。

已安装版本的整包校验链：指针合法 → 目录存在 → `manifest.sig` Ed25519 验签 → `manifest` 合法且
`kind:"static-web"` 且非占位包 → `current.json.digest` 与 manifest 原始字节一致 → 逐个文件 sha256 →
`entry` 落盘。任一环失败都**结构化回退**到内置 bundle（并写入响应头 + 主进程日志），不静默 500、不白屏。

| 失败原因（`fallbackReason`） | 触发条件 |
| --- | --- |
| `pointer-missing` | `current.json` 不存在 |
| `pointer-cleared` | `current.json` 是「回退到内置版本」写入的内置标记（`mode:"builtin"`），属正常状态而非故障 |
| `pointer-invalid` | JSON 损坏 / `version` 非语义化版本 |
| `pointer-digest-mismatch` | `current.json.digest` 与 `manifest.json` 原始字节不符 |
| `version-dir-missing` | 版本目录不存在 |
| `manifest-missing` / `signature-missing` | 缺 `manifest.json` / `manifest.sig` |
| `signature-invalid` | Ed25519 验签失败 |
| `manifest-invalid` | manifest 字段非法 |
| `not-static-web` | 已安装包是 `js-module` 等非静态 Web 形态 |
| `placeholder` | `manifest.placeholder:true` |
| `entry-missing` / `file-missing` | entry 未落盘 / 清单里的文件缺失 |
| `digest-mismatch` | 某个文件 sha256 不符 |
| `public-key-unavailable` | 内置公钥不可用 |

全部不可用（连内置 bundle 都没有）时回 `503` + 中文说明页（`reason=builtin-missing`），不返回空白。
安全语义与 Stage 1 原样一致：只读、MIME 白名单、拒绝目录穿越；已安装目录同样不带凭据、不给本地路径。

协议响应头（便于诊断，不含本地路径）：`x-openarc-canvas-source`（`installed`/`dist`/`public`）、
`x-openarc-canvas-version`（已安装版本）、`x-openarc-canvas-fallback`（回退原因）。

## 4. 发布流程（GitHub Actions 云端打包 + 发布 Releases）

两个源共用同一次打包：一次构建同时产出 GitHub Release 资产与 ModelScope 仓库清单。
发布链全部在云端完成：`npm ci` → `npm run build` → 打包 + Ed25519 签名 → 建 Release →（可选）同步 ModelScope。
工作流：`.github/workflows/release-canvas.yml`。**私钥只走 GitHub Secret，绝不进仓库 / 日志**。

### 4.0 本机等价命令（CI 里跑的就是这几条，没有隐藏魔法）

```bash
# ① 生成签名密钥（只做一次；私钥写 .keys/update-signing.key，0600，已 gitignore，绝不入库）
node scripts/oa-update-keygen.mjs
#    → 公钥写入 resources/app-update-keys.json

# ② 构建产物（dist/novai-canvas）
npm ci && npm run build

# ③ 密钥指纹校验：从私钥导出公钥并与仓库公钥比对（打印公钥 sha256，不打印私钥）
node scripts/oa-canvas-package.mjs --check-key --keys-file resources/app-update-keys.json

# ④ 打包 + 签名（同时产出 GitHub 资产与 ModelScope 清单）
node scripts/oa-canvas-package.mjs --kind static-web --source dist/novai-canvas \
  --version 0.01 --keys-file resources/app-update-keys.json
#    → dist-updates/canvas-0.01.zip                  GitHub Release 资产
#    → dist-updates/updates/canvas/canvas-0.01.zip   ModelScope 仓库内同路径资产
#    → dist-updates/updates/canvas/latest.json       ModelScope 版本清单

# ⑤ 用仓库公钥复核产物（验签 + 逐文件 sha256；不需要私钥）
node scripts/oa-canvas-package.mjs --verify dist-updates/canvas-0.01.zip --keys-file resources/app-update-keys.json

# ⑥ ModelScope 同步预检；配置 MODELSCOPE_TOKEN 后才真正推送
node scripts/oa-modelscope-sync.mjs --dry-run
```

- `--check-key` / `--keys-file`：私钥导出的公钥必须与 `resources/app-update-keys.json` 的 `canvas` 字段逐字节一致，
  否则非零退出（换密钥时最容易漏更新 Secret 或公钥）。
- `--verify`：用**仓库公钥**验 `manifest.sig` + 逐文件 sha256。
- 版本支持 `major.minor` 与 `major.minor.patch`，允许前导零：`--version 0.01` 产出
  `manifest.version="0.01"`、`dist-updates/canvas-0.01.zip`、tag `canvas-v0.01`；
  比较按数值规范化（`0.01 ≡ 0.1.0`；`0.02 > 0.01`）。
- 默认**不再产出占位产物**：找不到真实静态树非零退出。
  显式指定源：`--source public/novai-canvas [--entry static/canvas-list.html]`；
  老 JS 模块包：`--kind js-module --source <含 index.js/index.css 的目录>`；
  仅测试的占位包：`--placeholder`（`manifest.placeholder=true`，安装/加载一律拒绝）。

### 4.1 一次性设置：两个 Secret 与权限

GitHub → 仓库 **Settings → Secrets and variables → Actions → New repository secret**：

| Secret | 内容 | 不配置的后果 |
| --- | --- | --- |
| `OA_UPDATE_SIGNING_KEY` | 本机 `.keys/update-signing.key` 的**完整 PEM 文本**（含 `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` 两行） | 工作流在“写入私钥”那一步直接失败，不产出任何 Release |
| `MODELSCOPE_TOKEN` | ModelScope 访问令牌（平台「访问令牌 / Personal Access Token」） | 发布仍成功，但同步步骤跳过并明确提示「更新源未同步」（见 4.3） |

- 权限：工作流已声明 `permissions: contents: write`（用内置 `GITHUB_TOKEN` 建 Release）；
  仓库 **Settings → Actions → General → Workflow permissions** 不要改成只读。
- **绝不要把私钥提交进仓库**：`.keys/` 已在 `.gitignore`；私钥泄露按 4.5 换密钥。
- 复核公钥：`node scripts/oa-update-keygen.mjs --print`（只打印，不写任何文件）。

### 4.2 发一版

两条触发方式二选一：

1. **打 tag（推荐）**：
   ```bash
   git tag canvas-v0.01
   git push origin canvas-v0.01
   ```
   工作流从 tag 名取版本（`canvas-v0.01` → `0.01`）。
2. **手动触发**：GitHub → **Actions → Release Canvas → Run workflow**，填 `version`（如 `0.01`），
   可选 `notes`。手动触发时若 tag 不存在，`gh release create` 会按默认分支创建 `canvas-v0.01`。

工作流步骤：写私钥 → `--check-key` 指纹校验 → 打包签名（`--keys-file` 再次强制配对）→
`--verify` 用仓库公钥复核 → `gh release create/upload`（资产：`canvas-<version>.zip` + `updates/canvas/latest.json`）
→ 可选同步 ModelScope。任一校验失败都会 fail，不会发出未签名或签名不配对的包。

### 4.3 ModelScope 作为更新源（默认源）

应用的**默认更新源就是 ModelScope** `bllack/OpenArc-OS`。工作流最后一个 job（`sync-modelscope`）
把 `updates/canvas/latest.json` 与 `updates/canvas/canvas-<version>.zip` 同步到该仓库的 `updates/canvas/` 下
（`node scripts/oa-modelscope-sync.mjs`；用系统 git + `oauth2:<token>@www.modelscope.cn` 推送，不新增依赖）。

- 配了 `MODELSCOPE_TOKEN`：自动同步；`latest.json.sha256` 与 zip 不一致会**拒绝推送**并让该 job 失败。
- **没配**：该步骤被跳过，日志与运行摘要明确写「⚠️ 更新源未同步：未配置 MODELSCOPE_TOKEN」，
  **不算失败**（GitHub Release 已发布）。此时应用默认源看不到新版本，需手动同步或先配好 Secret。

### 4.4 发布后应用里的「检查更新」行为

- 默认源（ModelScope）读 `updates/canvas/latest.json`，按清单里的 asset 下载、逐跳校验白名单主机、
  用**内置公钥**验 `manifest.sig`、逐文件 sha256，并与 ModelScope 文件清单的 `Sha256` 交叉比对，全过才安装（见第 2 节）。
- `check` 返回 `{ latest, updateAvailable }`：`updateAvailable = compareSemver(latest, 当前版本或内置版本) > 0`。
- **注意**：当前内置画布版本是 `0.1.0`（`APP_BUILTIN_VERSIONS.canvas`）。发布 `0.01` 时 `0.01 ≡ 0.1.0`，
  所以 `check` 返回 `updateAvailable:false`（不新于内置）；这不影响手动 `install { version: "0.01", confirm: true }`。
  要让应用自动提示，请发 `0.02` 及以后（`0.02 > 0.1.0`），或把内置版本降到 `0.01` 以下（应用侧改动）。
- 源可显式切换（持久化到 `<userData>/dxos/apps/canvas/source.json`）：
  ```
  marketUpdate.command({ command: "market/update/check" })                                  // 默认 ModelScope
  marketUpdate.command({ command: "market/update/source/set", payload: { kind: "github-releases" } })
  marketUpdate.command({ command: "market/update/check" })                                  // 切到 GitHub Release 验证
  ```
  GitHub 源资产 URL 形如 `https://github.com/invaders-2/OpenArc-OS/releases/download/canvas-v<version>/canvas-<version>.zip`。

### 4.5 换密钥的流程

1. `node scripts/oa-update-keygen.mjs --force`：生成新私钥（`.keys/update-signing.key`，0600），并**覆盖**
   `resources/app-update-keys.json` 的 `canvas` 公钥。
2. 把新的 `resources/app-update-keys.json` **随应用发布**（内置公钥必须与新私钥成对）。
3. 把新私钥的完整 PEM 更新到 GitHub Secret `OA_UPDATE_SIGNING_KEY`。
4. 重新发一版（打新 tag / 手动触发）；工作流第 3 步 `--check-key` 会拦住“私钥没换”的错配。
5. 旧私钥签的包在新客户端上会验签失败（这是**故意**的：更新源与客户端公钥必须成对发布）；
   已装到用户机器上的旧客户端要先升级到带新公钥的版本，才能验证新私钥签的包。

### 4.6 手工兜底（工作流不可用时）

```bash
node scripts/oa-canvas-package.mjs --version 0.01 --source dist/novai-canvas
# → dist-updates/canvas-0.01.zip + dist-updates/updates/canvas/{canvas-0.01.zip,latest.json}
# GitHub：Draft a new release，Tag 用 canvas-v0.01，上传 canvas-0.01.zip（不要改名），Publish
# ModelScope：把 dist-updates/updates/ 推到仓库根（或 MODELSCOPE_TOKEN=*** node scripts/oa-modelscope-sync.mjs）
```

## 5. 命令契约

| 命令 | payload | 成功 value | 主要错误码 |
| --- | --- | --- | --- |
| `market/update/status` | `{}` | `{appId,current,builtinVersion,source:{kind,owner,repo},checkedAt,latest,updateAvailable,canRollback,rollbackTarget}` | `MARKET_UPDATE_UNAUTHENTICATED` |
| `market/update/check` | `{appId?}` | status 形状（含 `latest` / `updateAvailable`） | `MARKET_UPDATE_DOWNLOAD_FAILED`、`..._NOT_FOUND`、`..._INVALID_INPUT` |
| `market/update/install` | `{appId?,version?,confirm:true}` | `{installed:{version,digest},previous:{version}\|null}` | `..._SIGNATURE_INVALID`、`..._DIGEST_MISMATCH`、`..._SOURCE_DIGEST_MISMATCH`、`..._HOST_NOT_ALLOWED`、`..._INVALID_INPUT`、`..._NO_RELEASE`、`..._NOT_FOUND`、`..._CONFLICT`、`..._DOWNLOAD_FAILED` |
| `market/update/rollback` | `{appId?}` | `{rolledBackTo,previous:{version}\|null}`；`rolledBackTo` 是版本号或字面量 `"builtin"` | `..._DIGEST_MISMATCH`、`..._SIGNATURE_INVALID`、`..._INVALID_INPUT`、`..._UNAUTHENTICATED` |
| `market/update/sources` | `{}` | `{kind,owner,repo,defaultRepository,defaultSource,apiUrl,allowedHosts,channel,configurableFields,manifestPath,selected,sources:[{kind,label,defaultRepository,allowedHosts,configurableFields,manifestPath}]}` | `MARKET_UPDATE_UNAUTHENTICATED` |
| `market/update/source/set` | `{kind,owner?,repo?}` | 同 `sources` 的成功 value（当前选择已更新并持久化） | `..._INVALID_INPUT`（未知 kind / 非法 owner/repo / 任意 URL）、`..._UNAUTHENTICATED` |

- `kind` 必须在注册表内；`owner/repo` 只允许 `^[A-Za-z0-9._-]+$`（内部另按更严格的仓库段规则校验长度与首尾）。
- `sources` 顶层 `allowedHosts` 是**全部源主机的并集**（向后兼容字段）；当前源实际使用的主机在
  `selected` 对应条目的 `sources[].allowedHosts`，下载时按该源逐跳校验。
- 统一失败形状：`{ ok:false, error:"MARKET_UPDATE_*", detail }`；未知异常折叠 `DXOS_ERR_INTERNAL`。
- 全部命令都要求已认证会话（`sessionRef` 由主进程注入）；`install` 必须 `confirm:true`，
  **不会后台静默安装**。

### 5.1 回滚 / 回退到内置版本（三分支）

`market/update/rollback` 不再只认「上一版已安装版本」，按当前状态走三条分支，**三条都返回 `ok:true`**：

| 分支 | 触发条件 | 行为 | 返回 |
| --- | --- | --- | --- |
| ① 回上一版（既有语义，优先） | `history.json` 里有可用的上一版已安装目录 | 整包重新验签 + 验摘要后原子切回该版本 | `{rolledBackTo:"<版本号>",previous:{version:"<原版本>"}}` |
| ② 幂等 | 当前已经是内置版本（从没装过 / 已经回退过） | 不写盘、不报错 | `{rolledBackTo:"builtin",previous:null}` |
| ③ 回退到内置版本 | 装过版本但没有可用的上一版（只装过一个版本 / 上一版目录缺失 / 指针被改坏） | 把 `current.json` 原子替换成内置标记 | `{rolledBackTo:"builtin",previous:{version:"<原版本>"}}` |

- **`status.rollbackTarget`** 是回滚入口真正的去向，渲染层据此决定按钮文案与能否点击：
  `{kind:"installed",version}` = 回上一版；`{kind:"builtin",version:"0.1.0"}` = 回退到内置版本；
  `null` = 当前就是内置版本，没有可回退的东西。
  `canRollback` 语义**不变**（只表示「有上一版已安装版本可回滚」）；回退到内置版本不看它。
- **内置标记**：分支 ③ 把 `current.json` 写成
  `{mode:"builtin",version:null,builtinVersion:"0.1.0",rolledBackFrom:"0.01",clearedAt}`，
  只换这一个文件（临时文件 + rename 原子替换）；**版本目录与 `history.json` 全部保留**，
  随时可以重新 `install` 同一版本切回去，已下载的包不丢。
- **解析器回退**：`openarc-canvas://` 读到内置标记即按 `pointer-cleared` 走 3.4 的回退矩阵
  （`dist/novai-canvas` → `public/novai-canvas`），响应头如实带
  `x-openarc-canvas-source=dist|public`（不再是 `installed`）、`x-openarc-canvas-fallback=pointer-cleared`，
  且不再带已安装版本号；画布两页照常可用，不白屏、不 500。
- **审计**：成功 / 失败都写 `<appId>.update.rollback`；成功时 `oldPermissions` = `[{kind:"installed",version:<原版本>}]`
  （本来就内置时为 `null`）、`newPermissions` = `[{kind:"builtin",version:"0.1.0"}]`，
  `resourceRef` = `<appId>@builtin`。分支 ① 的 `newPermissions` 是 `[{kind:"installed",version:<上一版>}]`。
- `MARKET_UPDATE_ROLLBACK_UNAVAILABLE` 作为**保留码**仍在冻结错误清单里（不破坏既有文案表），
  但回滚已不再返回它。

## 6. 换密钥 = 换这个文件

`resources/app-update-keys.json`：

```json
{ "canvas": "<Ed25519 公钥 base64>" }
```

换密钥的完整步骤（本机 keygen → 换 `resources/app-update-keys.json` → 更新 GitHub Secret → 重发）见 **4.5**。
要点：私钥只进 `.keys/`（本机）与 GitHub Secret `OA_UPDATE_SIGNING_KEY`（云端），**绝不入库**；
私钥丢失或泄露就只能换密钥重新发布，旧客户端无法验证新私钥签的包。

## 7. 本轮测试

`node --test tests/dxos-market-update.test.mjs`（全离线，注入假 GitHub API / 假 ModelScope API 与假资产）。
覆盖：无 Release 如实回「无可用更新」、版本比较与通道选择、篡改 manifest 验签失败、
篡改 index.js 摘要失败、缺 manifest.sig 拒绝、非白名单主机拒绝、zip 目录穿越拒绝、
安装后指针/整包摘要正确且可回滚、未认证/未 trusted 边界、审计写入；
以及 ModelScope：清单解析与 master 发现、清单缺失如实回无更新、清单格式错、
tags 路径、交叉摘要不一致拒装、CDN 重定向白名单与越界拒绝、源切换持久化与非法 kind/owner/repo 拒绝；
以及源默认值与优先级：默认源为 ModelScope（`defaultSource` / `selected` / `status.source` 一致）、
显式切到 `github-releases` 后持久化且不被新默认覆盖、旧 `source.json` 存在时始终优先。

### Stage 2 追加测试

```bash
node --test tests/dxos-market-update.test.mjs tests/d5-02-canvas-*.test.mjs tests/dxos-canvas-*.test.mjs
```

- `tests/d5-02-canvas-static-web.test.mjs`：static-web manifest 校验 / 已安装优先 / 回退矩阵 / 目录穿越与 MIME 边界。
- `tests/dxos-canvas-online-update.test.mjs`：真实打包脚本产物 → `market/update/install`（离线 fixture 源）→ 协议优先加载；
  `current.json` 改坏自动回退；应用内 `rollback`；老 js-module 兼容回归；占位包拒装。
- `tests/dxos-market-rollback-builtin.test.mjs`：回滚三分支（回上一版 / 幂等 / 回退到内置版本）、
  `current.json` 内置标记、解析器 `pointer-cleared`、审计 `oldPermissions`/`newPermissions`、回退后可再装回。

### V0.01 云端发版链路新增测试

```bash
node --test tests/dxos-market-update.test.mjs tests/dxos-canvas-online-update.test.mjs
```

- 版本规范化：`0.01` / `1.2` / `1.02.3` 的解析与比较（`0.01 ≡ 0.1.0`、`0.02 > 0.01`），`canvas-0.01.zip` 资产名可解析。
- 打包自检：`--version 0.01` 产出 `canvas-0.01.zip` + `latest.json`；`--check-key` 指纹不配对即失败；`--verify` 拒绝被篡改的包。
- 工作流静态断言：`.github/workflows/release-canvas.yml` YAML 可解析；触发与步骤引用的脚本都存在；
  Secret 名与本文一致；文件里没有任何私钥明文。

本机一条龙复现（同时写出 `artifacts/dxos-release-v001/report.json`）：

```bash
node experiments/dxos-release-v001/run-all.mjs
```

真机验收（真实 `electron .` + 隔离 userData + 唯一 CDP 端口）：

```bash
npm run build && node tests/dxos-canvas-update-e2e.mjs
# → artifacts/canvas-online-update/report.json + shots/*.png
```

覆盖：① 无安装包走内置；② 真实 static-web 包安装后画布加载 `apps/canvas/<version>`（协议头 + 包内 marker + 主进程根目录日志）；
④ 应用内 rollback 回到上一版；③ `current.json` 改坏自动回退内置且不白屏。

回退到内置版本的真机 + 真联网验收（真实 `electron .` + 隔离 userData + 真实 ModelScope 源）：

```bash
node experiments/dxos-update-rollback-builtin/run.mjs
# → artifacts/dxos-update-rollback-builtin/report.json + shots/*.png
```

覆盖：装 0.01 后回退到内置 0.1.0（`rolledBackTo:"builtin"`、`current.json` 内置标记、
画布改由 `dist` 服务且 `fallback=pointer-cleared`）、重复回退幂等、版本目录保留后可再装回、审计留痕。
