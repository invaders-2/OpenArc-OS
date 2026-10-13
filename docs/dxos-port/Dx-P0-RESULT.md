# Dx-P0-RESULT · 基线与契约冻结（无代码）

> 依据：计划 §7 P0、§8 验收口径。本阶段**不含任何产品代码改动**。

## 1. 交付物对照

| P0 要求的交付 | 落点 | 状态 |
|---|---|---|
| 基线 commit 记录 | `docs/dxos-port/Dx-P0-BASELINE.md` | ✅ DONE |
| `window.openarc` 契约清单（现有域 + 新增域） | `docs/dxos-port/Dx-P0-IPC-CONTRACT.md` | ✅ DONE |
| 本地化开关清单 | `docs/dxos-port/Dx-P0-LOCALIZATION-SWITCHES.md` | ✅ DONE |
| 依赖清单确认书 | `docs/dxos-port/Dx-P0-DEPENDENCIES.md` | ✅ DONE |
| 表冲突清单（64 vs 55） | `docs/dxos-port/Dx-P0-TABLE-CONFLICT.md` | ✅ DONE |
| 勘误（计划数字 vs 实测） | `Dx-P0-BASELINE.md` §4 | ✅ DONE |
| 专项 worktree + 分支 | `/Users/wepingli/.openarc-worktrees/dxos-port-r1` @ `dxos-port/r1` | ✅ DONE |

## 2. 真实命令与真实输出（节选）

```
$ git worktree add -b dxos-port/r1 /Users/wepingli/.openarc-worktrees/dxos-port-r1 128e21da…
Preparing worktree (new branch 'dxos-port/r1')
HEAD is now at 128e21d docs(d5-01): 第十六批 归档补充说明笔误更正 + 独立验收报告入档（aa1512d 后续）

$ npm run build      → ✓ built in 1.25s，exit 0
$ npm test           → # tests 1412 / pass 1411 / fail 1（第二次运行 fail 2）
$ npm ls sharp ws    → sharp@0.35.5 / ws@8.22.0 均为 @deepseek-ai/dsh 传递依赖
$ ffmpeg -version    → ffmpeg version 7.1.1
$ python3 -c "import onnxruntime" → ModuleNotFoundError
```

## 3. 验收判定

| 计划 §7 P0 验收项 | 结果 |
|---|---|
| 文档评审通过 | 本文件 + 5 份清单已产出，待用户评审 |
| 确认 §11 阻塞项 | 本轮由用户授权「自主判断执行」，阻塞项已按 Dx-P0-DEPENDENCIES / SWITCHES 落为决策 |

## 4. NOT VERIFIED

- 计划原文「OpenArc 65 表」与实测 64 的差额来源（可能是动态建表）：NOT VERIFIED。
- 5 张同名表的字段级合并方案：NOT VERIFIED（本轮只做「跳过不建」）。
- 主 worktree 上的 219 个测试是否 100% 通过：未在主工作区执行，NOT VERIFIED。
