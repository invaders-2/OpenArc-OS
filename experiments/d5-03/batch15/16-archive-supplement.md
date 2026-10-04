# D5-03 第十六批 · batch15 证据归档补齐 — 归档补充说明

- 文档路径：`experiments/d5-03/batch15/16-archive-supplement.md`
- 父提交：`8b8e8ad`（分支 `integration/ui-core`）
- 时间口径：**本批归档执行为 `2026-10-04`**；**被归档的 38 个产物产生于 `2026-10-01` 21:14–21:17**（batch15 两轮真机运行）。下文中出现的 `2026-10-01` 一律指**产物产生时间**，`2026-10-04` 指**本次归档执行日**。
- 系列消歧：本批「第十六批」属 **D5-03** 线（父 `8b8e8ad`），与 `PROGRESS.md` 中 **D5-02 画布**线的「第十六批」（宿主 sandbox 补 `allow-modals`）是**不同系列**。
- 本文件性质：**新增说明**，**不改写**任何既有报告（`D5-03-BATCH15-REPORT.md`、`D5-03-BATCH15-E1-REPORT.md`、`verify/**`、`10-/11-*.txt`、`00-prerun-facts.txt` 一律未动）

---

## 1. 本批性质：仅证据归档补齐

本批**只做一件事**：把 batch15 此前因忽略规则未入提交的 **38 个产物文件**，按**原路径**强制纳入 Git 暂存区（`git add -f`）。

明确声明本批**没有**做什么：

- **没有**任何新的真机运行 —— **未**运行 `test:d5-01-visibility`，**未**运行 `npm test`，**未**运行任何前台/真机脚本。
- **没有**任何代码改动 —— `src/`、`electron/`、`tests/`、`experiments/d5-01/**` 一律未动。
- **没有**修改任何原始产物 —— 38 个文件**未被写入、未被覆盖、未被重命名、未被重新生成**，也**没有"补造"**任何文件。
- **没有**修改任何忽略规则 —— `.gitignore` 与所有全局/仓库忽略规则**逐字节未变**（见 §4）。
- **没有** `commit` / `push` / `merge` / `rebase` / `--amend` —— 提交由上级统一做，本批只暂存。

本批**唯一**的写操作是新增 3 个文本文件（`16-archive-manifest.tsv`、`16-archive-supplement.md`、`16-archive-precheck.txt`）与在 `PROGRESS.md` **末尾追加**一节；另有 `git add -f` 的索引变更。

## 2. 被测基线与运行验收结论：沿用 batch15，本批**未**重跑

| 项 | 值 | 来源 |
| --- | --- | --- |
| **被测代码树** | **`2d50986`**（`docs(d5-01): 第十四批结果与证据定稿（D5-01 真机门禁安装段修复）`） | `D5-03-BATCH15-REPORT.md` 第 3 行 / 第 52 行 |
| run1（纯运行，无预载） | **25 PASS / 0 FAIL / 25 total / 1 NOT VERIFIED，EXIT=0** | `10-visibility-run1.txt` |
| run2（同一门禁 + 只读证据补齐预载） | **25 PASS / 0 FAIL / 25 total / 1 NOT VERIFIED，EXIT=0** | `11-visibility-run2.txt` |
| `V9` / `V11` / `V12b` | 由「未验收」改为**已验收** | `D5-03-BATCH15-REPORT.md` §7 判定段 |

- **被测基线仍是 `2d50986`**，本批**不改动**该事实。
- **运行验收结论完全沿用 batch15**：两轮 `25 PASS / 0 FAIL / 25 total / 1 NOT VERIFIED`、`EXIT=0`，`V9` / `V11` / `V12b` 已验收。
- **本批明确不主张运行过上述命令** —— 是**沿用**既有结论，而非本批实测。本批无代码改动，故这些结论的代表性不受本批影响。

## 3. 为什么这 38 个文件此前未入提交

- 仓库根 `.gitignore` 第 **3** 行规则为 `artifacts/`，它是**无路径前缀的目录规则**，会匹配任意层级的 `artifacts/` 目录，因此 `experiments/d5-03/batch15/artifacts/**` **整体被忽略**。
- 已用 `git check-ignore -v` 逐条取证（原文见 `16-archive-precheck.txt` §1.2），4 个代表路径的输出均为：
  `.gitignore:3:artifacts/	<路径>`
  → 证明它们**此前被 `.gitignore:3` 的 `artifacts/` 规则忽略**，**不是**因为别的原因（如路径写错、从未 `add`、`assume-unchanged` 等）而未跟踪。
- 因此在基线 `8b8e8ad` 中，`experiments/d5-03/batch15/` 下**已跟踪文件只有 15 个**（报告、`10-/11-*.txt`、`00-prerun-facts.txt`、`verify/**`），其中 **`artifacts/` 下已跟踪文件数 = 0**（原文见 `16-archive-precheck.txt` §1.2b）。
- 后果：batch15 的**核心证据**（两轮产物 JSON + 两轮各 18 张截图，共 38 个文件、约 12 MB）在 `8b8e8ad` 里**完全不进版本库**，导出提交无法回溯原始帧与原始计数。

## 4. 本批做了什么：仅对这 38 个文件 `git add -f`，未改忽略规则

对本批**唯一**的 38 个文件执行 `git add -f`，按**原路径**纳入（不重命名、不搬迁、不改内容）：

| 组 | 路径 | 数量 |
| --- | --- | --- |
| run1 产物 JSON | `experiments/d5-03/batch15/artifacts/run1-visibility-e2e.json` | 1 |
| run1 截图 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/*.png` | 18 |
| run2 产物 JSON | `experiments/d5-03/batch15/artifacts/run2-visibility-e2e.json` | 1 |
| run2 截图 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/*.png` | 18 |
| **合计** | | **38** |

- 逐项存在性已由脚本枚举断言：**38/38 路径均存在且均为普通文件**，并打印了每个路径的字节数；**文件计数 = 38**（原文见 `16-archive-precheck.txt` §1.3）。
- 两轮帧**文件名完全相同**，共 **18 个名字**（`01-paint-before.png` … `12-zoom.png`），已用 `diff` 复核两轮文件名集合一致。
- **未修改任何忽略规则**：`.gitignore` 本批前后 sha256 **一致**，均为
  `4c0fdfe2d97b05490f628f84cbb450e88deb0f17233a326eeab17caddc614cfc`
  （取证时记录于 `16-archive-precheck.txt` §1.5；暂存自检时再次核对一致）。本批采用 `-f` 强制纳入，**而非**放宽/删除忽略规则。
- 本批**禁止**使用 `git add -A` / `git add .` / 目录级 `git add`：只按显式路径清单 `-f` 暂存这 38 个文件，另加 3 个新增文本文件（`16-archive-manifest.tsv` / `16-archive-supplement.md` / `16-archive-precheck.txt`）与修改 `PROGRESS.md`，合计 **42** 项（38 + 3 + 1）。（更正：本节在归档提交 `aa1512d` 中误写为 41 项；实数 38 + 3 + 1 = 42，已在后续提交更正。）

## 5. 逐字节不变：清单是唯一见证

- 38 个文件在本批中**未被写入、未被覆盖、未被重命名**；本批**没有**重新生成任何产物。
- **`16-archive-manifest.tsv` 是本批唯一的逐字节见证**：它对每个文件记录 `path` / `bytes` / `sha256`（小写十六进制 64 位），并附合计行。
- 清单自检（原文见 `16-archive-precheck.txt` §2.3）：重新读取清单后**逐行用 `sha256` / `stat` 复算**，与清单**逐字段一致**；数据行数 = **38**（断言通过）；无 CR 字节；末尾单换行；路径按**字典序**升序。
- 清单里的合计：**`# files=38 total_bytes=12733808`**（约 12 MB，与预期量级一致）。

清单格式：

```
path<TAB>bytes<TAB>sha256
<38 行数据，按路径字典序>
# files=38 total_bytes=12733808
```

## 6. 两份 JSON 的计数（归档前复核）

用 `python3` 各读一次（原文见 `16-archive-precheck.txt` §1.4）：

| 文件 | `counts` | `len(checks)` | `len(notVerified)` |
| --- | --- | --- | --- |
| `artifacts/run1-visibility-e2e.json` | `{"pass":25,"fail":0,"total":25}` | 25 | 1 |
| `artifacts/run2-visibility-e2e.json` | `{"pass":25,"fail":0,"total":25}` | 25 | 1 |

两者**均通过断言** `counts == {"pass":25,"fail":0,"total":25}`，与 batch15 报告的两轮结论一致。

## 7. 如何复核本批归档

从**归档提交**导出后逐文件复算 `sha256`，与 `16-archive-manifest.tsv` 比对即可。单文件示例：

```bash
# 方式一：git show（直接取 blob 内容）
git show <commit>:experiments/d5-03/batch15/artifacts/run1-visibility-e2e.json | shasum -a 256

# 方式二：git archive（按原路径导出）
git archive <commit> experiments/d5-03/batch15/artifacts/run1-visibility-frames/01-paint-before.png | tar -xO | shasum -a 256
```

批量复算（读清单逐行比对，应**零差异**）：

```bash
cd "$(git rev-parse --show-toplevel)"
git show <commit>:experiments/d5-03/batch15/16-archive-manifest.tsv \
  | awk -F'\t' 'NR>1 && $1 !~ /^#/ {print $1"\t"$3}' \
  | while IFS=$'\t' read -r p want; do
      got=$(git show "<commit>:$p" | shasum -a 256 | awk '{print $1}')
      [ "$got" = "$want" ] && echo "OK   $p" || echo "DIFF $p ($want != $got)"
    done
```

- 复核要点：`<commit>` 请填**本次归档提交**（父提交为 `8b8e8ad`、主题为 `docs(d5-01): 第十六批 batch15 证据归档补齐…` 的那一次提交）。
- 额外交互式自检：`git ls-tree -r --name-only <commit> experiments/d5-03/batch15/artifacts/ | wc -l` 应为 **38**。
- 本批的原始取证输出全部保留在 `experiments/d5-03/batch15/16-archive-precheck.txt`（第 1、2 步原始输出，含文件计数、忽略来源、JSON 计数、清单自检）。

## 8. 遗留（如实登记，均**不在**本批范围）

1. **`experiments/d5-01/visibility-e2e.mjs:44` 的 2400 字符截断仍在** —— `record()` 里 `actual: String(actual ?? "").slice(0, 2400)`，使门禁**自身产物**无法完整回溯 `V11` 最后一落点（须依赖只读旁路文件 `verify/captured/payload-001-2955.json`）。**本批不改，另批修**（提高上限或按落点分段截断）。相关证据强度限制（`V11` 未截断原始值仅 run2 有、run1 落点 7 无原始值、payload 第 2400–2955 字符无外部绑定）沿用 batch15 登记，本批不改变。
2. 其余 batch15 登记的上游遗留（9 个陈旧 `data-app-id` 探针、`browser-e2e.mjs:487` 的 `waitView("/cookie")` 脆弱点、跨组织真机 2 条等）**一律未动**，仍按 batch15 遗留清单执行。
3. **`D5-03` 整体仍 = `PARTIAL`** —— 本批只补齐了 batch15 的**证据归档**，未闭环任何新产品/测试范围事项，整体判定**不因本批而改变**。
