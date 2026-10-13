# Dx-P0 · 基线与契约冻结记录

> 采样时间：2026-10-08 14:06–14:20（本机时区）
> 本文件是计划 §7 P0 的「基线 commit 记录」，同时承担 R9 的**勘误**职责。

## 1. 工作基线（冻结）

| 项 | 值 |
|---|---|
| 仓库 | `/Users/wepingli/Desktop/OpenArc OS`（唯一项目根，AGENTS.md 约定） |
| 主 worktree 分支 / HEAD | `integration/ui-core` @ `128e21da472ecc2defa83ae2982303407aad5fe6` |
| **本轮专用 worktree** | `/Users/wepingli/.openarc-worktrees/dxos-port-r1` |
| 本轮分支 | `dxos-port/r1`（自 `128e21d` 新建，**基于 integration/ui-core 而非 main**） |
| 创建命令 | `git worktree add -b dxos-port/r1 <path> 128e21da…` |
| node_modules | 符号链接到 `/Users/wepingli/Desktop/OpenArc OS/node_modules`（禁止 npm install） |
| `main` 分支 | **未改动**（`main` = `823242a`，是 integration/ui-core 的祖先；提交/push 属本次约束中的"对外发布或提交"，未执行） |
| 既有成果 | D1–D5 全部保留，不回退、不重做（本轮分支直接继承 128e21d） |

每阶段开始前核对 HEAD 的命令：

```
git -C /Users/wepingli/.openarc-worktrees/dxos-port-r1 log -1 --format='%H %d %s'
```

## 2. 环境（实测）

| 项 | 值 |
|---|---|
| 系统 | macOS 26.6.2 / arm64 |
| Node | v22.22.3（满足计划 §2.1 的 ≥ 22.5） |
| npm | 10.9.8 |
| FFmpeg | 7.1.1（/opt/homebrew/bin/ffmpeg） |
| Python | 3.12.12 |
| ComfyUI / onnxruntime | **缺失**（见 Dx-P0-DEPENDENCIES.md） |

## 3. 基线验证结果（改动前证据，R15）

命令与真实结果：

```
$ cd /Users/wepingli/.openarc-worktrees/dxos-port-r1 && npm run build
> tsc --noEmit && vite build
✓ 1638 modules transformed.
dist/index.html 0.84 kB │ dist/assets/main-qXEiIhXD.js 373.56 kB
✓ built in 1.25s
# exit 0

$ npm test        # node --test tests/*.test.mjs
# tests 1412 / pass 1411 / fail 1        （第一次运行）
# tests 1412 / pass 1410 / fail 2        （第二次运行，含日志留档 /tmp/oa-baseline-test.log）
```

失败的 2 项及定性（**均为基线既有，与后续改动无关**）：

| # | 测试 | 定性 | 证据 |
|---|---|---|---|
| 337 | `tests/d5-03-dsh-runtime-pin.test.mjs:131`「ACP SDK 只认项目内那一份」 | **worktree 布局导致**：该测试要求 SDK 解析路径在项目内，而本 worktree 的 `node_modules` 是符号链接，实测解析到 `/Users/wepingli/Desktop/OpenArc OS/node_modules/@agentclientprotocol/sdk/dist/acp.js`。属环境性失败，非产品回归 | 断言原文 `SDK 必须来自项目内：/Users/wepingli/Desktop/OpenArc OS/node_modules/…`，expected true / actual false |
| 602 | `tests/harness-acp-cancel.test.mjs:11`「cancel：Harness 停止、Provider 连接关闭、0 retry」 | **全量并发下的 flaky**：单独运行 3/3 全过（expected 1 / actual 0 仅在整套跑时出现） | 单独 `node --test tests/harness-acp-cancel.test.mjs` ×3 → `# tests 3 / # pass 3 / # fail 0` |

> 结论：基线判定为「**build 通过；测试 1410–1411/1412 通过，2 项为环境性/flaky 既有失败**」。
> 后续每个阶段都必须与这 2 项对齐口径：**只允许不新增失败项**；这 2 项不得被当成新引入的回归。

## 4. 勘误表（计划文档数字 vs 实测，R9）

| 项 | 计划原文 | 实测 | 判定 |
|---|---|---|---|
| DX OS server 顶层 `.ts` | 76 个 | **110 个** | 不符；以实测为准 |
| DX OS server 子目录 | 5 个 | **13 个**（agent-kernel/ agent-runtime/ ai-tasks/ baselines/ bundled-comfy-workflows/ bundled-skill-packages/ claudecode/ cli-runtime/ protocol-engine/ protocol-fixtures/ vendor/ video/ ziniao/） | 不符；以实测为准 |
| DX OS server 总行数 | 约 63,422 行 | 递归 `*.ts` 合计 **63,422** | **完全一致** → 同一份源码，分歧仅在计数口径 |
| DX OS `/api` 路由 | 560–571 条 | `app.get/post/put/patch/delete` 匹配 **553** 条；`/api/*` 前缀去重 **59** 个 | 口径不同，未复现原区间 |
| `protocol-engine/` | 12 文件 5263 行 | **15 个 `.ts`** | 不符；以实测为准 |
| `electron/*.cjs` | 93 文件 | **86 个 `.cjs`**（目录项 91，含 3 个 `.d.cts`） | 口径不同；以实测为准 |
| OpenArc 表数 | 65 张 | **64 张** | 不符；保留待核对（见 Dx-P0-TABLE-CONFLICT.md） |
| DX OS 表数 | 51 张 | **55 张**（4 个文件合计） | 口径不同（计划按 `ccsDb.ts` 单文件） |
| 现有 IPC 域 | 17 域 / 30 通道 / 5 事件 | preload 顶层键 **17**、handler 域 **13**、invoke 通道 **29**、下行事件 **5** | 事件数一致；域/通道为口径差异（见 Dx-P0-IPC-CONTRACT.md） |
| 测试文件数 | 219 个 `*.test.mjs` | **219** | 一致 |
| `SCHEMA_VERSION` | 21 | `electron/identity-store.cjs:68` = **21** | 一致 |
| CSP | `connect-src 'none'` | `index.html:8` 确为 `connect-src 'none'` | 一致 |
| `src/vite-env.d.ts` | 4 行 | **4 行** | 一致 |
| DX OS 源码路径 | `.dx-runtime/versions/runtime-0.5.1-baseline/DX OS.app/…/server/` | 存在，`app.asar` 亦在 | 一致 |
| `main` 与基线关系 | 计划未提 | `main`(823242a) 是 `integration/ui-core`(128e21d) 的**祖先**，落后 **451** 个提交 | 新增事实，记入基线 |

## 5. worktree 现状（实测）

```
/Users/wepingli/Desktop/OpenArc OS                               128e21d [integration/ui-core]
/Users/wepingli/.codex/worktrees/ui-design-alignment/OpenArc OS  e0a557e (detached HEAD)
/Users/wepingli/.openarc-worktrees/dxos-port-r1                  128e21d [dxos-port/r1]   ← 本轮
```

## 6. NOT VERIFIED

- 5 张同名表的字段级差异（未逐列比对）。
- DX OS 是否另有动态建表/视图（未穷尽）。
- 主 worktree 上直接跑 `npm test` 是否为 1412/1412：**未在主工作区执行**（避免污染用户工作区），故 #337 的「环境性」结论由断言内容与符号链接事实推出。
