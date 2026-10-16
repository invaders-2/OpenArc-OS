# DXOS-CANVAS-REVENDOR-NEXT · RUNBOOK

> 用户说「好了」（本地源码改完）之后，**要跑的那一条命令** + 前置检查 + 预期产物 + 回退。
> 命令本身仍是**同一个 vendor 入口**；本包新增的 `OA_NOVAI_SRC` 会走「本地源取证」，***不会*** 要求 HEAD 等于 `SOURCE_COMMIT`。

---

## 0. 先确认没有第二个会话在写 bundle

并发会话正在改 `public/novai-canvas/**` 和 `experiments/d5-02/vendor-novai-app.mjs`。**跑 vendor 之前先确认他们都停了**，否则：
1. 他们的手改会被 vendor 覆盖（`canvas-list.html`、`smart-canvas.js` 等由脚本重新生成）；
2. 他们若此时整写 vendor 脚本，本包新增的 `OA_NOVAI_SRC` / `--dry-run` 会丢失。

检查：
```bash
git status --porcelain public/novai-canvas experiments/d5-02/vendor-novai-app.mjs | head
node --check experiments/d5-02/vendor-novai-app.mjs && echo VENDOR_SYNTAX_OK
grep -c "OA_NOVAI_SRC" experiments/d5-02/vendor-novai-app.mjs   # 应当 >= 1
```

---

## 1. 前置检查（5 条，任一失败先停）

```bash
SRC=/Users/wepingli/Desktop/NOVAI-Infinite-Canvas-main

# 1) 源目录结构：static/ 直接在根，或在唯一子目录里（本机是 NOVAI-v16/static）
ls -d "$SRC/static" "$SRC"/*/static 2>/dev/null

# 2) 抓一份样本身份（HEAD + 是否脏），记进交付记录
git -C "$SRC/NOVAI-v16" rev-parse HEAD
git -C "$SRC/NOVAI-v16" status --porcelain | wc -l

# 3) 干跑：必须 exit 0、MISS 数可解释、不落盘
OA_NOVAI_SRC="$SRC" node experiments/d5-02/vendor-novai-app.mjs --dry-run | tee /tmp/oa-revendor-dry.txt
grep -E "来源标识|工作区|内容指纹|与当前|锚点命中|\[MISS\]" /tmp/oa-revendor-dry.txt

# 4) 锚点探针：66 条 MUST 全中（exit 0）；ABSENT 里若有「意外出现」要复核
OA_NOVAI_SRC="$SRC" node experiments/dxos-canvas-revendor-next/anchor-probe.mjs

# 5) 跑完确认干跑真的没落盘
git status --porcelain public/novai-canvas   # 与跑之前逐字节一致
```

**判定口径**：
- 干跑 `[MISS]`：必须逐条解释。已知 1 条（`apiImageSize` 上游已改）需要下一批先重新推导/删除该补丁；其余为 0 才能进第 2 步。
- `anchor-probe` 若出现「ABSENT 变存在」或「MUST 有 MISS」，说明上游又动了锚点，先更新 PORT-PLAN 再 vendor。

---

## 2. 那一条命令（真跑）

```bash
OA_NOVAI_SRC=/Users/wepingli/Desktop/NOVAI-Infinite-Canvas-main node experiments/d5-02/vendor-novai-app.mjs
```

**注意**（本批已确认的缺口，跑之前决定）：
1. 上一条命令会把「本地源 + 当前脚本的补丁集」重新写入 `public/novai-canvas/static/**`。脚本现在**仍保留** `canvas.html/canvas.js/canvas.css`（`PAGE_WHITELIST` 未收窄）——**「删传统画布 + 入口全改向 + 智能画布守卫/只读闸」是下一批的脚本改动**，不是这一条命令自动完成的。
2. 因为 `apiImageSize` 补丁 MISS，**真跑会直接报错退出**（干跑才容忍 MISS）。所以第 2 步要么先修该补丁，要么先把 `CANVAS_JS_PATCHES` 里那条移除/重推。
3. 本地源是 git 且脏：vendor 脚本会照常落盘，但 `vendor-manifest.json` 的 `sourceProvenance.dirty=true`、`matchesPin=false`；来源标识=HEAD `22feb298…` 或你重取的新值。
4. 脚本会在 bundle 根 `SOURCE.md` 有 `<!-- OA-SOURCE-PROVENANCE:BEGIN -->` 标记时就地更新来源块；没有标记就只写 `experiments/dxos-canvas-revendor-next/SOURCE.provenance.md` 并打印 warning（不会覆盖 SOURCE.md）。**要在 SOURCE.md 里保留来源块，先在那文件里放一对 BEGIN/END 标记**（模板见 `SOURCE.md.template`）。

---

## 3. 预期产物

| 产物 | 位置 | 期望 |
| --- | --- | --- |
| bundle static/ | `public/novai-canvas/static/**` | 保留集逐文件重写；补丁命中处按脚本改动 |
| vendor 清单 | `experiments/d5-02/vendor/vendor-manifest.json` | 新增 `sourceProvenance{type,identity,capturedAt,git,dirty,matchesPin,contentFingerprint}`；`sourceCommit=git HEAD`；`source=resolved srcRoot` |
| 来源块 | `experiments/dxos-canvas-revendor-next/SOURCE.provenance.md` | 每次重跑覆盖；若 `SOURCE.md` 有标记则同时就地更新 |
| 控制台 | stdout | `vendored X/Y files …`；本地源额外一行 `source provenance: {...}`；最后是完整 manifest |
| 干跑对照（可选） | `artifacts/dxos-canvas-revendor-next/` | 真跑后再跑一次 `--dry-run`，与当前 bundle 应当是 `0 新增/0 删除/0 内容变化/全相同`（脚本产物自洽） |

**落盘后自检**：
```bash
node experiments/dxos-canvas-prune/prune-public.mjs --check          # 源 63 / 保留 63 / 删除 0（本批未收窄白名单时）
test -f public/novai-canvas/openarc-bridge.js && test -f public/novai-canvas/openarc-adapter.js
test ! -f public/novai-canvas/index.html && test ! -f public/novai-canvas/openarc-shell.js && echo ROOT_OK
OA_NOVAI_SRC=/Users/wepingli/Desktop/NOVAI-Infinite-Canvas-main node experiments/d5-02/vendor-novai-app.mjs --dry-run | grep "与当前"
```

---

## 4. 回退办法

vendor 只写 `public/novai-canvas/static/**` + `vendor-manifest.json` + 生成件 `SOURCE.provenance.md`（以及有标记时的 SOURCE.md 来源块）；不碰 `electron/**`、`src/**`、`src-vue/**`、`tests/**`、`dist/**`。回退有两条路：

**A. 用 git 回退（推荐，前提是本批改动尚未提交）**
```bash
git restore --source=HEAD -- public/novai-canvas experiments/d5-02/vendor/vendor-manifest.json
# 注意：这会连并发会话未提交的手改一起丢掉 —— 只在确认要整体回退时用
```

**B. 用备份整目录回退（不依赖 git 历史）**
```bash
# 上一次升级前的整包备份（60 文件 / 10,688,283 B；逐文件 sha256 见 backup-profile.json）
ls artifacts/dxos-canvas-revendor/backup/novai-canvas/
rm -rf public/novai-canvas/static
cp -R artifacts/dxos-canvas-revendor/backup/novai-canvas/static public/novai-canvas/static
```

**C. 只想撤销 vendor 脚本的新增能力**：本包对脚本的改动是一组定点 edit，隔离在
`artifacts/dxos-canvas-revendor-next/vendor-script-my-diff.patch`（10 个 hunk）。用 `git checkout -- experiments/d5-02/vendor-novai-app.mjs` 会**同时**丢掉并发会话的改动，不要这样做；要撤就按 patch 反向 apply 到当前版本。

---

## 5. 跑完之后

1. 把 `vendor-manifest.json` 的 `sourceProvenance`（类型/标识/时间/脏）和 `SOURCE.provenance.md` 一起登记进交付记录。
2. 若本地源码还在改，**重跑第 1 步**取新的 HEAD/指纹；`PORT-PLAN.md` 的行号要重新对齐（跑 `anchor-probe.mjs`）。
3. 下一批（删传统画布 + 守卫/适配器移植 + 只读闸 + 门禁重定向）按 `PORT-PLAN.md` 执行；其中 `apiImageSize` 补丁失配与 `tests/dxos-canvas-size-policy.test.mjs` 的顶层读取是两个必须先处理的硬阻塞。
