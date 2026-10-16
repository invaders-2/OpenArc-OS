# resources/bundled-skill-packages —— 随包技能包目录

本目录放**随应用分发的技能包（ZIP）**。它们不联网、不下载、不执行包内文件，
只作为"开箱可用"的本地技能包来源。目录里**只允许自有内容**：
不搬运 DX 分发里的 `minimax-h3-skills.zip`，也不放任何第三方包（合规要求见文末）。

## 目录约定

```
resources/bundled-skill-packages/
  README.md                     # 本文件
  <package-name>/               # 自写源目录（便于审阅；可选）
    SKILL.md
    skill.json                  # 可选：标准包清单
    references/*.md
  <package-name>.zip            # 由 scripts/build-bundled-skill-packages.mjs 生成
```

- 一个技能包 = 一个 `.zip` 文件，文件名即包名（`<package-name>.zip`）；
  ZIP 内的文件位于**包根**（不带 `<package-name>/` 前缀）。
- `<package-name>/` 源目录是"可读的真源"，ZIP 由 `scripts/build-bundled-skill-packages.mjs`
  从源目录重新生成（store 压缩、无第三方依赖）。改内容请改源目录再重新生成，不要手改 ZIP。
- 目录为空是**有效空态**：列出结果为空数组，不报错。

## 包格式（两种，均被 `electron/skill-import.cjs` 支持）

1. **标准包**：根目录同时有 `skill.json` 与 `SKILL.md`。
   `skill.json` 必须是合法 JSON，`format` 为 `ccs-skill/v1`，`kind` 缺省或 `text`，
   且 `systemPrompt` 非空。
2. **Agent Skills 包**：包含一个或多个 `SKILL.md`（可 `<dir>/SKILL.md`）。
   `SKILL.md` 头部可选 YAML frontmatter（`name` / `description`）。

包内允许的文本文件：`.md` / `.txt` / `.yml` / `.yaml` / `.json`；
单个文本条目上限 384 KB，参考文档总量上限 2 MB，包体上限 32 MB，
解压总量上限 128 MB（`electron/skill-pack.cjs`）。危险路径（绝对路径、`..`）
与未知压缩方式会被结构化拒绝。

## 扫描与导入优先级

`electron/skill-pack.cjs` 按下面的顺序查找技能包（先命中的目录胜出）：

1. 显式注入的 `bundledDir`（测试 / 宿主定制用）；
2. 环境变量 `DX_BUNDLED_SKILL_PACKAGES_DIR` / `DX_BUNDLED_SKILL_PACKS_DIR`；
3. **本目录**（`<应用根>/resources/bundled-skill-packages`，打包后随应用分发）；
4. `<应用根>/electron/bundled-skill-packages`（历史缺省，保留兼容）。

命令面的用法：`skillPack/listBundled` 列出可用随包；`skillPack/importBundled`
按包名导入（详见 `electron/skill-pack.cjs` 的 `listBundledSkillPackages` /
`readBundledSkillPackage` / `importBundledSkillPack`）。

## 为什么本目录只有自有示例

随包目录一旦放进第三方包，就等于**把第三方内容随产品再分发**（许可证、来源、
版本都不可控）。因此本仓只放一个**自建的最小示例** `dxos-example-bundle`：
它只用于验证扫描 / 列出 / 导入链路，不含任何厂商素材。要投放自己的包，
把源目录与生成后的 ZIP 一起放进本目录即可。
