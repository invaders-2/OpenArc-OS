# Dx-P1-RESULT · 地基（B1）

> 依据：计划 §7 P1、§8 验收口径。基线：`dxos-port/r1` @ `128e21d`。真实命令与真实输出见下，未验证项如实标注。

## 1. 交付物对照

| P1 要求 | 落点 | 状态 |
|---|---|---|
| 单库并入与迁移 v22 骨架 | `electron/identity-store.cjs`（SCHEMA_VERSION 21→22 + MIGRATIONS 追加 v22） | ✅ DONE |
| DX 表 DDL 真值 | `electron/dxos-foundation-schema.cjs`（57 张表、107 条幂等 DDL、跳过 5 张同名表） | ✅ DONE |
| 数据根布局（§6.1） | `electron/dxos-foundation-paths.cjs` | ✅ DONE |
| 公共能力：错误规约 / 掩码 / 事件 / 配额 | `dxos-foundation-{errors,mask,events,quota}.cjs` | ✅ DONE |
| 子进程运行器封装 | `electron/dxos-foundation-runner.cjs`（复用 executor-launcher 模式） | ✅ DONE |
| `window.openarc` TS 类型 | `src/types/openarc-ipc.d.ts`（现有 17 域 + 12 新域，全部可选） | ✅ DONE |
| 迁移与单测 | `tests/dxos-foundation.test.mjs`（23 个用例） | ✅ DONE |

## 2. 关键实现决策（含实测理由）

1. **跨域外键全部去除、只留列**（23 处）。实测：OpenArc `tasks` 主键是 `task_id`（`identity-store.cjs:834`）、`task_steps` 是 `step_id`（`:856`），DX 原文 `REFERENCES tasks(id)` 会触发 `foreign key mismatch`（`DELETE FROM tasks` 直接报错）；改成 `tasks(task_id)` 语法成立但会让既有迁移测试的手工 `DROP TABLE` 降级夹具被外键检查拖住（实测 7 个既有迁移用例失败）。去 FK 后这 7 个用例全部恢复通过。
2. **同名 5 张表跳过不建**：`projects` / `project_members` / `tasks` / `task_steps` / `task_events`（清单见 `Dx-P0-TABLE-CONFLICT.md`）。
3. **迁移幂等**：全部 DDL 为 `CREATE TABLE|INDEX IF NOT EXISTS`，v22 整级随外层事务回滚，不会出现"user_version 已升到 22 但表只建一半"的半状态。
4. **拒开行为保持**：库版本高于程序仍拒开（`identity-store.cjs:1707` 行为未改）。

## 3. 真实命令与真实输出（节选）

```
$ npm run build
> tsc --noEmit && vite build
✓ 1638 modules transformed.   ✓ built in 1.25s        EXIT=0

$ node --test tests/dxos-foundation.test.mjs
1..23   # tests 23 / # pass 23 / # fail 0              EXIT=0
```

## 4. 需要同步更新的既有断言（已由独立测试岗完成）

SCHEMA_VERSION 21→22 触发了 17 处"当前 schema 版本"字面量断言，已由独立岗按"只改数值、不动语义"更新；
其中"构造 v21 老库再重放 v22"的幂等性夹具刻意保持 21；新增 DX 表 `cloud_installation_binding` 触发
`tests/d5-03-reset-authorization-consistency.test.mjs` 的 org 表集合守卫（27→28），已由独立岗**显式登记该表并新增 pin 断言**，守卫未被放宽。

## 5. NOT VERIFIED

- `#337` 环境性基线失败（见 `Dx-ROUND-RESULT.md` §2），与本阶段无关。
- DX 迁移内的数据操作（v34 内置 agent_profiles 种子、v47/v48 JSON 回填）**未抽取**：交付物只要求 DDL，空表回填无意义，留待后续批次。
- 跨域外键语义：去 FK 后 DX 子表可写入任意 `task_id`，约束留待 P4 对齐任务列后决定。
