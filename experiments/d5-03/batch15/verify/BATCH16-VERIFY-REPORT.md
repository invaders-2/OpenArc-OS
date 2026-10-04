# D5-03 第十六批 · batch15 证据归档补齐 — 独立验收报告

- 验收对象：提交 **`aa1512dda1dd4b0aa2875851f166518ebe404677`**（`aa1512d`）
- 父提交：**`8b8e8adb0b78d45accaa046eec3430e2b89d3705`**（`8b8e8ad`，单父）
- 仓库/分支：`/Users/wepingli/Desktop/OpenArc OS-integration` · `integration/ui-core`
- 验收方式：**只读**（未 commit / push / merge / rebase / amend；未改任何已提交文件、38 个产物、清单、补充说明、`PROGRESS.md`、`.gitignore`；未运行任何真机脚本 / `npm test` / `test:d5-01*`）
- 使用工具：`git` / `python3`（+ Pillow 12.2.0、numpy 2.4.6 用于只读解码与像素比对）/ `shasum` / `file`
- 本报告文件：本报告是本次验收**唯一新增**的文件，**未加入任何提交**（`git status` 中显示为未跟踪 `??`）
- 报告生成时间：2026-10-04 20:26:39 CST

---

## 0. 结论摘要

| 项 | 结果 |
| --- | --- |
| HEAD == `aa1512d`，父 == `8b8e8ad` | **成立** |
| 父提交未被 amend（`8b8e8ad` 哈希与主题未变） | **成立** |
| 提交形态 = 41 `A` + 1 `M`（`PROGRESS.md`），0 `D` / 0 `R` | **成立** |
| 41 个 `A` 中 38 个在 `batch15/artifacts/` 下 | **成立** |
| 提交树产物数 == 38，与清单路径集合相等 | **成立（差集为空）** |
| 38/38 逐文件 sha256 + 字节数复算一致 | **一致 38 / 不一致 0** |
| 合计字节 == 清单合计行 `# files=38 total_bytes=12733808` | **成立（实测 12733808）** |
| 38 条在父提交 `8b8e8ad` 上均不存在 | **成立（0 存在 / 38 不存在）** |
| 两份 JSON `counts == {"pass":25,"fail":0,"total":25}`、`checks==25`、`notVerified==1` | **成立** |
| 两份 JSON 非同一份复制 | **成立（sha256 不同；69 处叶子字段差异，全部为时间戳 / 窗口与 PID 标识 / 帧字节数）** |
| 36 张 PNG 全为有效 PNG（非零填充 / 非文本） | **成立** |
| 36 张 PNG distinct sha256 == 36（无重复图） | **成立** |
| 提交产物与工作树逐字节相同，工作树该目录仍 38 个文件 | **成立** |
| `.gitignore` 未变（两侧 sha256 == `4c0fdfe2…4cfc`） | **成立** |
| 旧报告 / 既有证据未被改 | **成立** |
| `PROGRESS.md` 纯追加（删除列 0，旧内容为逐字节前缀） | **成立（20 增 / 0 删）** |
| 未 push | **成立（无 upstream；远端匹配分支数 0）** |
| 发现 | **无阻断级 / 无中等级；2 条低级 + 4 条信息级（见 §7）** |

**独立判定：本批（batch15 证据归档补齐）= PASS。** `D5-03` 整体仍 = **PARTIAL**（本批只补齐证据归档，未闭环任何产品 / 测试范围事项）。

---

## 1. 第 1 步：卫生与提交形态

### 1.1 提交与父链

```
$ git rev-parse HEAD
aa1512dda1dd4b0aa2875851f166518ebe404677
$ git rev-parse aa1512d^
8b8e8adb0b78d45accaa046eec3430e2b89d3705
$ git log --oneline -3
aa1512d docs(d5-01): 第十六批 batch15 证据归档补齐（38 个产物按原路径入提交）
8b8e8ad docs(d5-01): 第十五批结果与证据定稿（D5-01 visibility 未验收项闭环）
2d50986 docs(d5-01): 第十四批结果与证据定稿（D5-01 真机门禁安装段修复）
```

HEAD == `aa1512d` ✓，父 == `8b8e8ad` ✓。

### 1.2 未 amend 的证据

1. `git rev-parse 8b8e8ad` = `8b8e8adb0b78d45accaa046eec3430e2b89d3705` —— 与任务给定值**逐字符一致**，说明父提交对象未被改写（一旦 amend，其哈希必变）。
2. `git log -1 --format=%s 8b8e8ad` = `docs(d5-01): 第十五批结果与证据定稿（D5-01 visibility 未验收项闭环）` —— 原提交主题未被改写。
3. `git rev-list --parents -1 aa1512d` 只输出 2 个字段（自身 + 唯一父 `8b8e8ad`） → **单父、非 merge**。
4. 反证链：若 `8b8e8ad` 曾被 amend，本批提交的 `parent` 指针必然指向**新**哈希；实测 parent 指针仍指向旧哈希，且旧哈希内容自洽（其自身 parent 为 `2d50986`）。
5. 无替换/嫁接：`git replace -l` 输出为空；`.git/shallow` 不存在（非浅克隆）。
6. `aa1512d` 的 author 与 committer 同人同时刻（`1791116271 +0800` = 2026-10-04 20:17:51 CST），无 amend 常见的 author/committer 时间分裂痕迹。

→ **结论：`8b8e8ad` 未被 amend，本批父链上不存在被替换的痕迹。**

### 1.3 提交形态分类统计

```
$ git show --name-status --format="" aa1512d
```

| 状态 | 条数 | 说明 |
| --- | --- | --- |
| `A` | **41** | 其中 **38** 在 `experiments/d5-03/batch15/artifacts/` 下；另 3 = `16-archive-manifest.tsv` / `16-archive-precheck.txt` / `16-archive-supplement.md` |
| `M` | **1** | `PROGRESS.md` |
| `D` | 0 | — |
| `R` | 0 | — |
| `C` | 0 | — |
| **合计** | **42** | 与"42 个文件"声明一致 |

→ 恰好 **41 `A` + 1 `M`**，38 条在 `artifacts/` 下 ✓。

### 1.4 工作树状态

```
$ git status --porcelain            # integration/ui-core
（空 —— 写本报告前为 0 行）
$ cd "/Users/wepingli/Desktop/OpenArc OS" && git status --porcelain | wc -l
17
$ cd "/Users/wepingli/Desktop/OpenArc OS" && git status --porcelain | md5
f53fad2f3a84d843ea45b66e93ded39e
```

→ 集成工作树干净（0 行）；主工作树 **17 行**、md5 **`f53fad2f3a84d843ea45b66e93ded39e`** ✓（与预期完全一致，验收期间主工作树未被改动）。

### 1.5 未 push

```
$ git branch -vv | grep '^*'
* integration/ui-core  aa1512d docs(d5-01): 第十六批 ...
$ git ls-remote --heads origin 2>/dev/null | grep -c integration/ui-core
0
```

→ `integration/ui-core` 行**无 `[origin/...]` upstream**；远端匹配该分支名的引用数 = **0** ⇒ **本批未 push** ✓。

---

## 2. 第 2 步：从提交导出并逐文件复算（核心）

所有复算均**从提交对象取内容**（`git cat-file blob aa1512d:<path>` / `git show aa1512d:<path>`），**未使用工作树文件当证据**（工作树比对另见 §3.5）。

### 2.1 提交树产物数与清单路径集合

```
$ git ls-tree -r --name-only aa1512d -- experiments/d5-03/batch15/artifacts/ | wc -l
38
```

- 提交树路径集合 vs 清单 38 条路径集合：`comm -23` 与 `comm -13` 双向差集**均为空**，`diff` 无输出 → **集合完全相等，恰好 38 条** ✓

### 2.2 38 行逐文件复算结果

（`bytes` 与 `sha256` 均为对 `aa1512d:<path>` blob 的实测值）

| # | path | bytes | sha256（从提交复算） | 与清单 |
| --- | --- | --- | --- | --- |
| 1 | `experiments/d5-03/batch15/artifacts/run1-visibility-e2e.json` | 31701 | `c38f731204bd189b0d8a76c1fbe2108b3eea92c805a3287dc802e7d52fd8cb03` | 一致 |
| 2 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/01-paint-before.png` | 398202 | `02caf99a48b0267522ba37f98cf7f71f5a8af5ca9545294a2dff1bfd07955a8c` | 一致 |
| 3 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/02-tab-switch.png` | 398415 | `2014b382a68f6f8b95bdf5c0852772070b10cf2bc33e92c8db314ae490e595ac` | 一致 |
| 4 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/03-addressbar-focus.png` | 396924 | `5bd74f586063da93da94f53fa7b70aea9812855e6d15f5062b5716ca6225606e` | 一致 |
| 5 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/04-page-click.png` | 403205 | `3b253211dbedeaf4c980eb7dcc9aed3e4ed63f872069a2b5b6b83b2e6e2eaf83` | 一致 |
| 6 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/05-panel-open.png` | 418369 | `78fe480b32a8f5b6290364297f2ba3a846e399d17cc616cb3caf070bc329f381` | 一致 |
| 7 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/06-panel-closed.png` | 402125 | `a5b97c41f2d86a2961ac1f13fd3d9a36318a9a9a5673070fe732c287337e9197` | 一致 |
| 8 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/07-after-resize.png` | 344791 | `23d2d83700a89161e1527f7841de2f50ec5f71180d5b28d5715b5675ad9fb243` | 一致 |
| 9 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/08-burst-0.png` | 346808 | `5fff66a3b50573742bd9e9acd2cd3f8b50efc28715ff91c65b52b26c7ea684dd` | 一致 |
| 10 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/08-burst-1.png` | 346954 | `2bd52c244b8c61745f6a841838c98153c46ae93b847a7c26a941dcdc80302d3e` | 一致 |
| 11 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/08-burst-2.png` | 347041 | `52f3bfe2eceafb7b3e69b295c57d0eaabc637a7b609b53c7569d3ca8b58506ec` | 一致 |
| 12 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/08-burst-3.png` | 346901 | `151cff50e181493a5a55fcc669645a09dd6971bd78341c97fdaef70847cf2b56` | 一致 |
| 13 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/09-edges-frame.png` | 344655 | `72a70a35a8d9bf06588798281487e0024ba3be2ad6094b5ae31bbeaa1bc77091` | 一致 |
| 14 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/09-edges.png` | 345634 | `bff4bc162574db601b6b42ea2628d46900cb2b70077588a482a3360da7549228` | 一致 |
| 15 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/10-maximize-before.png` | 345957 | `cc4ffbfa3ff55e8f0e6a21d190a450fb3eb0b940db58e1e4bfcabf3ced98bbc2` | 一致 |
| 16 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/10-maximized.png` | 227614 | `3dcf62b90be41e85ad657b73c67b174b6b53e415e79801308e5dbcfd250c64a4` | 一致 |
| 17 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/11-restore-before.png` | 228321 | `0c23f83755426071af8a1c738c79bb61dccc87608be12aa3226a5731f8693ace` | 一致 |
| 18 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/11-restored.png` | 346506 | `b31a4dbb02b325ee4781156b23af1066d1897a4808ea0d538e49f206a74c6d78` | 一致 |
| 19 | `experiments/d5-03/batch15/artifacts/run1-visibility-frames/12-zoom.png` | 346856 | `a0b94e3fe59cde42587261f4597695c31bfc0fe5e7aa40a14f16bc1772fd5684` | 一致 |
| 20 | `experiments/d5-03/batch15/artifacts/run2-visibility-e2e.json` | 31701 | `50fd9c0f548b3ccdce5b903fad5213551dd895dc3361cf1a3852de8db53becca` | 一致 |
| 21 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/01-paint-before.png` | 398115 | `178ce09c684219f3e2191c3710d76899c22bcb6deb8bf7d15c4b0234fc6355fe` | 一致 |
| 22 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/02-tab-switch.png` | 397944 | `e2d8d49ac883b573f62dc7aa3bec5dbeef588872f633f2b24ea6c1a8b87fa9aa` | 一致 |
| 23 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/03-addressbar-focus.png` | 397495 | `c12a6b2276237ed40d0b4e7bdc24b311f85653b0486c3fcd7365f0d73a70136d` | 一致 |
| 24 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/04-page-click.png` | 403944 | `8e8e4e4c6181b76f3d85d83547185689c9877868532fdc4ddb4c0c23baf78480` | 一致 |
| 25 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/05-panel-open.png` | 419373 | `92671bdab9c181a1b87e10ee4676d65ae68fd3c5971a25cdb7b0554565122096` | 一致 |
| 26 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/06-panel-closed.png` | 401007 | `c38cc56508df20befb48f1fe4c49c7cbcd2897c5940c1fdef35b241d83d4e9cb` | 一致 |
| 27 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/07-after-resize.png` | 344806 | `a9e3791a0f7630a446b946a3ef70472f6b37a10d4f304ae92cf63dc42583a3bd` | 一致 |
| 28 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/08-burst-0.png` | 346783 | `701b78edf2fccd552ce8f1188fa17d07c9e46b741a6abfff08bd27bf4b1f9145` | 一致 |
| 29 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/08-burst-1.png` | 346863 | `f3f54b121fdfabd7695fd4fb54123f414a46d4c1582eaa01c5afd3772b5342aa` | 一致 |
| 30 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/08-burst-2.png` | 346958 | `4f38056fdd3d624449e05da0f1debeee7caaa32afe75d5a4a7c08b8213021d83` | 一致 |
| 31 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/08-burst-3.png` | 347062 | `15bff6ea4dd38e5d0ca42b046a7308d8cbf642d6306829f4d5884c95ae910946` | 一致 |
| 32 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/09-edges-frame.png` | 344971 | `2fcd9c7ae926eaf8d9cc400203b5f4c74a40e0f7134eedf1be0e5fe4bfcaae40` | 一致 |
| 33 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/09-edges.png` | 345064 | `c1a04ff4d01a32937f3b7aef1b17237d22585b29642a76c6c61aa608afb9aae9` | 一致 |
| 34 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/10-maximize-before.png` | 345166 | `f7f43c65a10621ed356bf3858b6e66f2de5d9ae5ad0a3efdba006b9206b1b5ac` | 一致 |
| 35 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/10-maximized.png` | 227668 | `c46f67f4b739eccfdba33fee279291bb715cd449e3804df1ae04741d35191c84` | 一致 |
| 36 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/11-restore-before.png` | 228309 | `1657272506a85e99498d5335fc2c0450b797dc5d6ae45a4e62a265132389d86c` | 一致 |
| 37 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/11-restored.png` | 346748 | `5015cdfdcf04ce13af28fdcdeac27ea717bdf81e116204f94f235a44fffafad2` | 一致 |
| 38 | `experiments/d5-03/batch15/artifacts/run2-visibility-frames/12-zoom.png` | 346852 | `9478cecd0b7c6fe424b9a4f7dae8eec2f4dd94b7785c66c00db649ef2bd0616e` | 一致 |
| 合计 | 38 个文件 | **12733808** | — | **38/38 一致，0 不一致** |

**汇总：一致 38 / 不一致 0；实测合计字节 = 12733808，与清单合计行 `# files=38 total_bytes=12733808` 逐字符一致。**

### 2.3 新增性：38 条在父提交上均不存在

对 38 条逐条执行 `git cat-file -e 8b8e8ad:<path>`：**存在 0 条 / 不存在 38 条** ⇒ 38 个产物确为本次新增，父提交中不存在同名被覆盖对象 ✓

补充事实：`8b8e8ad` 中 `experiments/d5-03/batch15/` 下已跟踪文件 **15 个**，其中 `artifacts/` 下 **0 个** —— 与补充说明 §3 的陈述**完全一致**，即本批归档的是此前完全不进版本库的核心证据。

### 2.4 清单自身合法性

| 检查项 | 实测 | 结论 |
| --- | --- | --- |
| 表头 | `path\tbytes\tsha256` | 正确 |
| 数据行数 | 38 | 正确 |
| 合计行 | `# files=38 total_bytes=12733808` | 正确 |
| 总行数 | 40（表头 1 + 数据 38 + 合计 1） | 正确 |
| CR 字节（`grep -c $'\r'`、`file`） | 0；`file` 判定 `ASCII text` | 无 CR ✓ |
| 末尾换行 | 单换行 | 正确 |
| 路径字典序 | `LC_ALL=C sort -c` 通过 | 升序 ✓ |
| 字段格式 | 38×3 字段；`bytes` 全为十进制；`sha256` 全为 64 位小写十六进制 | 异常 0 行 ✓ |
| 路径唯一性 | 38 条互不重复 | ✓ |

### 2.5 补充说明记载的复算方法实测可用

直接执行补充说明 §7 给出的**批量复算命令**（`<commit>` 填 `aa1512d`）：**`OK` 38 行 / `DIFF` 0 行**；`git archive aa1512d <path> | tar -xO | shasum -a 256` 抽样 3 条（1 JSON + 2 PNG）**全部命中**；`git ls-tree -r --name-only aa1512d experiments/d5-03/batch15/artifacts/ | wc -l` = **38** ✓
→ 补充说明提供的**可复核路径真实可用**（不是纸面方法）。

---

## 3. 第 3 步：内容真实性（对抗性）

### 3.1 两份 JSON 从提交取出后解析

| 文件 | `counts` | `len(checks)` | `len(notVerified)` | 断言 |
| --- | --- | --- | --- | --- |
| `run1-visibility-e2e.json` | `{"pass":25,"fail":0,"total":25}` | 25 | 1 | 全部 PASS |
| `run2-visibility-e2e.json` | `{"pass":25,"fail":0,"total":25}` | 25 | 1 | 全部 PASS |

- 两份 JSON 均可被 `python3 json.load` 正常解析（无截断导致的语法错误）。
- 25 条 `checks` 的 **name 名单与顺序在两轮完全一致**；`status` 取值只有 `PASS`（25/25）。
- 交叉核对：25 条 `checks` 的编号序列（`V0,V1,V2,V3,V4,V4b,V4c,V4d,V3c,V3b,V6,V5,V5b,V5c,V7,V7b,V8,V8b,V9,V9b,V11,V12,V12b,V10,H1`）与 `10-visibility-run1.txt` / `11-visibility-run2.txt` 中的判定行**逐项、逐序完全一致**；两份日志末尾均为 `EXIT CODE: 0`、`结论：PASS — {"pass":25,"fail":0,"total":25,"notVerified":1}`。

**非同一份复制判定：**

| 项 | run1 | run2 |
| --- | --- | --- |
| 文件 sha256 | `c38f731204bd189b0d8a76c1fbe2108b3eea92c805a3287dc802e7d52fd8cb03` | `50fd9c0f548b3ccdce5b903fad5213551dd895dc3361cf1a3852de8db53becca` |
| 字节数 | 31701 | 31701 |

- **两份 JSON 不相同**（sha256 不同）✓
- 扁平化后共 319 个叶子字段，**69 处不同**，逐类归因：**时间戳 `.at` 50 处**（顶层 `at` + 25×`checks[].at` + 23×`operationRecord[].at`）、**窗口 / PID / 进程标识 16 处**（`ours` 162275 vs 162294、前台 pid 25293 vs 28497 等）、**帧字节数 3 处**（`checks[23].actual`、`operationRecord[23].actual` 的 burst 字节数组 + 顶层 `at` 已计入时间戳）。
- **业务判定层零差异**：两轮 `checks` 的 `name` + `status` 完全一致，`counts` 一致。
- **额外交叉核对（超出任务要求）**：`checks[23].actual` 声明的 burst 帧字节 `[346808,346954,347041,346901]`（run1）/ `[346783,346863,346958,347062]`（run2）与**该轮 PNG 实际字节数逐一相等** ✓ —— 即 JSON 的帧字节声明与被归档的 PNG 自洽。

### 3.2 PNG 有效性

- 36 个 PNG 全部通过 `file` 判定为 `PNG image data`：**非 PNG 行数 0**（无零填充 / 无文本 / 无损坏）。
- 位深与色彩：**36/36 = `8-bit/color RGBA, non-interlaced`**。
- 尺寸分布：
  - `2880 x 1880`：**12 张**（两轮的 `01-paint-before` … `06-panel-closed`）= 1440×940 × scale 2（V9 缩放前的窗口尺寸）；
  - `2360 x 1480`：**24 张**（两轮的 `07-after-resize` … `12-zoom`）= 1180×740 × scale 2（V9 缩放后的窗口尺寸）。
  - 与 `V9b` 声明的 `image=[2360,1480]`、`win={w:1180,h:740}`、`from {1440,940} → to {1180,740}` **完全自洽**。

### 3.3 不重复统计

- 36 张 PNG 的 **distinct sha256 = 36**，重复次数分布全为 1 ⇒ **不存在"同一张图重复 36 次"**。
- 跨轮也不重复：两轮 18 个同名帧的 sha256 **全部不同**。
- 进一步做**全分辨率像素级**比对（numpy，非仅哈希）：两轮 18 个同名帧 **0/18 像素完全相同**，差异像素占 0.01%–0.12%（`10-maximized` 500 px / `11-restore-before` 476 px 最少，其余约 3100–5000 px）⇒ 两轮确为**两次独立截图**，不是同图重编码或复制。
- 帧序列与操作序列在像素层自洽（run1，全分辨率差异像素占比）：

| 帧对比 | 差异像素占比 | 说明 |
| --- | --- | --- |
| `10-maximize-before` → `10-maximized` | **57.74%** | V12 最大化：画面大面积变化 ✓ |
| `11-restore-before` → `11-restored` | **57.74%** | V12b 恢复：同样大面积变化 ✓ |
| `10-maximize-before` ↔ `11-restored` | **0.15%** | 恢复后几乎回到最大化前 ✓ |
| `10-maximized` ↔ `11-restore-before` | 0.03% | 恢复前 = 最大化态 ✓ |
| `01-paint-before` → `02-tab-switch` | 19.95% | V5c「操作前后两帧像素确实不同」✓ |
| `07-after-resize` → `08-burst-0` | 0.14% | 同一状态连续帧，近似 ✓ |

- 像素色值抽样：`V4`/`V8b` 声明的页面绿 `56,123,83` 在 `10-maximized.png` 中为**最常见色（56.5%）**；`05-panel-open.png` 中该绿色占比 **0.0%**（面板遮挡）、`01-paint-before` 17.2%、`11-restored` 26.6% —— 与"面板打开时网页让位 / 关闭后回到可见"的判定方向一致。
- **据实描述**：以上为尺寸、有效性、哈希唯一性、像素差分与色值抽样；**未**做人眼逐帧内容判读（未验证"落点像素确实落在按钮上"这类语义），并**未**重跑真机（不允许）。

### 3.4 关键帧（每轮各 2 张）

| 路径 | 清单 bytes | 实测 bytes | 清单 sha256 == 实测 | `file` 尺寸 |
| --- | --- | --- | --- | --- |
| `run1-visibility-frames/07-after-resize.png` | 344791 | 344791 | **一致**（`23d2d83700a89161…`） | 2360 x 1480 RGBA |
| `run1-visibility-frames/11-restored.png` | 346506 | 346506 | **一致**（`b31a4dbb02b325ee…`） | 2360 x 1480 RGBA |
| `run2-visibility-frames/07-after-resize.png` | 344806 | 344806 | **一致**（`a9e3791a0f7630a4…`） | 2360 x 1480 RGBA |
| `run2-visibility-frames/11-restored.png` | 346748 | 346748 | **一致**（`5015cdfdcf04ce13…`） | 2360 x 1480 RGBA |

（首轮该步的校验曾因本机 `grep` 不支持 `-P` 而误报"不一致"，改用 `awk -F'\t'` 精确匹配后 **4/4 全部一致** —— 该误报属验收方工具问题，不是被测对象问题，特此声明。）

### 3.5 无补造 / 无覆盖

```
$ git diff --stat aa1512d -- experiments/d5-03/batch15/artifacts/     # 无输出
$ git diff --exit-code aa1512d -- experiments/d5-03/batch15/artifacts/ # exit 0
$ find experiments/d5-03/batch15/artifacts -type f | wc -l
38
$ diff <(git ls-tree -r --name-only aa1512d -- .../artifacts/ | sort) <(find .../artifacts -type f | sort)
（无输出）
```

→ 提交中 38 个产物与工作树对应文件**逐字节相同**；工作树该目录下文件数仍 = **38**（无多余、无缺失）✓

---

## 4. 第 4 步：未改忽略规则 / 未改旧报告 / PROGRESS 纯追加

### 4.1 `.gitignore` 未变

| 来源 | sha256 |
| --- | --- |
| `git show 8b8e8ad:.gitignore` | `4c0fdfe2d97b05490f628f84cbb450e88deb0f17233a326eeab17caddc614cfc` |
| `git show aa1512d:.gitignore` | `4c0fdfe2d97b05490f628f84cbb450e88deb0f17233a326eeab17caddc614cfc` |
| 工作树 `.gitignore` | `4c0fdfe2d97b05490f628f84cbb450e88deb0f17233a326eeab17caddc614cfc` |
| 任务给定期望值 | `4c0fdfe2d97b05490f628f84cbb450e88deb0f17233a326eeab17caddc614cfc` |

`git diff --name-only 8b8e8ad aa1512d -- .gitignore` **无输出** ⇒ 两侧与工作树**三向一致**，忽略规则未被放宽 / 删除 ✓

补充验证忽略来源：`git check-ignore -v --no-index`（因文件已被跟踪，默认模式不查索引、故无输出 —— 这是 Git 的既定行为）对 4 个代表路径输出均为 **`.gitignore:3:artifacts/`** ⇒ 证明 `experiments/d5-03/batch15/artifacts/**` 确实是被第 3 行 `artifacts/` 规则忽略，与补充说明 §3 一致 ✓

### 4.2 旧报告 / 既有证据未被改

`git diff --name-only 8b8e8ad aa1512d` 全量名单 = **42 条**，逐条形态为：`PROGRESS.md`（M）+ 3 个新增文本 + 38 个新增产物；**代码目录 `src/` / `electron/` / `tests/` / `experiments/d5-01/` 的 diff 为空**。

禁止名单逐项计数（均应为 0）：

| 禁止项 | 命中数 |
| --- | --- |
| `D5-03-BATCH15-REPORT.md` | **0** |
| `D5-03-BATCH15-E1-REPORT.md` | **0** |
| `verify/**` | **0** |
| `10-visibility-run1.txt` | **0** |
| `11-visibility-run2.txt` | **0** |
| `00-prerun-facts.txt` | **0** |
| `experiments/d5-01/visibility-e2e.mjs`（2400 截断所在文件） | **0** |

⇒ 旧报告与既有证据**全部未被修改或删除** ✓（`batch15/verify/` 下 10 个既有文件也全部未动）

### 4.3 `PROGRESS.md` 纯追加

```
$ git diff --numstat 8b8e8ad aa1512d -- PROGRESS.md
20      0       PROGRESS.md
```

- **删除列 = 0** ✓
- 行数：`8b8e8ad` **2246** → `aa1512d` **2266**（+20）
- 字节：419095 → 425848（+6753）
- **逐字节前缀判定**：`git show 8b8e8ad:PROGRESS.md` 是 `git show aa1512d:PROGRESS.md` 的**前缀 = True** ⇒ 纯追加 ✓

新增节核对：

| 核对项 | 实测 |
| --- | --- |
| 标题日期 = **2026-10-04** | ✓ `# D5-03 第十六批 · batch15 证据归档补齐（38 个产物入提交）· 2026-10-04（父 8b8e8ad）` |
| 系列消歧（D5-03 线 vs D5-02 画布线「第十六批」） | ✓ 明写"与 `PROGRESS.md` 中 **D5-02 画布**线的「第十六批」（宿主 sandbox 补 `allow-modals`，见 `PROGRESS.md:1307` 等）是**不同系列**"；实测 `aa1512d:PROGRESS.md` 第 **1307** 行正是 `15. **第十六批：宿主 sandbox 补 allow-modals…` ⇒ **行号引用精确** |
| 时间口径（归档日 vs 产物产生日） | ✓ 2026-10-04 归档 / 2026-10-01 21:14–21:17 产物；提交时间戳 `1791116271` = **2026-10-04 20:17:51 CST** 与 `8b8e8ad` 的 `1790862199` = 2026-10-01 21:43:19 CST 相符 |

---

## 5. 第 5 步：补充说明逐条内容核对

对 `experiments/d5-03/batch15/16-archive-supplement.md`（从提交取出，124 行 / 9526 字节）逐条核对：

| # | 补充说明的陈述 | 独立核对结果 |
| --- | --- | --- |
| 1 | 被测基线**仍是 `2d50986`**（来源 `D5-03-BATCH15-REPORT.md` 第 3 / 52 行） | **属实**。实测旧报告第 3 行 = "**被测代码树：`2d50986`**"、第 52 行 = `2d50986be46515678…` ⇒ 引用位置与内容都对 |
| 2 | 结论沿用 batch15：两轮 25/0/25/**1 NV**、`EXIT=0`、`V9`/`V11`/`V12b` 已验收 | **属实**。`10-/11-visibility-run*.txt` 末尾均为 `EXIT CODE: 0` + `结论：PASS — {"pass":25,"fail":0,"total":25,"notVerified":1}`；21/22 条 (V12/V12b) 在两份 JSON 中均 `status=PASS` |
| 3 | 本批只归档：无新真机运行 / 无代码改动 / 未改任何原始产物 / 无 `commit`/`push`/`merge`/`rebase`/`--amend`（只暂存，提交由上级统一做） | **属实**。提交形态无 `D`/`R`；`src/`、`electron/`、`tests/`、`experiments/d5-01/**` diff 为空；38 产物与工作树逐字节相同；本批前 15 个已跟踪文件全部未被改；本批此前确实无提交（`8b8e8ad` 即为 HEAD，工作树干净） |
| 4 | 此前未入提交的原因 = `.gitignore` **第 3 行 `artifacts/`**（无路径前缀的目录规则，匹配任意层级），并已用 `git check-ignore -v` 以 4 个代表路径取证 | **属实**。`check-ignore -v --no-index` 复现输出一致（另见 `16-archive-precheck.txt` §1.2 记录的 4 条原文）；`8b8e8ad` 下 `batch15/` 已跟踪 **15** 个、`artifacts/` 下 **0** 个，与陈述逐数吻合 |
| 5 | 只对指定的 **38** 个文件 `git add -f`、按**原路径**纳入，且**未改忽略规则**（附 `.gitignore` sha256） | **属实**。38 条新增路径与清单集合相等、无重命名（无 `R`）；`.gitignore` 三向 sha256 一致（§4.1） |
| 6 | 校验清单路径与复算方法（§7 给了单文件 / `git archive` / 批量三条命令） | **属实且可执行**。实测批量命令 OK 38 / DIFF 0；`git archive` 抽样 3 条全中（§2.5） |
| 7 | **2400 字符截断**（`experiments/d5-01/visibility-e2e.mjs:44`）仍在，**本批不改、另批修** | **属实**。`aa1512d:experiments/d5-01/visibility-e2e.mjs` 第 44 行确为 `actual: String(actual ?? "").slice(0, 2400)`；两份 JSON 中 `V11` 的 `actual` 长度**恰好 2400**（两轮均是），即截断真实存在且已带入归档产物 |
| 8 | **`D5-03` 整体仍 = `PARTIAL`** | **属实（作为判定口径）**。本批未闭环任何产品/测试范围事项，`PROGRESS.md` 新增节也明写"整体判定不因本批改变" |
| 9 | 本批唯一写操作 = 新增 3 个文本 + `PROGRESS.md` 末尾追加 | **属实**（`A` 3 个文本 + `M` PROGRESS.md，其余 38 个 `A` 为归档产物） |

**与事实不符 / 夸大之处：1 处（低级，数字算术）** —— 见 §7 发现 F1。除此之外**未发现**虚假陈述或夸大；两处容易被误读的表述（"未产生提交"、`framesDir` 字段值）经核对属**如实**或**已披露**，见 F3 / F5。

---

## 6. 独立复现命令（本报告全部结论可由下列命令重放）

```bash
cd "/Users/wepingli/Desktop/OpenArc OS-integration"
git rev-parse HEAD                                    # 期望 aa1512d…
git rev-parse aa1512d^                                # 期望 8b8e8ad…
git show --name-status --format="" aa1512d | awk '{print $1}' | sort | uniq -c   # 41 A / 1 M
git ls-tree -r --name-only aa1512d -- experiments/d5-03/batch15/artifacts/ | wc -l  # 38
git show aa1512d:experiments/d5-03/batch15/16-archive-manifest.tsv \
  | awk -F'\t' 'NR>1 && $1 !~ /^#/ {print $1"\t"$3}' \
  | while IFS=$'\t' read -r p want; do
      got=$(git show "aa1512d:$p" | shasum -a 256 | awk '{print $1}')
      [ "$got" = "$want" ] || echo "DIFF $p"
    done                                              # 期望无输出
git diff --name-only 8b8e8ad aa1512d -- .gitignore     # 期望空
git diff --numstat 8b8e8ad aa1512d -- PROGRESS.md      # 期望 20  0
git diff --exit-code aa1512d -- experiments/d5-03/batch15/artifacts/  # 期望 exit 0
```

---

## 7. 发现清单（按严重度）

### 阻断级（FAIL 级）：**无**

### 中级：**无**

### 低级（应修正，不影响本批判定）

**F1｜补充说明 §4 的合计项数算术错误**
- 原文（`16-archive-supplement.md` 第 64 行）：「只按显式路径清单 `-f` 暂存这 38 个文件，另加 3 个新增文本文件与 `PROGRESS.md`，合计 **41** 项。」
- 事实：38 + 3 + 1 = **42**；`git show --name-status` 实测 **41 `A` + 1 `M` = 42**；`PROGRESS.md` 新增节自述的也是「另加 4 个文本文件…合计 **42** 项暂存」。
- 影响：同一批的两份文本对同一事实给出 41 / 42 两个数字，其中 41 与提交实际不符。属表述错误，**不涉及产物或结论**，建议下一批顺带改正（或改为"38 产物 + 4 个文本文件 = 42"以与 PROGRESS 统一口径）。

### 信息级（记录，不构成问题）

**F2｜`V12`/`V12b` 的 `windowRect` 名实不符（措辞偏好强硬）**
- 两份 JSON 中 `checks[21]`（V12）的 `windowRect.before = {left:164,top:56,width:830,height:570}` → `after = {left:0,top:38,width:1180,height:702}`，检查名写「窗口状态 + 网页布局真的变化」。
- 但归档截图证明 **OS 窗口尺寸全程未变**：`10-maximize-before.png` 与 `10-maximized.png` 同为 **2360×1480**（=1180×740×2），且该按钮在 JSON 中的 `label` 为 `最大化browser`。
- 据实地说：变化的是**窗口内的网页视图矩形**（830×570 → 1180×702），不是操作系统窗口尺寸；"窗口状态…真的变化"的措辞偏强。像素层证据（57.74% 像素变化）与该解读一致。
- 说明：**同一数据已由 batch15 验证报告（`verify/BATCH15-VERIFY-REPORT.md` §5「V12b 复算」表 / §9「截图清单与尺寸核实」）核对并认定为自洽**，故不构成本批的新问题，也不改变本批判定；仅建议后续把字段名/措辞改为"网页视图矩形"以免误读。

**F3｜"未产生提交 / 提交号尚未产生"的自指性**
- 补充说明与 `PROGRESS.md` 均声明「本批未 `commit`」「提交号尚未产生，本批不编造哈希」，而这两段文本本身已随 `aa1512d` 入库。
- 这是**归档时点的如实表述**（提交确由上级随后统一创建），不是虚假陈述；但读者需知道"提交号尚未产生"指写作时刻，且作者用"父提交 + 主题"来指代而非编造哈希 —— 属**诚实处理**，建议后续不再需要此写法。

**F4｜两份产物 JSON 的 `testedCommit` 为 `null`**
- 两轮 JSON 的 `testedCommit` 字段实测均为 `null`，即**产物 JSON 自身不携带被测基线哈希**；"被测基线仍是 `2d50986`"只能通过 `D5-03-BATCH15-REPORT.md` 与 `10-/11-*.txt` 追溯。
- 属**可回溯性缺口**（不是虚假声明）。若要"导出提交即可自证基线"，建议后续由门禁把 `testedCommit` 写入产物。

**F5｜JSON 内 `framesDir` / `checks` 结构的两点冗余**
- `framesDir` 值为 `artifacts/d5-01/visibility`（原始运行输出目录），与被归档路径 `experiments/d5-03/batch15/artifacts/run*-visibility-frames/` 不同 —— 该字段记录的是运行时的输出目录，不算错误，但易误读；补充说明未解释此字段。
- 每份 JSON 内 `checks` 与 `operationRecord` 为**逐字节同值的重复副本**（`checks == operationRecord` 为 `True`，各 25 条），导致单文件体积翻倍（均 31701 字节）。不影响证据有效性。

**F6｜证据完整性（正向核对，非缺陷）**
- `16-archive-precheck.txt` 开头已主动声明「本文件先写入临时路径再落地，故下方 `git status` 反映的是本文件创建之前的真实基线状态」—— 这解释了我原本会质疑的一点（若直接重定向到仓库内路径，`git status` 本应显示该文件自身为未跟踪、行数不会是 0）。**属充分披露**，不计为发现。

---

## 8. 我不同意的地方

1. **不同意把"沿用 batch15 的运行结论"读成"本批验证了运行结论"。** 本批无任何新真机运行，25/0/25/1 与 `EXIT=0` 是本批**核对归档一致性**的对象，不是本批**重新取得**的实测。我在报告中一律按"归档一致性已独立复算、机器结论沿用未重跑"表述。
2. **不同意 `V12`/`V12b` 用 `windowRect` 指代网页视图矩形并写成"窗口状态真的变化"**（见 F2）：截图尺寸证明 OS 窗口尺寸未变。这不改变 V12/V12b 的 PASS 结论（变的是窗口内视图与网页布局），但措辞应改。
3. **不同意把 2400 字符截断继续排在"另批修"的队尾。** 本批的立项理由正是"证据可回溯性"（原始帧与原始计数此前完全不进版本库）；而同一门禁的 `V11` 断言原始值恰好在 **2400** 字符处被切掉，使门禁自身产物无法完整回溯、必须依赖旁路文件。既然本批已补齐归档，我主张**紧随其后的批次优先修掉**（提高上限或按落点分段），否则归档补齐的可回溯性仍有已知缺口。
4. **不建议用"两轮独立"来论证稳定性。** 实测两轮同名帧的像素差异仅 0.01%–0.12%（18 个同名帧 0/18 完全相同但差异极小），说明该序列高度确定；这足以证明"两次独立运行"，但**不足以**论证鲁棒性/抗干扰性。若要论证后者需改变量（不同窗口尺寸、不同前台负载等），属另一类证据。

---

## 9. 仍未验证项（如实登记）

1. **未重跑真机门禁**（本次验收明确禁止运行 `test:d5-01*` / 任何前台脚本），因此 25 PASS / 0 FAIL / 1 NOT VERIFIED 与 `EXIT=0` 的**机器结论未由本报告重新取得**；本报告只证明了"归档产物与该结论自洽、且被归档内容未被改动"。
2. **被测基线 `2d50986` 无法从产物自身独立确认**：两份 JSON 的 `testedCommit` 为 `null`，该绑定依赖 batch15 报告与日志文本（详见 F4）。
3. **截图语义未逐帧人眼判读**：本报告做了有效性、尺寸、哈希唯一性、全分辨率像素差分与声明色值抽样（页面绿 `56,123,83`），但**未**验证"某次点击的落点像素确实落在目标按钮上"这类逐点语义（该判定沿用 batch15）。
4. **`V11` 被截断的 2400 字符之后的原始值未随本批归档**；旁路文件 `verify/captured/payload-001-2955.json` 属 batch15 既有文件，本批未动，其外部绑定强度限制沿用 batch15 登记（补充说明 §8.1 已如实登记）。
5. **`16-archive-precheck.txt` 中记录的命令（`enumerate.py` / `jsoncheck.py` / `make_manifest.py` / `verify_manifest.py`）本身未随提交归档**，其原始输出已在 `precheck` 中保留、且我用等价命令独立复现了全部结论；但脚本实体不在版本库内，无法逐行复核脚本实现。

---

## 10. 最终判定

| 判定对象 | 结论 | 依据 |
| --- | --- | --- |
| **本批（batch15 证据归档补齐）** | **PASS** | 提交形态 41 `A` + 1 `M` 与声明一致；38/38 逐文件从提交复算 **一致、0 不一致**，合计 12733808 字节与清单合计行逐字符一致；38 条均父提交不存在（真新增）；两份 JSON 计数与"非同一份"成立；36 张 PNG 全有效且 distinct 36；提交产物与工作树逐字节相同；`.gitignore` 三向未变；旧报告/既有证据零改动；`PROGRESS.md` 纯追加（20/0）且日期与系列消歧核对无误；未 push。发现仅 1 处低级文本算术错误（F1），不涉及产物与结论。 |
| **D5-03 整体** | **仍 = PARTIAL** | 本批只补齐 batch15 的证据归档，未闭环任何新产品 / 测试范围事项（2400 字符截断、9 个陈旧 `data-app-id` 探针、`browser-e2e.mjs:487` 等遗留一律未动）。 |

**判定声明边界**：本判定只覆盖 `aa1512d` 这一个提交的**归档一致性与真实性**；不覆盖"D5-01 visibility 门禁在真机上是否仍然通过"（未重跑）。
