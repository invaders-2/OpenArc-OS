# 多 worktree / 多对话协作规则（唯一口径）

> 背景：同一仓库会同时有多个对话在推进不同阶段。本轮真实踩过的坑：
> ① 分支被另一个对话切走；② 别人的未提交 WIP 混进我构建的 `.app`；
> ③ 有人往**别人的 worktree** 里写文件。这份文档就是为了让这些不再发生。

## 1. 铁律

1. **一个 worktree 只归一个对话写**。要开工先在 §2 的表格里认领一行；不要在别人的路径里写文件。
2. **一个分支只被一个 worktree 检出**。`npm run oa:status` 会自动检查这条，重复检出会告警。
3. **`.app` 只能从已提交状态构建**：用 `npm run oa:app -- <ref>`。绝不要"从某个正在改的工作区构建"。
4. **不碰别人的未提交改动**：不 `git checkout --`、不 `git stash`、不 `git clean`、不提交别人的文件。
5. **push 需要明确授权**：每个对话推送自己的分支前，先确认（本轮 UI 分支就一直未推）。
6. **不要在别人的分支上 merge main**；阶段门（Gate）由对应阶段的对话负责。

## 2. 工作目录认领表（按现状填写；认领后请更新本表）

| Worktree | 分支 | 归属 | 用途 | 状态 |
|---|---|---|---|---|
| `/Users/wepingli/Desktop/OpenArc OS` | `feature/d3-02-object-authorization` | 对话 B | D3-02 + Dock/UI 试验 | 有未提交改动 |
| `/private/tmp/oa-wt` | `fix/ui-window-chrome` | 对话 A（UI） | 窗口/桌面外观打磨 | 有未提交改动（见备注） |
| `/private/tmp/oa-d303` | `feature/d3-03-device-identity` | 对话 A（D3-03） | 设备身份域（已完成、已推 origin） | 干净 |
| `/Users/.../OpenArc OS-d3-04a` | `feature/d3-04a-resource-store` | 对话 C | D3-04A 资源存储 | 干净 |
| `/Users/.../OpenArc OS-d3-04b` | `feature/d3-04b-resource-library` | 对话 D | D3-04B 资源库 CRUD | 有未提交改动 |

> 备注（已解决）：`/tmp/oa-wt` 曾出现两份**不属于对话 A** 的文件（`src/desktop/components.tsx` 改动 +
> 新增 `src/desktop/useDockMagnify.ts`）。经查它们是**同一改动的另一半**：已提交的 `main.tsx`
> 早已传 `reduced` 给 `<Dock>`，缺了这半份分支 HEAD **编译不过**。
> 对话 A 按原样提交（`f9660ef`，无代码改动、注明来源），该 worktree 现已干净、该分支可从未提交状态之外干净构建。
> **教训**：半边提交必须当场补完 —— 否则"别人的 WIP"其实是"自己分支坏了"。
> 由 `npm run oa:status` 自动检查（干净工作目录 + 干净检出构建）可提前发现。

## 3. 两个入口

```bash
npm run oa:status          # 统一状态总览：worktree / 分支 / HEAD / 未提交数 / 未推送数 / .app 来源
npm run oa:app             # 从当前分支 HEAD（已提交状态）构建并同步 .app
npm run oa:app -- <ref>    # 从任意 commit / 分支 / tag 构建
npm run oa:app -- <ref> --no-restart
```

`.app` 载荷里会写入 `openarc-build.json`（branch / commit / dirty / builtAt），
`oa:status` 读它来回答"你现在看到的预览到底是哪个 commit"。

## 4. 建议的并行分工

- 每个阶段一个 worktree + 一个分支 + 一个对话；跨阶段的**只读**参考直接读文件，不要检出。
- 需要别人的改动时：让对方推分支，你 `git cherry-pick` 或等 merge —— 不要去改他的工作区。
- UI 类改动与阶段类改动**不要混在同一个分支**：本轮的 `fix/ui-window-chrome` 就是纯 UI 分支，
  阶段工作（D3-02/D3-03/D3-04）各自独立，避免互相覆盖。
