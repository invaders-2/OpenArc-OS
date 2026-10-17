# 画布权限与共享 · 调研与设计

> **P1 已落地（2026-10-17）**：产品最终拍板为**三档角色**（VIEWER / EDITOR / MANAGER）+ 按人授权 +
> 私有/组织内可见；ORGANIZATION = 只读底线。实现与契约以
> `experiments/dxos-canvas-sharing/P1-IMPLEMENTATION.md` 为准；本文 §2.1/§3.3/§4.2 中“两档 / v28”
> 的推荐已被上述决定覆盖。三档迁移因 v28 已被占用、v29 属于在途任务合并包，改为
> `CanvasStore` 构造时执行的可重复显式迁移（见 P1 文档 §5.2）。
>
> 版本：v0.1（2026-10-17）
> 范围：只读调研 + 方案设计；**本包不修改任何产品代码**。
> 新增文件：`experiments/dxos-canvas-sharing/DESIGN.md`、`experiments/dxos-canvas-sharing/probe.mjs`。
> 调研方式：源码逐行核对 + 本机 `identity.db` 只读查询 + 内存数据库探针（`probe.mjs`，`:memory:`，不碰真实库）。
> 工作树提示：调研时 `public/novai-canvas/**`、`electron/image-params.cjs`、`experiments/d5-02/**` 有其他会话的未提交改动；本包只读，未触碰。

---

## 0. 结论摘要

1. **权威画布模型是 `canvas_boards`（文档层）+ `canvas_shares`（共享层）**，由 `electron/canvas-service.cjs` 读写，经 `canvas:command` 暴露给画布宿主；`/api/canvases` 只是 vendored 画布页的 HTTP 形状，最终落到这条命令链。证据见 §1.2。
2. **`dxos-foundation-schema.cjs` 的 `canvases` / `canvas_members` / `canvas_invites` 是 DXOS 导入的死表**：只有 DDL，没有任何运行时读写；本机库 0 行；与 `canvas_boards` 没有同步或迁移。**不要拿它做共享模型**。证据见 §1.1、§1.6。
3. **还存在一个同表遗留服务**：`electron/integration-service.cjs` 的 `CanvasService` 也读写 `canvas_boards`（资源板，不含文档/共享），通过 `resource:command` 的 `resource/listBoards` 等暴露；它的 React UI `src/governance/CanvasApp.tsx` 在 Vue 壳里没有挂载。它不是权威共享路径，且会绕过共享规则。证据见 §1.1、§6.5。
4. **现有共享是半成品**：有 `canvas/share`（upsert）、`canvas/shares`（列表）、`canvas/visibility`（私有/组织可见）；**没有**移除、改角色命令、访问查询、共享候选人、所有权转移；`deleteShare` 只有 store 方法没有调用者；共享/可见性变更**完全没进审计**；前端没有任何共享 UI。证据见 §1.4。
5. **三个必须先修的问题**（探针已复现）：
   - 组织可见（`ORGANIZATION`）的权限判断排在显式共享之前，导致“被共享为编辑者”在组织可见画布上被降级为只读；
   - `shareCanvas` 不校验目标账号，允许写入不存在用户/外组织用户，且外组织用户能凭这条共享打开画布；
   - 宿主在权限变化后不会刷新 `canEdit` / 不重新推只读闸；共享被撤销时页面仍停在可编辑状态（后端会拒绝保存，但 UI 不一致）。
6. **推荐方案**：两档角色（查看者 / 编辑者）+ 所有者（及超管）管理共享；`ORGANIZATION` 只给组织内**只读**；共享 UI 放在**我们自己的画布宿主浮层**（CanvasHost），不改 vendored 页面；数据沿用 `canvas_shares`，只加 v28 的 `created_at` 与一个组合索引。

---

## 1. 现状事实

### 1.1 三套“画布”的边界

| 模型 | 表 / 字段 | 谁在读 / 写 | 是否同步 | 结论 |
|---|---|---|---|---|
| **文档画布（权威）** | `canvas_boards`：`id, organization_id, owner_user_id, name, created_at, updated_at, icon, kind, doc, revision, visibility, deleted_at, deleted_by`；`canvas_shares`：`canvas_id, user_id, role, granted_by, at`；`canvas_commands`、`canvas_runs`、`canvas_run_facts` | `canvas-store.cjs` / `canvas-service.cjs`；入口 `canvas:command`；画布页经 bridge/host 走到这里 | — | **权威**。AI Studio 的列表、打开、保存、命令、共享、生成都在这条线上 |
| **资源板遗留服务（同表）** | 同一张 `canvas_boards`，只使用基础列 + `canvas_resource_nodes`（`resource_id, resource_version, version_mode, x, y`） | `integration-store.cjs:33-37`、`integration-service.cjs:168-280`；入口 `resource:command` 的 `resource/listBoards` / `resource/createBoard` / `resource/getBoard` / `resource/addCanvasResource` | 与文档层**共用表**，但不读写 `doc/revision/visibility`，也不看 `canvas_shares` | **遗留**。它把 board 当作“资源引用板”，不是 AI Studio 文档；其 UI `src/governance/CanvasApp.tsx` 在 Vue 壳里**没有挂载**（全仓只有自身定义，无 import） |
| **DXOS 导入死表** | `canvases`：`id, project_id, owner_id, title, document_json, version, visibility('restricted'), deleted_at, card_count, thumbnail`；`canvas_members(canvas_id,user_id)`；`canvas_invites(code_hash,permission read/edit,...)`；`canvas_invite_members` | 只有 `dxos-foundation-schema.cjs` 的 DDL 与迁移；`electron/`、`src/`、`src-vue/`、`public/` 无任何 `FROM/INTO/UPDATE canvases`；本机库 0 行 | **无同步、无迁移** | **死表**。保留只为 DXOS schema 兼容；共享设计不得使用 |

**证据**

- `canvas_boards` DDL：`electron/identity-store.cjs:744-753`；v17 文档层列与 `canvas_shares`：`electron/identity-store.cjs:1167-1218`。
- `canvas-store.cjs` 的 SQL 全集：`electron/canvas-store.cjs:10-46`；共享读写：`:118-124`；`setVisibility`：`:116`；`purge`：`:115`。
- 文档服务：`electron/canvas-service.cjs:54-81`（actor/access/load）、`:169-191`（列表）、`:276-306`（共享/可见性/列表）。
- 遗留服务：`electron/integration-service.cjs:168-186`（`CanvasService` / `#boardAccess`）；`electron/integration-store.cjs:33-45`；`electron/resource-bootstrap.cjs:80-82`、`:368-379`。
- DXOS DDL：`electron/dxos-foundation-schema.cjs:235-238`；索引：`:287-292`；v22/v27 重放：`electron/identity-store.cjs:1548-1553`、`:1593-1600`。
- 冲突清单也把 `canvas_boards` / `canvas_shares` 记为 OpenArc 现有表：`docs/dxos-port/Dx-P0-TABLE-CONFLICT.md:54`。

### 1.2 权威链路：`/api/canvases` 到底读谁

```
vendored 页面 (openarc-canvas://bundle/static/canvas-list.html 或 smart-canvas.html)
  └─ fetch('/api/canvases')                    public/novai-canvas/static/canvas-list.html:1365 等
      └─ openarc-bridge.js 的 route()          public/novai-canvas/openarc-bridge.js:415
          └─ method = 'canvas.list'
              └─ 宿主 CanvasHost.handleCall()  src/canvas/CanvasHost.tsx:368-370
                  └─ window.openarc.canvas.command({type:'canvas/list'})
                      └─ preload 的 canvas.command  electron/preload.cjs:142
                          └─ IPC canvas:command   electron/canvas-bootstrap.cjs:67-100
                              └─ CanvasService.listCanvases()  electron/canvas-service.cjs:169-191
                                  └─ CanvasStore.boardsOwned/boardsShared/boardsOrg
                                      └─ SQLite canvas_boards  electron/canvas-store.cjs:13-18
```

- `canvas/get`、`canvas/meta`、`canvas/save`、`canvas/command` 走同一条 `canvas:command`；没有第二条 HTTP 路由直接读 `canvas_boards`。
- `/api/canvases` 不是独立后端；bridge 只做形状翻译，身份与会话由主进程注入（`canvas-bootstrap.cjs:74-77`）。

### 1.3 `access.canEdit` 的计算链路

```
CanvasService.#load(context, canvasId, { needEdit })
  └─ #access(context, board)
      ├─ identity.validateSession(sessionRef)                 canvas-service.cjs:54-58
      ├─ store.shareOf({canvasId, userId})                    canvas-service.cjs:63
      └─ domain.evaluateCanvasAccess({actor, entry, share})   canvas-domain.cjs:263-277
          ├─ 无 entry                         → NOT_FOUND
          ├─ actor.isSuper (users.role=ADMIN) → OWNER_ACTIONS, source=SUPER_ADMIN
          ├─ entry.owner_user_id === userId   → OWNER_ACTIONS, source=OWNER_POLICY
          ├─ visibility=ORGANIZATION 且同组织 → PERMISSION_SET.VIEWER, source=ORG_POLICY
          ├─ share.user_id === userId         → VIEWER / CONTRIBUTOR, source=SHARE_<role>
          └─ 否则                             → NO_GRANT
  └─ domain.canView(access) = actions 含 resource.read
  └─ domain.canEdit(access) = actions 含 resource.edit       canvas-domain.cjs:279-280
  └─ #view() 输出 access.canEdit                              canvas-service.cjs:144
```

关键点：

- `OWNER_ACTIONS` 包含全部 resource 动作；`VIEWER_ACTIONS` 不含 `resource.edit`；`CONTRIBUTOR_ACTIONS` 含 `resource.edit`（`authorization-domain.cjs:229-243`）。
- 共享角色 `EDITOR` / `CONTRIBUTOR` 都映射到 `CONTRIBUTOR_ACTIONS`（`canvas-domain.cjs:271-275`）——两者在画布上**能力相同**。
- **不是** `EDITOR_ACTIONS`：后者包含 `resource.delete/restore/share`；若用错，编辑者会获得删画布、改共享的能力。当前映射是对的。
- `access.canEdit` 只由 `resource.edit` 决定；页面只读闸、保存、命令、撤销、AI 运行都看它（见 §2.6）。

### 1.4 现有 share / visibility 能力逐条

| 能力 | 现状 | 证据 | 缺口 |
|---|---|---|---|
| 添加/改共享角色 | **半成品**：`canvas/share` upsert，owner/超管可调用；接受 `VIEWER/CONTRIBUTOR/EDITOR` | `canvas-service.cjs:276-290`；`canvas-bootstrap.cjs:29,98` | 不校验目标账号是否存在/同组织/启用；不审计；无 UI；空 `userId` 会退化成“返回列表” |
| 列出共享 | **半成品**：`canvas/shares`，返回 `shares` 原始行 | `canvas-service.cjs:302-306`；`canvas-bootstrap.cjs:30,99` | 任何能看画布的人都能看全部成员 ID；无显示名/状态；无 UI |
| 移除共享 | **没有**：store 有 `deleteShare`，全仓无调用者/命令 | `canvas-store.cjs:29,124` | 无命令、无审计、无 UI |
| 改角色 | **有（借 upsert）**：`canvas/share` 再调一次即改 | `canvas-store.cjs:26` 的 `ON CONFLICT ... DO UPDATE` | 没有独立的 update 语义/审计；`at` 被覆盖，失去“加入时间” |
| 可见性 | **半成品**：`canvas/visibility` 设 `PRIVATE/ORGANIZATION`；owner/超管 | `canvas-service.cjs:292-300`；`canvas-bootstrap.cjs:31,100` | 非法值静默变 PRIVATE；会改 `updated_at`（见 §6.2）；无 UI；组织可见只给只读 |
| 组织内可见 | **有**：`boardsOrg` 查询 + `ORG_POLICY` | `canvas-store.cjs:18`；`canvas-domain.cjs:269-270` | 与显式共享的优先级错误（§6.1/§1.4 探针） |
| 访问查询（canManage/canShare/owner/visibility） | **没有** | 全仓无 `canvas/access/get` | UI 无法决定“是否显示共享入口” |
| 共享候选人 | **没有** | 全仓无 | UI 只能让用户手填 user id，不可接受 |
| 所有权转移 | **没有** | 全仓无 `canvas/owner/transfer`；store 无 `updateOwner` | 无法安全地把画布交给别人 |
| 审计 | **没有** | 探针后 `authorization_audit` 无任何 `canvas.*` 行 | 共享/可见性/转移不可追溯 |
| 页面侧只读闸 | **有**：`readOnly = !canEdit`，保存/命令/撤销/键盘路径都被拦 | `openarc-bridge.js:21,128,145,190-191`；`openarc-adapter.js:20,37,166-174,210-250`；`openarc-smart-adapter.js:20,84,206-214` | 宿主权限变化后不会重新推（§6.1） |
| 列表共享标识 | **没有** | `CanvasHost.listItem` 丢弃 `shareRole`/`visibility`（`CanvasHost.tsx:248-252`）；`upstreamCanvas` 不含 visibility/shareRole（`:265-277`） | 被共享/组织可见的画布在列表里与自己的画布无区别 |
| 共享 UI | **没有** | 全仓 `canvas/share` / `canvas/shares` / `canvas/visibility` 在 `src`、`src-vue`、`public` 零调用 | 本设计要补的核心 |

### 1.5 Vue 壳的承载层级

```
src-vue/App.vue:171
  └─ WindowLayer.vue                    Vue 壳的窗口层
      └─ <ReactIsland v-else-if="win.appId === 'canvas'">   src-vue/shell/WindowLayer.vue:216
          └─ ReactIsland.vue            Vue 里挂既有 React 组件，display:contents  src-vue/bridge/ReactIsland.vue:6-12
              └─ CanvasHost.tsx         React 岛，持有 iframe / current / 只读上下文
                  └─ <iframe sandbox="allow-scripts allow-same-origin allow-modals">  CanvasHost.tsx:958
                      └─ openarc-canvas://bundle/static/canvas-list.html            CanvasHost.tsx:41
                          └─ 页面内脚本 openarc-bridge.js / openarc-adapter.js / openarc-canvas-guard.js
```

- **iframe 与外壳不同源**（`openarc-canvas://bundle` vs 外壳的 `file://`，见 `CanvasHost.tsx:12-18` 注释与 `:958` 的 sandbox）。因此**父窗口不能直接改 iframe DOM**；共享 UI 只能放在：
  1. `CanvasHost` 的宿主浮层（React 岛内，推荐）；
  2. Vue `WindowLayer` 的窗口叠加层（需要把 current/access 从 React 传到 Vue，成本更高）；
  3. vendored 页面内（改上游页面/适配层，不推荐）。
- 画布窗口是“无 chrome”的：`.window:has([data-canvas-host]) .window-body { margin-top:-44px }` 把 body 上提到窗口顶；标题栏透明且 `z-index:3` 留在上层（`src/styles.css:6848-6871`、`:280-295`）。宿主浮层的坐标与 z-index 必须按这个层级算，否则会被标题栏盖住或压住拖拽区。
- 经典画布页的 `.topbar` 由 guard 下移 44px（`public/novai-canvas/openarc-canvas-guard.js:189-192`）；智能画布顶部按钮是 `top:22px`（`public/novai-canvas/static/css/smart-canvas.css:59-67`）。当前工作树正在 revendor（经典页被删、智能页成为入口），所以宿主入口的精确落点要按实际页面量一次；§5.3 给的是初值，不是已验收坐标。

### 1.6 本机数据库样本（只读）

> 取样：`~/Library/Application Support/openarc-os/identity.db`，`PRAGMA user_version=27`，复制到 `/tmp` 后只读查询（不写产品库）。

| 项 | 实测 |
|---|---|
| `canvas_boards` 行数 | 8 |
| `canvas_boards.visibility` | 8 行全部 `PRIVATE` |
| `canvas_shares` 行数 | 0 |
| `canvases` 行数 | 0 |
| `canvas_members` 行数 | 0 |
| `canvas_invites` / `canvas_invite_members` 行数 | 0 / 0 |
| `resource_registry` 中 `resource_type='canvas'` | 0 |
| 用户 | 2 个，均为 `ADMIN`（同一 team） |
| `authorization_audit` 中 `canvas.*` 动作 | 0 行（总 42 行，均为既有治理动作） |

**推论（需在实现前复核）**：

- 真实库没有任何共享数据，迁移可以安全地加列/回填。
- 两个账号都是 ADMIN（超管），**不能用本机现有第二个账号验证“查看者/编辑者”**；真机验证必须先在“组织”里创建一个 MEMBER 账号（§7 P4）。
- `canvases/canvas_members` 为空，进一步支持“死表”结论；但不能据此断言所有安装都为空（见 §6.6）。

### 1.7 调研探针

`experiments/dxos-canvas-sharing/probe.mjs` 使用 `:memory:` SQLite 构造真实 `CanvasService` + `CanvasStore`，复现以下事实摘要（完整输出见文件注释/运行）：

| 场景 | 探针结果 | 结论 |
|---|---|---|
| owner 创建画布 | `access.canEdit=true, source=SUPER_ADMIN`（admin 是超管） | 正常 |
| alice 被共享 VIEWER | `canEdit=false, source=SHARE_VIEWER`；保存返回 `READ_ONLY` | 只读闸正常 |
| 画布设 `ORGANIZATION` 后再把 alice 共享为 EDITOR | `canEdit=false, source=ORG_POLICY` | **优先级 bug**：显式编辑者被组织只读降级 |
| 把画布共享给外组织成员 bob | `ok:true`；bob `getCanvas` 成功，`source=SHARE_VIEWER`，并出现在 bob 的列表 | **跨组织共享漏洞** |
| 共享给不存在的 user id | `ok:true`，`canvas_shares` 落一行 | **目标不校验** |
| invalid visibility `WHATEVER` | `ok:true`，结果变 `PRIVATE` | 非法值静默兜底 |
| alice（VIEWER）调 `canvas/shares` | 返回全部 4 条共享（含不存在/外组织用户） | **成员列表泄露** |
| 共享/可见性后查 `authorization_audit` | 无 `canvas.*` 行 | **无审计** |

---

## 2. 权限模型提案

### 2.1 角色档位：两档（推荐），不是三档

**推荐：查看者（VIEWER） / 编辑者（EDITOR）两档。所有者（owner）与超管（SUPER_ADMIN）是特权身份，不是共享角色。**

理由：

1. **现有数据/代码就是两档**：`evaluateCanvasAccess` 把 `EDITOR` 和 `CONTRIBUTOR` 都映射为 `CONTRIBUTOR_ACTIONS`，实际能力完全一样（`canvas-domain.cjs:271-275`）。三档会引入一个当前没有语义、也没有测试的角色。
2. **“管理共享”是所有权相邻动作**：`shareCanvas` / `setVisibility` 现在只允许 owner 或 ADMIN（`canvas-service.cjs:281-282,297`）。把“可改共享”下放给非 owner，等于把“谁能看/谁能改”的控制权转交；本地小团队可以用**所有权转移**表达这种委托，不需要第三档。
3. **数据库约束不支持第四种角色**：`canvas_shares.role` 有 `CHECK (role IN ('VIEWER','CONTRIBUTOR','EDITOR'))`（`identity-store.cjs:1188-1195`）。要加 `MANAGER` 必须重建表（SQLite 改 CHECK 只能重建），代价与风险不匹配当前收益。
4. **UI 更简单**：两档就是一个“查看 / 编辑”选择器；三档会引出“编辑者能否改别人角色”“管理共享能否移除所有者”等新问题，产品还没有答案。

**兼容处理**：

- 存储继续接受 `CONTRIBUTOR`（旧数据），读出来归一到 `EDITOR`；新写入只写 `VIEWER` / `EDITOR`。
- 不新增 `MANAGER`；如果以后确实要“可管理共享的协作者”，先做产品决策，再走一次表重建迁移（不在本设计范围）。
- `canvas/share` 的 `role` 必须显式传；`OWNER` / `ADMIN` / 空字符串一律 `INVALID_INPUT`。

### 2.2 与既有 permission set 的映射

| 业务角色 | 存储值 | authorization 集合 | 实际画布能力 | 说明 |
|---|---|---|---|---|
| 所有者 | `canvas_boards.owner_user_id` | `OWNER_ACTIONS`（隐式） | 全部 | 含共享、可见性、转移、删除、永久删除 |
| 超级管理员 | `users.role='ADMIN'` | `OWNER_ACTIONS`（SUPER_ADMIN） | 全部 | 当前是全局特权；列表仍只列“自己的/被共享的/组织可见的” |
| 编辑者 | `canvas_shares.role='EDITOR'`（旧 `CONTRIBUTOR` 归一） | `PERMISSION_SET.CONTRIBUTOR` | 读、改、保存、命令、撤销、运行 AI | 不含 delete / restore / share / manageAccess |
| 查看者 | `canvas_shares.role='VIEWER'` | `PERMISSION_SET.VIEWER` | 读 | 只读 |
| 组织成员（组织可见） | 无 share 行 | `PERMISSION_SET.VIEWER` | 读 | 仅当 `visibility='ORGANIZATION'` 且同组织 |
| 同组织其他成员（私有） | 无 | 无 | 不可见 | 列表不出现；按 id 打开返回 NOT_FOUND_OR_FORBIDDEN |
| 外组织成员 | 无（且不应有 share 行） | 无 | 不可见 | 写入校验 + 读取兜底（§6.1） |

**注意**：编辑者**不是** `PERMISSION_SET.EDITOR`。后者含 `resource.delete/restore/share`（`authorization-domain.cjs:229-243`）。若误用，编辑者会获得删画布/改共享的能力。

### 2.3 权限矩阵

| 主体 | 列表可见 | 打开/读文档 | 保存/编辑/命令/撤销 | 运行 AI 生成 | 回收站 | 恢复 | 永久删除 | 看成员列表 | 改角色/移除 | 改可见性 | 转移所有者 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 所有者 | 是（owned） | 是 | 是 | 是 | 是 | 是 | 是 | 是 | 是 | 是 | 是 |
| 超管 | 只列 owned/shared/org；可按 id 打开任意 | 是 | 是 | 是 | 是 | 是 | 是 | 是 | 是 | 是 | 是 |
| 编辑者 | 是（shared/org） | 是 | 是 | 是（见 Q3） | **否** | 现状可（建议收紧为否） | 否 | 否（提案） | 否 | 否 | 否 |
| 查看者 | 是（shared/org） | 是 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 |
| 组织成员（`ORGANIZATION`，未共享） | 是 | 是 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 |
| 同组织其他成员（`PRIVATE`，未共享） | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 |
| 外组织成员 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 |
| 未登录/已停用 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 | 否 |

实现口径：

- `canView = actions.includes('resource.read')`
- `canEdit = actions.includes('resource.edit')`
- `canManage = actions.includes('resource.manageAccess')`（owner/super；未来 MANAGER 也走这里）
- `canTrash = actions.includes('resource.delete')`
- `canRestore = actions.includes('resource.restore')`
- `canPurge = actions.includes('resource.permanentDelete')`
- `canShare = actions.includes('resource.share')`（owner/super；编辑者没有）

**回收站说明**：现状 `restoreCanvas` 只要求 `needEdit`（`canvas-service.cjs:259-263`），所以编辑者可以恢复被删画布；`trashCanvas` 额外要求 `resource.delete` 或 owner（`:252-257`），编辑者不能删。建议 v1 先把“恢复”也收紧为 `canRestore`（owner/super），但这属于行为变化，需要用户确认；如果不想扩大改动，可保持现状并在文档标注。

### 2.4 与 `visibility=ORGANIZATION` 的关系

- `ORGANIZATION` 是**访问底线**，不是角色：组织内所有 ACTIVE 成员获得 `VIEWER`（只读），不会获得编辑/共享/删除。
- 显式共享是**加码**：组织可见 + 被共享为 `EDITOR` → 编辑者；组织可见 + 被共享为 `VIEWER` → 查看者（不降级，也不升级）。
- **必须修优先级**：当前 `evaluateCanvasAccess` 先判 `ORG_POLICY`，再判 `share`（`canvas-domain.cjs:269-275`），导致编辑者被降级。正确顺序：
  1. `SUPER_ADMIN`
  2. `OWNER_POLICY`
  3. `SHARE_<role>`（显式授权优先）
  4. `ORG_POLICY`
  5. `NO_GRANT`
- 组织可见**不应**提供“组织内可编辑”的开关。要编辑就显式共享为编辑者；这能保证“谁改了我的画布”可解释。
- UI 文案用“组织内可查看”，不用“公开”——本产品没有公开链接/外发共享。

### 2.5 所有者与超管特权

- 所有者：全部能力；可以转移所有者；可以删除/恢复/永久删除；可以改可见性。
- 超管：沿用现状，拥有 `OWNER_ACTIONS`；可以按 id 打开任意画布并管理共享；但**列表仍只返回 owned/shared/org**，不新增“管理员浏览全部私有画布”的面。理由：本地隐私边界，避免超管变成默认的“看所有人的私有画布”。
- 超管操作也要审计，且 `permission_source='SUPER_ADMIN'`；不能因为“管理员”就跳过审计。
- 所有权转移：只有当前 owner 或超管可以发起；目标必须是同组织 ACTIVE 成员；转移后旧 owner 降为 `EDITOR`（保留协作能力，但不再能管理共享），目标用户原有的 share 行删除；审计两行（旧 owner 撤销 / 新 owner 授予）。

### 2.6 只读画布与角色配合

- 页面侧只读闸的事实来源是 `canEdit`：宿主 `hello/context` 推 `{canEdit, readOnly:!canEdit}`（`CanvasHost.tsx:324-326,737-744`），bridge 保存 `ctx.readOnly`（`openarc-bridge.js:21,128,145`），adapter 在保存/命令/撤销/键盘路径拒绝（经典 `openarc-adapter.js:20,37,166-174,210-250`；智能 `openarc-smart-adapter.js:20,84,206-214`）。
- 后端是权威：`#load(needEdit)` 对 `saveCanvas/applyCommand/undoLastCommand/startRun/modelCall/modelChatStream/finishRun/importAsset` 等统一返回 `READ_ONLY`（`canvas-service.cjs:72-81` 及各处调用）。共享不能新增任何绕过 `#load(needEdit)` 的写路径。
- 查看者/组织成员：`canEdit=false` → 页面只读；宿主显示“只读共享/组织内可查看”徽标；不显示编辑控件。
- 编辑者：`canEdit=true` → 页面可编辑；宿主显示“编辑者”；不显示共享管理按钮（只有 owner/super 有）。
- 所有者/超管：页面可编辑；宿主显示“共享”入口。
- 权限变化（降级/撤销）：宿主必须在轮询中比较 `access`，重新 `pushContext`，并关闭/切换共享面板（§6.2）。

---

## 3. 数据模型

### 3.1 沿用 `canvas_boards` + `canvas_shares`，不新增表

- 画布身份、文档、版本、可见性继续在 `canvas_boards`。
- 共享继续在 `canvas_shares`；它的主键 `(canvas_id,user_id)` 已经保证“一人一角色”，不需要新表。
- 不引入 `canvas_members` / `canvases`；不引入 `canvas_share_events`（历史用 `authorization_audit`）。
- 不把共享写进 `doc` JSON：共享是权限元数据，不能被文档保存/命令层覆盖。

### 3.2 表、字段、约束

#### `canvas_boards`（不变，补索引）

| 字段 | 现状 | 本次是否改 | 说明 |
|---|---|---|---|
| `id` | TEXT PK | 否 | `cv_...` |
| `organization_id` | TEXT NOT NULL | 否 | 同组织校验用 |
| `owner_user_id` | TEXT NOT NULL | 否 | 转移时 UPDATE |
| `name/icon/kind` | 不变 | 否 | |
| `doc` | TEXT JSON | 否 | 共享不碰 |
| `revision` | INTEGER DEFAULT 1 | 否 | 共享/可见性不 bump（避免保存基线冲突） |
| `visibility` | TEXT DEFAULT 'PRIVATE'，无 CHECK | **服务层校验** | 只允许 `PRIVATE/ORGANIZATION` |
| `updated_at` | INTEGER | **共享/可见性/转移不更新** | 见 §6.2；否则会破坏页面 `base_updated_at→revision` 映射 |
| `deleted_at/deleted_by` | 不变 | 否 | 回收站保留共享行 |

新增索引：

```sql
CREATE INDEX IF NOT EXISTS idx_canvas_boards_org_visibility
  ON canvas_boards(organization_id, visibility);
```

`boardsOrg` 的查询条件就是 `organization_id + visibility='ORGANIZATION'`（`canvas-store.cjs:18`），现有 `idx_canvas_boards_org` 只覆盖前半。

#### `canvas_shares`（沿用，补 `created_at`）

| 字段 | 现状 | 本次 | 说明 |
|---|---|---|---|
| `canvas_id` | TEXT NOT NULL | 不变 | 与 `canvas_boards.id` 对应；无 FK |
| `user_id` | TEXT NOT NULL | 不变 | 本地用户 id |
| `role` | TEXT CHECK `VIEWER/CONTRIBUTOR/EDITOR` | 写入归一 `VIEWER/EDITOR` | 旧 `CONTRIBUTOR` 读出当 `EDITOR` |
| `granted_by` | TEXT | 不变 | 最近一次操作人 |
| `at` | INTEGER NOT NULL | 语义改为“最近变更时间” | 原 upsert 会覆盖；保留 |
| **`created_at`** | 无 | **新增 INTEGER NOT NULL DEFAULT 0** | “何时加入共享”；迁移回填 `created_at = at` |
| 主键 | `(canvas_id,user_id)` | 不变 | 一人一角色 |
| 索引 | `idx_canvas_shares_user(user_id)` | 不变 | 查“共享给我的画布” |
| 外键 | **无** | 本次不加（SQLite 加 FK 需重建表） | 由 `purgeCanvas` 事务清理；见 §3.4 |

不建议加 `updated_by` / `revoked_at`：当前 `granted_by + at + authorization_audit` 足够回答“谁在什么时候改了什么”；历史在审计里，不在当前表里。

### 3.3 迁移 v28

当前真实库 `PRAGMA user_version=27`。建议新增 v28（重放安全，和 v17 一样先查 `PRAGMA table_info`）：

```sql
-- 仅当 canvas_shares 缺列时执行
ALTER TABLE canvas_shares ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
UPDATE canvas_shares SET created_at = at WHERE created_at = 0;

CREATE INDEX IF NOT EXISTS idx_canvas_boards_org_visibility
  ON canvas_boards(organization_id, visibility);
```

约束：

- 必须在 `identity-store.cjs` 的迁移阶梯里追加 v28，不改旧 v17 条目。
- 迁移是幂等的：重复执行时 `PRAGMA table_info(canvas_shares)` 已有 `created_at` 就跳过 ALTER；`UPDATE ... WHERE created_at=0` 对已回填行是 no-op。
- 空表（本机 0 行）无回填成本；有数据的安装保留原 `at` 作为加入时间。
- 不改 `canvas_members` / `canvases`；它们保持 0 行/原样。
- 只加列/索引，旧代码会忽略 `created_at`；回退代码不需要 down migration（前向迁移框架本身也不提供 down）。
- 若某安装的 `canvas_members` 非空：**不要自动导入**。它没有角色、没有授予人、没有来源，自动导入会制造无法解释的权限。先做一次只读盘点，再由产品决定是否一次性导入为 `VIEWER`（本设计不包含）。

### 3.4 生命周期与孤儿清理

- **软删除（回收站）**：保留 `canvas_shares`，恢复后共享关系仍在；列表查询已过滤 `deleted_at`（`canvas-store.cjs:14-18`）。
- **永久删除 `purgeCanvas`**：当前只 `DELETE FROM canvas_boards`（`canvas-store.cjs:24,115`；`canvas-service.cjs:265-273`）。因为 `canvas_shares` 没有 FK，会留下孤儿行。P1 必须在同一个事务里先 `DELETE FROM canvas_shares WHERE canvas_id=?`；同样建议清理 `canvas_commands`/`canvas_runs`/`canvas_run_facts`（现有孤儿问题，至少共享行必须清）。
- **所有权转移**：同一事务内更新 `owner_user_id`、删除目标用户原 share 行、把旧 owner upsert 为 `EDITOR`。不要 bump `revision`/`updated_at`（见 §6.2）。
- **目标账号停用/删除**：share 行保留（历史），访问由 session 校验拒绝；成员列表显示“已停用/账号不存在”，owner 可移除。

### 3.5 不新增表 / 不迁移的理由

- 共享是 `(canvas,user,role)` 的简单关系，`canvas_shares` 足够；新增事件表会与 `authorization_audit` 形成两套历史。
- `canvases/canvas_members` 是 DXOS 死表；迁移它们等于把死模型复活，且会与 `canvas_boards` 产生第二套 ID/文档/可见性。
- `canvas_invites` 是“邀请码”模型（`code_hash` / `permission read/edit`），与“本机同组织账号共享”不是同一产品语义；本设计明确不做邀请码/外发链接。

**明确结论**：`canvas_members` 废弃（不读、不写、不迁移、不做“成员同步”）；`canvases` 同理；唯一的共享表是 `canvas_shares`。如果未来 DXOS 侧要用 `canvases`，必须单独立项做映射，不能把它接进本设计。

---

## 4. 命令契约

### 4.1 Envelope、身份、审计约定

- 通道：仍然是**唯一**的 `canvas:command`（`electron/canvas-bootstrap.cjs:67`）。新命令必须显式加入 `RENDERER_COMMANDS`（`:19-50`），否则返回 `CANVAS_COMMAND_NOT_ALLOWED`（`:51,73,154`）。
- 形状：渲染层 `{ type: 'canvas/xxx', ...payload }`；bootstrap 取 `raw.command || raw.type`，payload 为 `raw.payload || raw`（`:71-75`）。返回继续用 `{ok:true,...}` / `{ok:false,error,detail}`（`canvas-service.cjs:18-19`）。
- 身份：`context.sessionRef` 只来自主进程当前 session；payload 里的 `userId/owner/sessionRef` 一律忽略（`canvas-bootstrap.cjs:74-77`）。所有新命令只接受 `canvasId` / `targetUserId` 这类**对象 id**，不接受调用者自报身份。
- 审计：复用 `AuthorizationStore.auditAuthorization`（`electron/authorization-store.cjs:545-597`；表 `authorization_audit` `identity-store.cjs:325-343`）。写入字段：
  - `actor_user_id` = 当前用户
  - `target_user_id` = 被共享/被移除/新 owner
  - `app_id` = `'canvas'`
  - `resource_ref` = `'canvas:' + canvasId`（不是 `res_`，`toResourceRef` 会原样保留字符串）
  - `action` = `canvas.share.grant` / `canvas.share.update` / `canvas.share.revoke` / `canvas.visibility.set` / `canvas.owner.revoke` / `canvas.owner.grant`
  - `decision` = `ALLOW` / `DENY`
  - `reason_code` = `OK` / `READ_ONLY` / `INVALID_INPUT` / `NOT_FOUND`
  - `permission_source` = `OWNER_POLICY` / `SUPER_ADMIN`
  - `request_id` = `context.requestId`
  - `old_permissions/new_permissions` = `[旧角色]` / `[新角色]`（可见性用 `['PRIVATE']` / `['ORGANIZATION']`）
- **事务**：写共享 + 写审计必须在同一个 `store.transactSync` 内；审计失败要能让整个操作失败（见 §6.3 的 strict 提案）。
- **不改 `updated_at/revision`**：共享、可见性、所有权转移都不碰文档版本/更新时间；否则会打断页面保存基线（§6.2）。

### 4.2 命令总表

| 命令 | 状态 | 权限 | 用途 |
|---|---|---|---|
| `canvas/share` | 已有，扩展 | `canManage` | 新增或改角色（upsert）；**不再新增 `canvas/share/update`** |
| `canvas/share/remove` | **新增** | `canManage` | 移除一个成员 |
| `canvas/shares` | 已有，收紧+扩展 | `canManage` | 成员列表 + owner + visibility |
| `canvas/share/candidates` | **新增** | `canManage` | 同组织 ACTIVE 账号候选（排除 owner 和已共享） |
| `canvas/access/get` | **新增** | `canView` | 当前用户对这本画布的 access/capabilities |
| `canvas/visibility` | 已有，修正 | `canManage` | 设置 `PRIVATE/ORGANIZATION`；非法值拒绝 |
| `canvas/owner/transfer` | **新增** | `canManage`（owner/超管） | 转移所有权 |
| `canvas/get` / `canvas/meta` | 已有，扩展 | `canView` | 视图里补 `access.canManage/canShare`、`visibility` |

**为什么不加 `canvas/share/update`**：`canvas/share` 的既有语义就是 upsert（`canvas-store.cjs:26` 的 `ON CONFLICT ... DO UPDATE`）。再加一个 update 会产生两个入口、两套审计动作，且无法回答“调用方到底想新增还是改角色”。保留一个 upsert，用返回的 `changed: 'CREATED'|'UPDATED'` 区分。

**为什么保留 `canvas/visibility` 而不是改名为 `canvas/visibility/set`**：它已经在白名单和测试里；当前 renderer 零调用，改名没有收益，反而增加迁移面。语义就是“设置”，文档里写清楚即可。

### 4.3 命令详情

#### 4.3.1 `canvas/share`

**Payload**

```json
{
  "type": "canvas/share",
  "canvasId": "cv_...",
  "userId": "usr_...",
  "role": "VIEWER" | "EDITOR"
}
```

**返回**

```json
{
  "ok": true,
  "changed": "CREATED" | "UPDATED",
  "share": { "userId": "...", "role": "EDITOR", "createdAt": 0, "at": 0 },
  "shares": [ /* 同 canvas/shares 的 ShareView[] */ ]
}
```

**校验 / 错误**

| 条件 | 结果 |
|---|---|
| 画布不存在/已删 | `NOT_FOUND` |
| 当前用户看不到画布 | `NOT_FOUND_OR_FORBIDDEN` |
| 当前用户不是 owner/超管 | `READ_ONLY`，`detail=access.source` |
| `role` 不是 VIEWER/EDITOR（含 `OWNER`、`ADMIN`） | `INVALID_INPUT`，`detail='role'` |
| `userId` 为空 | `INVALID_INPUT`，`detail='target'`（不再退化成“返回列表”） |
| 目标是 owner | `INVALID_INPUT`，`detail='owner'` |
| 目标不存在 | `INVALID_INPUT`，`detail='target'` |
| 目标已停用 | `INVALID_INPUT`，`detail='target-disabled'` |
| 目标不在同组织 | `INVALID_INPUT`，`detail='target-org'` |
| 目标已经是该角色 | `ok:true, changed:'UPDATED'`（幂等） |

**实现要点**

- 先 `#load(context, canvasId)` 拿到 view 权限，再用 `canManage` 判权；**不要**用 `needEdit` 代替（编辑者 canEdit 但不应能共享）。
- 目标校验用 `identity.userById(target)`，检查 `status==='ACTIVE'` 且 `team_id === board.organization_id`；这三个条件缺一不可。
- `role` 归一：`CONTRIBUTOR → EDITOR`；`VIEWER/EDITOR` 保留。
- `store.upsertShare` + `auditAuthorization` 同一事务；审计 `oldPermissions` 取 upsert 前的 share 行（没有则 `[]`）。
- 返回的 `shares` 用 `#shareViews(canvasId)` 富化显示名/状态，但**不返回**密码/邮箱/其他敏感字段。

#### 4.3.2 `canvas/share/remove`

**Payload** `{ type, canvasId, userId }`

**返回** `{ ok, removed: true|false, shares: [...] }`

**规则**

- `canManage`；不能移除 owner（`INVALID_INPUT detail='owner'`）。
- 幂等：目标本来没有 share → `ok:true, removed:false`，不写审计（或写 `DENY? no`；建议不写，避免噪声）。
- 成功：`deleteShare` + 审计 `canvas.share.revoke`，`oldPermissions=[旧角色]`，`newPermissions=[]`。
- 不能通过此命令“移除自己把画布删了”；只是移除共享。

#### 4.3.3 `canvas/shares`

**Payload** `{ type, canvasId }`

**返回**

```json
{
  "ok": true,
  "canvasId": "cv_...",
  "visibility": "PRIVATE" | "ORGANIZATION",
  "owner": { "userId": "...", "displayName": "...", "username": "...", "status": "ACTIVE" },
  "shares": [
    {
      "userId": "...",
      "displayName": "...",
      "username": "...",
      "role": "VIEWER" | "EDITOR",
      "grantedBy": "...",
      "grantedByName": "...",
      "createdAt": 0,
      "at": 0,
      "status": "ACTIVE" | "DISABLED" | "MISSING"
    }
  ],
  "canManage": true
}
```

**规则**

- **收紧**：只有 `canManage` 能拿到完整成员列表；查看者/编辑者调用返回 `READ_ONLY`（detail=access.source）。查看者要知道“我是谁共享的”用 `canvas/access/get`（给 owner + 自己的 role，不给其他成员）。
- 无审计（只读）。
- `status` 来自 `identity.userById`：`ACTIVE/DISABLED`，找不到则 `MISSING`；`MISSING` 仍显示（历史），但不可再改角色，只能移除。

#### 4.3.4 `canvas/share/candidates`

**Payload** `{ type, canvasId, query?: string, limit?: number }`

**返回**

```json
{
  "ok": true,
  "items": [
    { "userId": "usr_...", "displayName": "...", "username": "...", "status": "ACTIVE" }
  ]
}
```

**规则**

- `canManage`。
- 只返回**同组织、ACTIVE**、非 owner、且当前不在 `canvas_shares` 里的用户。
- `query` 按 `display_name` / `identifier` 做大小写不敏感包含匹配；`limit` 1..50，默认 20。
- 不返回邮箱/密码/角色细节；`username` 是本地账号标识（与 `identity/users-list` 的 `username` 同源，`local-account-service.cjs:252-269,461-463`）。
- 无审计（读）。

#### 4.3.5 `canvas/access/get`

**Payload** `{ type, canvasId }`

**返回**

```json
{
  "ok": true,
  "canvasId": "cv_...",
  "visibility": "PRIVATE" | "ORGANIZATION",
  "owner": { "userId": "...", "displayName": "...", "status": "ACTIVE" },
  "share": { "role": "VIEWER" | "EDITOR" } | null,
  "access": {
    "canView": true,
    "canEdit": false,
    "canManage": false,
    "canShare": false,
    "canTrash": false,
    "canRestore": false,
    "canPurge": false,
    "source": "OWNER_POLICY" | "SUPER_ADMIN" | "ORG_POLICY" | "SHARE_VIEWER" | "SHARE_EDITOR" | "SHARE_CONTRIBUTOR" | "NO_GRANT"
  }
}
```

**规则**

- `canView` 即可调用；无 view → `NOT_FOUND_OR_FORBIDDEN`。
- 不给成员列表；只给 owner + 自己的 share 角色。
- 无审计。
- `canManage` 由 `resource.manageAccess` 推导，而不是再写一套 `if owner`（避免与将来 MANAGER 分叉）。
- 旧 `CONTRIBUTOR` 行在读取时归一为 `EDITOR`；在归一完成前，`source` 可能短暂出现 `SHARE_CONTRIBUTOR`，UI 必须按“编辑者”展示，不能显示原始码。

#### 4.3.6 `canvas/visibility`

**Payload** `{ type, canvasId, visibility: 'PRIVATE' | 'ORGANIZATION' }`

**返回** `{ ok, canvas: { ...view } }`

**规则**

- `canManage`；owner/超管。
- 只接受两个字面值（大小写归一）；其他 → `INVALID_INPUT detail='visibility'`，**不再静默变 PRIVATE**。
- 更新 `visibility`，**不更新 `updated_at` / `revision`**。
- 审计 `canvas.visibility.set`：`oldPermissions=[旧值]`，`newPermissions=[新值]`。
- 组织可见的语义：组织内 ACTIVE 成员只读；已显式共享的编辑者不受影响（§2.4）。

#### 4.3.7 `canvas/owner/transfer`

**Payload** `{ type, canvasId, newOwnerUserId }`

**返回** `{ ok, canvas: {...view}, shares: [...] }`

**规则**

- 只有当前 owner 或超管；否则 `READ_ONLY`。
- 目标不能是当前 owner（`INVALID_INPUT detail='owner'`）、必须存在/ACTIVE/同组织。
- 单个事务：
  1. `UPDATE canvas_boards SET owner_user_id=? WHERE id=?`（**不更新 updated_at/revision**）
  2. 删除目标用户原 share 行（新 owner 不需要共享）
  3. 旧 owner upsert 为 `EDITOR`（若旧 owner === 目标则跳过）
  4. 审计两行：`canvas.owner.revoke`（target=旧 owner，old=['OWNER']，new=['EDITOR']）与 `canvas.owner.grant`（target=新 owner，old=[]，new=['OWNER']）
- 返回新视图；旧 owner 若仍在画布打开，下一次 `canvas/meta` 会得到 `canManage=false`，共享面板应切成只读。
- 不允许把所有权转给已停用/外组织/不存在的账号。

#### 4.3.8 既有 `canvas/get` / `canvas/meta` 的扩展

- `#view().access` 增加 `canManage`、`canShare`（由 actions 推导）。
- `metaCanvas` 增加 `visibility` 和 `access.canManage`，让宿主轮询能感知可见性/管理权变化（见 §6.2）。
- 不改变 `access.canEdit` 的语义；只加字段。

### 4.4 错误码表

| 错误 | 何时 | 前端文案（建议） |
|---|---|---|
| `NOT_FOUND` | 画布不存在/已永久删除 | “画布不存在或已被删除” |
| `NOT_FOUND_OR_FORBIDDEN` | 当前用户无 view | “这本画布已不可访问（可能被移出共享）” |
| `READ_ONLY` | 非 owner/超管尝试共享/可见性/转移；编辑者/查看者写 | “只有所有者可以修改共享设置” / “你对这本画布只有查看权限” |
| `INVALID_INPUT` detail `role` | 角色非法 | “请选择查看者或编辑者” |
| `INVALID_INPUT` detail `target` | 目标不存在/为空 | “没有找到这个成员” |
| `INVALID_INPUT` detail `target-disabled` | 目标已停用 | “该账号已停用，不能共享” |
| `INVALID_INPUT` detail `target-org` | 目标外组织 | “只能共享给本组织的成员” |
| `INVALID_INPUT` detail `owner` | 目标是 owner / 转移给自己 | “不能对所有者执行这个操作” |
| `INVALID_INPUT` detail `visibility` | 可见性非法 | “可见性只有私有/组织内可查看” |
| `CANVAS_COMMAND_NOT_ALLOWED` | 命令未登记 | 不展示原始码；记录日志 |
| `INTERNAL_ERROR` | bootstrap catch | “操作失败，请重试” |

### 4.5 审计映射

| 操作 | action | target_user_id | old_permissions | new_permissions |
|---|---|---|---|---|
| 新增共享 | `canvas.share.grant` | 被共享人 | `[]` | `['VIEWER' 或 'EDITOR']` |
| 改角色 | `canvas.share.update` | 被共享人 | `['旧角色']` | `['新角色']` |
| 移除共享 | `canvas.share.revoke` | 被移除人 | `['旧角色']` | `[]` |
| 改可见性 | `canvas.visibility.set` | null | `['PRIVATE' 或 'ORGANIZATION']` | 新值 |
| 转移：旧 owner | `canvas.owner.revoke` | 旧 owner | `['OWNER']` | `['EDITOR']` |
| 转移：新 owner | `canvas.owner.grant` | 新 owner | `[]` | `['OWNER']` |
| 拒绝的写尝试 | 对应 action | 目标（若有） | — | —（`decision='DENY', reason_code='READ_ONLY'`） |

`permission_source` 取 `access.source`（`OWNER_POLICY/SUPER_ADMIN`）；`app_id='canvas'`；`resource_ref='canvas:'+canvasId`。

### 4.6 兼容与废弃

- `canvas/share` 空 `userId` 的旧行为（返回列表）**移除**；列表统一走 `canvas/shares`。这是内部 IPC，当前无 UI 调用，风险低。
- `canvas/shares` 对非管理者从“可读”改为 `READ_ONLY`；当前无 UI 调用，风险低。
- `CONTRIBUTOR` 继续可读可写（归一 `EDITOR`）；不强制迁移旧行。
- `canvas/visibility` 非法值从“静默 PRIVATE”改为 `INVALID_INPUT`；当前无 UI 调用，测试需更新（现有测试未覆盖该命令）。
- 不新增 `canvas/share/update`；不新增 `canvas/visibility/set`；不新增第二通道。

---

## 5. UI 方案

### 5.1 入口放哪里：三个候选的结论

| 候选 | 可行性 | 结论 |
|---|---|---|
| **画布列表卡片菜单**（vendored `canvas-list.html` 的 `.card-more-menu`，现有“重命名/复制/删除”） | 需要改 `public/novai-canvas/static/canvas-list.html`，并在 bridge 增加 `/api/canvases/:id/shares` 路由；页面用上游 Tailwind/`--v4-*` 样式，和 OpenArc 设计语言不是一套；当前该文件还有别的会话未提交改动 | **不推荐作为 v1**。可作为 P3 可选入口（只加菜单项，点击后 postMessage 让宿主开同一个面板，不在页面里画共享 UI） |
| **画布内顶栏 / 右上角宿主浮层**（CanvasHost） | iframe 与外壳跨源，父窗口不能改页面 DOM；但宿主可以在 iframe 上叠加自己的 UI；CanvasHost 已持有 `current`、`canvasCmd`、`pushContext` | **推荐**。入口/面板都在宿主，零 vendored 页面改动，设计 token 可直接复用 |
| **Vue 壳右侧面板**（WindowLayer 级） | 需要把 CanvasHost 的 `current/canManage` 状态经 store/事件传到 Vue；多一层状态桥，且窗口级面板与画布窗口生命周期耦合 | **不推荐 v1**。如果以后要做“全局共享管理”，再单独设计；当前 CanvasHost 内浮层已满足 |

**推荐：方案 B（画布内宿主浮层）**。列表侧可作为后续“发现性”增强，不阻塞 v1。

### 5.2 方案 A（列表侧）细节与代价

- 在 `canvas-list.html:1265-1277` 的卡片菜单里加“共享”，点击后：
  - 若在页面内画：需要新增一套成员列表/角色/可见性 UI，和页面已有的重命名 modal 风格一致，但**不是** OpenArc 设计系统；
  - 若只做入口：postMessage 给宿主 `{kind:'open-share', canvasId}`，宿主打开同一个共享面板；仍需改 vendored 页面 + bridge + host 监听。
- 代价：改上游页面（并发冲突风险）、无法复用 Vue/React 设计组件、需要页面级 e2e、未来每次 vendor 升级都要重放补丁。
- 收益：用户在列表就能共享，不必先打开画布。
- **结论**：收益不足以抵消成本；v1 不做。若用户坚持，作为 P3 独立包，只做“菜单项 + 宿主面板”，共享 UI 不落在页面里。

### 5.3 方案 B（画布内宿主浮层，推荐）

#### 布局

```
┌──────────────────────────────────────────────┐
│ ● ● ●                         [共享]  ← 宿主入口（右上角，页面工具栏同一行）
│                                              │
│   vendored 画布页（iframe）                   │
│                                              │
│                                   ┌────────┐ │
│                                   │ 共享面板 │ │
│                                   │ 340px  │ │
│                                   └────────┘ │
└──────────────────────────────────────────────┘
```

- **入口位置**：画布窗口右上角，与页面顶部工具条同一行。
  - 初值：经典页 `.topbar` 由 guard 下移 44px，页面按钮约在窗口坐标 `44+22=66px`；智能画布顶部按钮自身是 `top:22px`，需按实际 guard/标题栏偏移实测。最右侧页面按钮的右边缘距窗口右边约 130px（`smart-canvas.css:63-67`：`right:130px; width:96px`）。
  - 宿主入口初值 `top:66px; right:16px`，宽约 88–96px；与页面最右按钮之间约 18–22px。窄窗（≤760px）页面按钮收成 40px、最右 `right:62px`，宿主入口收成 40px 图标按钮（`right:12px`），约 50px 间距。**最终坐标以浅/深色实机截图为准**；不要把初值写死成“已验收”。
  - 入口是宿主 overlay（`z-index:2`，在 iframe 之上、标题栏之下），不修改页面 DOM；点击不触发标题栏拖拽。
  - 如果页面未来改版导致碰撞：入口位置集中在 CSS 变量/一个 class，实机截图后调整；不要用“盖住页面按钮”的方式解决。
- **面板位置**：右侧浮层，`top:66px; right:12px; bottom:12px; width:340px`；`border-radius: var(--radius-xl)`；不遮住左侧画布主体；不设全屏遮罩（非模态）。
- **层级**：面板 `z-index:3`（在 iframe/入口之上）；不压住标题栏红绿灯（标题栏 `z-index:3`，面板从 top:66 开始，已避开 44px 标题栏）。如果实测发现标题栏要盖住面板顶部，改为 `top:52px` 并留 8px。
- **入口可见性**：
  - owner/超管：显示“共享”按钮（`Share2` 图标 + 文字）。
  - 编辑者/查看者：显示状态徽标（“编辑者”/“只读共享”/“组织内可查看”），点击打开只读信息面板；不显示可编辑控件。
  - 未打开画布（列表页）：不显示；宿主在收到页面 `canvas.list` 时清空 `current`（见 §6.2）。

#### 面板信息架构

```
共享 “画布标题”                           [×]
────────────────────────────────────────────
访问权限
[ 仅自己 ] [ 组织内可查看 ]        ← segmented.text
说明：组织内所有成员都能打开查看，但不能编辑；
      被单独共享为编辑者的人仍可编辑。

成员
┌──────────────────────────────────────────┐
│ 所有者  李伟平  @liweiping      所有者     │
├──────────────────────────────────────────┤
│ 张测试  @zhang    [编辑者 ▾]  加入于 10-17  [移除] │
│ 王五    @wang     [查看者 ▾]  加入于 10-16  [移除] │
└──────────────────────────────────────────┘
[ + 添加成员 ]
  搜索/选择成员 [.............]  角色 [查看者 ▾] [添加]
────────────────────────────────────────────
空态：还没有共享给任何人。
错误：……（带重试）
```

#### 状态与交互

| 状态 | 呈现 | 行为 |
|---|---|---|
| 加载中 | 面板骨架（3 行），入口禁用 | 不显示假数据 |
| 无共享 | 成员区空态 + “添加成员” | 组织可见开关仍可用 |
| 添加成员 | 搜索框（`ds-search`）+ 候选下拉 + 角色选择 + 添加 | 候选只来自 `canvas/share/candidates`；选中后清空搜索 |
| 改角色 | 行内 `select`（查看者/编辑者） | 保存中禁用该行；失败回滚并显示行内错误 |
| 移除 | 行内两步确认：“移除？[移除][取消]” | 成功后从列表移除；失败保留 |
| 可见性切换 | `.segmented.text` | 保存中禁用；失败回滚；切换为 ORGANIZATION 时显示说明 |
| 只读用户 | 隐藏所有管理控件；显示 owner + 你的角色 + “只有所有者可以管理共享” | 仍可打开/关闭 |
| 被撤销权限 | 面板关闭；入口消失；若画布已打开，推 `readOnly=true` 并提示 | 见 §6.2 |
| 目标已停用/不存在 | 行内徽标“已停用/账号不存在”；角色选择禁用；移除可用 | 不伪造“已移除” |
| 并发冲突（owner 变了） | 重新加载后切只读；提示“共享设置已被其他操作更新” | 以服务端返回为准 |

#### 只读用户看到的呈现

- 不在画布上盖大横幅（DESIGN_SYSTEM §9：画布内容保持完整可读）。
- 右上角一个中性徽标：
  - `SHARE_VIEWER` → “只读共享”
  - `ORG_POLICY` → “组织内可查看”
  - `SHARE_EDITOR` → “编辑者”
  - `OWNER_POLICY/SUPER_ADMIN` → “所有者/管理员”
- 点击徽标打开只读面板：显示 owner、你的角色、可见性；没有添加/改角色/移除/可见性控件。
- 页面自己的只读闸继续工作（`html[data-openarc-readonly="1"]`，`smart-canvas.js:35091`）；宿主不重复实现一套禁用逻辑，避免两套真相。

#### 错误与空态文案

- 加载失败：`.gov-error` 行内错误 + “重试”；不自动弹 toast（错误不能只存在于会消失的通知里）。
- `READ_ONLY`：行内“只有所有者可以修改共享设置”（不是红色大字）。
- `NOT_FOUND_OR_FORBIDDEN`：整面板“这本画布已不可访问（可能被移出共享）”，关闭入口。
- 候选为空： “没有匹配的成员” / “组织里的成员都已加入”。
- 搜索无结果： “没有找到这个成员”；不要显示“邀请”或“外部共享”。

### 5.4 设计语言复用

| 用途 | 复用 | 位置 |
|---|---|---|
| 面板表面 | `rgb(var(--surface-rgb) / var(--surface-alpha))` + `backdrop-filter: var(--glass-filter)` + `box-shadow: var(--shadow)` + `border-radius: var(--radius-xl)` | token 定义 `src/design-system/tokens.css`；同类侧浮层 `.ai-panel` `src/styles.css:1398-1413` |
| 入口按钮 | `.ds-btn` / `.ds-btn--secondary` / `.ds-iconbtn--secondary`；图标 16px | `src/design-system/primitives.css:38-165` |
| 分段控件 | `.segmented.text`（`aria-pressed`） | `src/styles.css:967-997` |
| 成员行 | `.gov-row` / `.gov-name` / `.gov-meta`（已有中性低对比底，不加新色） | `src/styles.css:2927-2932` |
| 徽标 | `.ds-badge` + `ds-badge--sm` / `ds-badge--neutral` | `primitives.css:355-383` |
| 输入/搜索 | `.ds-field` / `.ds-search` | `primitives.css:169-290` |
| 错误 | `.gov-error` / `.ds-field__error` | `styles.css:2932`；`primitives.css:219-247` |
| 字号/字重 | `--fs-title/--fs-heading/--fs-body/--fs-secondary/--fs-caption`；字重只用 400/500 | `tokens.css`；DESIGN_SYSTEM §5 |
| 圆角/间距 | `--radius-xl/--radius-lg/--radius-md/--radius-sm`；`--space-*` | `tokens.css:157-174` |
| 动效 | 面板 `opacity 0→1 + translateX(16px→0)`，220ms `--standard` `--ease`；关闭 160ms；`.reduced`/系统偏好归零 | MOTION_SYSTEM §5（Drawer 220ms）、§8；`tokens.css:401-425` |
| 焦点 | 2px 中性焦点环，2px 间隔；Esc 关闭、焦点返回入口 | DESIGN_SYSTEM §7/§10 |

**不新增颜色/圆角/阴影**：面板只消费 token；如果实现时发现需要新值，先在 `tokens.css` 加，不在组件里写十六进制。

### 5.5 无障碍、窄窗与验收基准

- 面板：`role="complementary"`（非模态侧栏），`aria-labelledby` 指向标题；打开后焦点进入第一个可操作项；Esc 关闭；关闭后焦点回到入口按钮。
- 非模态：不做全屏焦点陷阱；但 Tab 顺序限制在面板内是可接受的（非模态不强制）。如果实现选择模态，则必须加焦点陷阱 + 背景不可操作（`DsDialog` 已有做法）。
- 角色 `select` 有可访问名称（“张测试的角色”）；移除按钮有 `aria-label`（“移除张测试的共享”）；颜色不单独承担状态（徽标带文字）。
- 窄窗：≤760px 入口变 40px 图标按钮；面板宽 `min(340px, calc(100vw - 24px))`；成员行允许换行，不横向滚动。
- 验收截图：浅色/深色、1280×720、1440×900、页面 100%/125%/150%/200%；至少覆盖：owner 面板、viewer 只读面板、空态、候选搜索、错误态、被撤销后的提示。
- 动效录屏：打开/关闭、减少动态效果、快速重复点击不叠加。

---

## 6. 风险与边界

### 6.1 不能破坏的既有行为（按优先级）

1. **列表可见性**：`listCanvases` 仍按 owned → shared → org 聚合，去重后按 `updatedAt` 排序（`canvas-service.cjs:169-191`）。修共享不能把“被共享的画布”从列表里弄丢，也不能让私有画布出现在无关用户列表。
2. **`access.canEdit` 语义**：只由 `resource.edit` 决定；查看者/组织成员必须为 false；编辑者 true。所有 UI/只读闸依赖它。
3. **只读闸**：页面侧 `readOnly` 与后端 `#load(needEdit)` 必须同时成立；共享命令不得绕过。
4. **共享用户的离线/未登录**：共享是本地账号关系，没有邀请/待接受状态；对方未登录时只是看不到，登录后列表出现。不要在 UI 里显示“等待对方接受”或“已发送邀请”。
5. **超管边界**：超管可按 id 打开/管理任意画布，但列表仍不列全部私有画布；不要为了“方便管理”把 `listCanvases` 改成全量。
6. **画布页只读呈现**：不要用宿主遮罩盖住页面来“假装只读”；页面自身的 `data-openarc-readonly` 已经是既有约定。

### 6.2 并发与一致性

| 风险 | 现状/证据 | 处理 |
|---|---|---|
| **组织可见降级编辑者** | `canvas-domain.cjs:269-275` 先 ORG 后 share；探针复现 | 调整顺序：owner → share → org（§2.4） |
| **跨组织/不存在目标** | `shareCanvas` 不校验 `identity.userById`；探针复现外组织可打开 | 写入校验（存在/ACTIVE/同组织）+ 读取兜底（share 分支要求同组织） |
| **共享/可见性改 `updated_at`** | `canvas-store.cjs:25` 的 `setVisibility` 更新 `updated_at`；宿主用 `base_updated_at` 精确匹配 `updatedAt` 映射 revision（`CanvasHost.tsx:419-435`） | 共享/可见性/转移**不更新** `updated_at`；否则下次页面保存可能 `base=-1` → `REVISION_CONFLICT`（推断，高置信；P2 需实测） |
| **权限变化不刷新宿主** | 轮询只在 revision/updatedAt 变化时更新 current（`CanvasHost.tsx:903-913`），且不调 `pushContext`；共享撤销后 `canvas/meta` 返回错误被忽略 | 每轮比较 `res.meta.access`（canEdit/source）；变化就更新 current + `pushContext({canEdit})`；`res.ok=false` 时关闭面板、推 readOnly、提示 |
| **页面在列表页时宿主仍认为有 current** | 页面从编辑器返回列表不通知宿主；`current` 可能残留 | v1 在 `handleCall('canvas.list')` 时 `setCurrent(null)`（页面列表加载会走这个分支）；P3 可加显式 `view` 消息 |
| **owner 转移与并发共享** | 无 revision 概念；两个窗口同时操作 | 事务内重新读 owner；若已不是当前 owner → `READ_ONLY detail='owner-changed'`；返回最新 shares |
| **重复 upsert** | 同一用户两次添加 | 幂等；`changed:'UPDATED'`，不重复审计为 grant（按旧角色是否存在决定 action） |
| **purge 孤儿** | `canvas_shares` 无 FK | `purgeCanvas` 事务内删 shares（以及 commands/runs 的孤儿，至少 shares） |
| **审计失败** | `auditAuthorization` 内部 catch 吞错（`authorization-store.cjs:592-594`） | P1 增加 `strict` 选项：共享/可见性/转移在事务内 strict 写入，失败则回滚并返回 `INTERNAL_ERROR`；读取类审计仍可 best-effort |
| **数据库锁** | 复用 identity 的连接/事务队列 | 写操作走 `store.transactSync`；不要在事务里做异步 IPC |

### 6.3 审计完整性

- 必须记录：新增/改角色/移除/可见性/转移；拒绝的写尝试（至少记录 actor/target/action/reason）。
- 不记录：列表/读取/候选人搜索（避免审计噪声）。
- 审计字段必须能回答：谁、对哪本画布（`canvas:<id>`）、对谁、改了什么（old/new role）、何时（`at`）、来源（owner/super）、请求 id。
- 审计行不应包含：密码、token、邮箱、文件路径、画布正文。
- 测试：每个写命令后查 `authorization_audit`，断言 action/target/resource_ref/old/new/decision；拒绝场景断言 `DENY`。
- 残余风险：如果 `strict` 不做，审计插入失败会被吞，操作仍成功；本设计建议 P1 做 strict，否则在验收里明确标注“审计 best-effort”。

### 6.4 安全与产品边界

- **只共享给本机同一组织的 ACTIVE 本地账号**；不做公开链接、邀请码、邮件/IM 外发、跨组织共享。
- 不写网络请求；共享变更纯本地 SQLite。当前 `canvas_cloud_sync_baselines` 只有 DDL、无运行时使用；未来若接云同步，共享关系是否上传必须单独产品决策，默认**不同步**。
- 候选列表只查同组织；不把外组织用户/邮箱暴露给 owner。
- 成员列表只给 `canManage`；查看者只知道 owner 和自己的角色。
- 本地 `identity.db` 不是对操作系统用户的强安全边界；共享是应用层权限，不能防“直接读数据库文件”的本机用户。文档要如实说明，不要宣称“加密隔离”。
- 超管是本地管理员，拥有全局能力；其操作同样审计，不能静默。
- 画布被永久删除后，共享行必须清理；否则 orphan 行虽不可访问，但会在“共享给我”的 join 里留下无主数据。

### 6.5 兼容性与遗留

- **`resource/*Board*` 遗留命令**：`resource/listBoards` 等仍在 renderer 白名单里（`resource-bootstrap.cjs:80-82`），但 Vue 壳没有挂载 `src/governance/CanvasApp.tsx`。如果未来重新启用，它会：
  - 用 `integration-service.CanvasService.#boardAccess` 只允许 owner/超管（`integration-service.cjs:181-186`），**不识别 canvas_shares**；
  - 用 `integration-store.deleteBoard` 直接删 `canvas_boards`（`integration-store.cjs:37`），可能删掉有共享的画布；
  - 创建的 board 只有基础列，`doc`/`visibility` 走默认值。
  - **建议**：在 P1/P3 把 `resource/*Board*` 从 renderer 白名单移除，或改为调用文档服务；至少不要在 UI 里暴露为“画布”。本设计不把它当共享入口。
- **DXOS 死表**：不迁移、不 join、不写。若未来 DXOS 功能要用 `canvases`，必须单独做 ID/文档/可见性映射，不能和 `canvas_boards` 混用。
- **`canvas_members` 非空安装**：先盘点再决策；本设计不自动导入。
- **旧 `CONTRIBUTOR` 行**：读归一 `EDITOR`；新写 `EDITOR`；不改 CHECK。
- **`canvas/share` 空 userId**：移除旧“返回列表”行为；如果担心未知调用方，可保留一个 deprecated 分支并记日志，但不建议。

### 6.6 残余未知（需要在实现前/真机确认）

1. 其他安装的 `canvas_members` 是否真的全空（本机为空，运行时无写入；无法从源码证明所有历史安装）。
2. 共享/可见性改 `updated_at` 是否真的会在页面保存时触发 `REVISION_CONFLICT`（代码推断高置信，需 P2 e2e 复现）。
3. 产品是否希望编辑者能运行 AI 生成并消耗模型额度（Q3）。
4. 产品是否希望超管能“浏览全部私有画布”（当前不能；本设计建议保持不能）。
5. 未来云同步是否要同步共享关系（当前无运行时云同步；默认不同步）。
6. 列表侧共享入口是否真的需要（本设计建议 v1 不做；若用户坚持，P3 只做入口）。

---

## 7. 工作量拆分（2–4 个可独立验收的包）

### P1 · 后端共享/权限核心（建议先做）

**范围**

- `canvas-domain.cjs`：权限顺序（owner→share→org）、`canManage/canShare` 辅助、角色归一。
- `canvas-store.cjs`：`updateOwner`、`deleteSharesOfCanvas`、`sharesOf` 富化所需查询、`setVisibility` 不再改 `updated_at`。
- `canvas-service.cjs`：`shareCanvas` 目标校验/审计、`removeShare`、`shareCandidates`、`accessGet`、`setVisibility` 校验、`transferOwner`、`purgeCanvas` 清理 shares、`#view/meta` 补 `canManage`。
- `canvas-bootstrap.cjs`：登记 `canvas/share/remove`、`canvas/share/candidates`、`canvas/access/get`、`canvas/owner/transfer`；payload 有界。
- `identity-store.cjs`：v28 迁移（`created_at` + 组合索引）。
- `identity-bootstrap.cjs`：把 `authStore` 传给 `createCanvasBundle`（或 canvas service 显式接收 audit store）。
- 测试：权限矩阵、目标校验、优先级、跨组织、移除、可见性、转移、审计、迁移、purge 孤儿。

**独立验收**

- `node --test tests/d5-02-canvas-service.test.mjs` + 新增 `tests/d5-02-canvas-sharing.test.mjs` 全绿。
- `probe.mjs` 复现场景全部按新规则返回（组织+编辑者 → canEdit true；外组织 → INVALID_INPUT；不存在 → INVALID_INPUT；审计有行）。
- 本机真实库不被测试写入（测试用 `:memory:`/临时 db）。
- 迁移在 v27 库副本上重复执行两次无报错，`created_at` 回填正确。

### P2 · 宿主共享面板 UI（依赖 P1 命令）

**范围**

- 新组件（建议 `src/canvas/CanvasSharePanel.tsx`）：入口按钮、面板、成员行、候选搜索、可见性、只读态、错误/空态。
- `CanvasHost.tsx`：`current` 增加 `canManage/visibility`；`canvas/get`/`canvas/meta` 读取；`canvas.list` 清空 current；轮询比较 access 并 `pushContext`；面板开关/刷新。
- `src/styles.css` 或 canvas 局部 CSS：只消费 tokens；面板/入口/窄窗/减少动效。
- 测试/证据：浅色/深色截图、1280/1440、125%/150%/200%、键盘/Esc/焦点返回、减少动态效果录屏。

**独立验收**

- 不修改 `public/novai-canvas/**`；共享 UI 全部在宿主。
- owner 可添加/改角色/移除/切可见性；editor/viewer 看不到管理控件；只读用户看到正确徽标。
- 被撤销共享后 2.5s 轮询内面板关闭/只读，页面不再可保存（后端也拒）。
- 截图与设计规范核对：面板表面、圆角、间距、字重、无蓝色/无发丝边框、焦点环可见。

### P3 · 列表侧入口（可选，取决于拍板）

**范围（仅当用户选择方案 A）**

- `canvas-list.html` 卡片菜单加“共享”，只 postMessage `{kind:'open-share', canvasId}`；共享 UI 仍在宿主面板。
- bridge 增加 `canvas.shares` 等路由（如果页面需要显示“共享”/“组织可见”标识）。
- 列表卡片显示“共享给我/组织可见”徽标（需要宿主把 access/source 传给页面，或页面读 `access`；当前页面不渲染 access）。

**独立验收**

- 列表菜单能打开宿主面板；页面不出现第二套共享 UI；vendor 升级补丁有清单。
- 若不选 A，此包不做；不要为了“入口在列表”而改上游页面。

### P4 · 多账号真机与安全回归

**范围/步骤**

1. 在“组织”里创建一个 MEMBER 账号（本机现有两个都是 ADMIN，不能验证只读/编辑）。用真实应用，不用测试夹具。
2. Owner 创建画布，共享给 MEMBER 为查看者；MEMBER 登录：列表出现画布，打开只读；尝试拖动/保存/AI/撤销全部被拒（页面只读 + 后端 READ_ONLY）。
3. 改为编辑者：MEMBER 重新打开，能编辑/保存/运行 AI；不能看到共享管理；不能删画布。
4. 设组织可见：第三个同组织成员只读可见；显式编辑者仍可编辑（验证优先级修复）。
5. 撤销共享：MEMBER 的画布在 2.5s 内变为不可访问/只读；保存被拒；刷新后列表消失。
6. 停用 MEMBER：不能登录；owner 成员列表显示“已停用”，可移除。
7. 转移 owner：旧 owner 变编辑者，新 owner 可管理；审计两行。
8. 跨组织：用测试夹具的 foreign team 成员；写入被拒；即使手工插入 stale share，读取也被拒。
9. 审计：每个动作在 `authorization_audit` 有行；拒绝尝试有 DENY；无密码/路径/正文。
10. 数据：`canvases/canvas_members` 仍为 0 行；`canvas_shares` 角色/时间正确；purge 后无孤儿。
11. 网络：共享操作 0 外发；无新增 fetch/HTTP。
12. 视觉/动效：浅深色、窄窗、缩放、减少动态/透明度；面板不遮挡红绿灯；键盘可达。

**独立验收**：上述 12 条逐条有截图/日志/DB 查询证据；任何一条不通过不算完成。

### 建议顺序

P1 → P2 → P4；P3 等用户对 UI 方案拍板后再决定。P3 不应阻塞 P1/P2。

### 粗估

- P1：1.5–2.5 人日（含测试/迁移）
- P2：1.5–2.5 人日（含截图/键盘/窄窗）
- P3：1–1.5 人日（仅入口，不含页面内共享 UI）
- P4：1–1.5 人日（多账号/安全/真机）

（估算只用于排期，不作为验收依据；验收以每包列出的检查为准。）

---

## 附录 A · 关键证据索引

| 事实 | 证据 |
|---|---|
| `canvas_boards` 权威 DDL | `electron/identity-store.cjs:744-753` |
| v17 文档层 + `canvas_shares` | `electron/identity-store.cjs:1167-1218` |
| `canvas_shares` 无 FK | `electron/identity-store.cjs:1188-1195` |
| 共享 SQL upsert/查询/删除 | `electron/canvas-store.cjs:26-29,118-124` |
| 可见性 SQL 更新 `updated_at` | `electron/canvas-store.cjs:25,116` |
| purge 只删 board | `electron/canvas-store.cjs:24,115`；`electron/canvas-service.cjs:265-273` |
| 权限求值 | `electron/canvas-domain.cjs:263-280` |
| 共享/可见性/列表 | `electron/canvas-service.cjs:276-306` |
| 文档服务权限入口 | `electron/canvas-service.cjs:54-81` |
| 列表 owned/shared/org | `electron/canvas-service.cjs:169-191` |
| 命令白名单/分发 | `electron/canvas-bootstrap.cjs:19-50,67-100` |
| `permission set` | `electron/authorization-domain.cjs:149-166,229-243` |
| `auditAuthorization` | `electron/authorization-store.cjs:545-597` |
| `authorization_audit` 表 | `electron/identity-store.cjs:325-343` |
| `resolveActor/isSuper` | `electron/authorization-service.cjs:557-574` |
| `teams/users` | `electron/identity-store.cjs:125-145` |
| 本地用户列表投影 | `electron/local-account-service.cjs:252-269,461-463` |
| DXOS 死表 DDL | `electron/dxos-foundation-schema.cjs:235-238` |
| DXOS 索引/迁移 | `electron/dxos-foundation-schema.cjs:287-292`；`electron/identity-store.cjs:1548-1553,1593-1600` |
| 遗留资源板服务 | `electron/integration-service.cjs:168-186`；`electron/integration-store.cjs:33-45`；`electron/resource-bootstrap.cjs:80-82,368-379` |
| 遗留 UI 未挂载 | `src/governance/CanvasApp.tsx:1`（全仓无 import） |
| Vue 承载层级 | `src-vue/App.vue:171`；`src-vue/shell/WindowLayer.vue:216`；`src-vue/bridge/ReactIsland.vue:6-12` |
| CanvasHost iframe/沙箱 | `src/canvas/CanvasHost.tsx:12-18,41,958` |
| 宿主只读上下文 | `src/canvas/CanvasHost.tsx:324-326,385-392,737-744` |
| 宿主保存基线映射 | `src/canvas/CanvasHost.tsx:419-435` |
| 宿主轮询不刷新 access | `src/canvas/CanvasHost.tsx:903-913` |
| bridge 只读事实 | `public/novai-canvas/openarc-bridge.js:21,128,145,190-191` |
| 页面只读闸 | `public/novai-canvas/openarc-adapter.js:20,37,166-174,210-250`；`public/novai-canvas/openarc-smart-adapter.js:20,84,206-214`；`public/novai-canvas/static/js/smart-canvas.js:35091` |
| bridge 路由 | `public/novai-canvas/openarc-bridge.js:409-435` |
| 画布窗口层级 | `src/styles.css:280-295,6848-6871` |
| 页面顶部按钮位置 | `public/novai-canvas/static/css/smart-canvas.css:59-67`；经典页下移 `public/novai-canvas/openarc-canvas-guard.js:189-192` |
| 设计 token | `src/design-system/tokens.css:157-174,180-188` |
| 组件样式 | `src/design-system/primitives.css:38-165,169-290,355-383`；`src/styles.css:967-997,2927-2932` |
| 设计规范 | `DESIGN_SYSTEM.md:145-174,176-193,206-233,247-257` |
| 动效规范 | `MOTION_SYSTEM.md:85-105,141-150` |
| 计划要求 | `PLAN.md:92`（首版团队可共享画布；实时协作后续） |

## 附录 B · 需要用户拍板的产品问题（≤3）

### Q1. 共享角色用两档还是三档？

- **推荐：两档**（查看者 / 编辑者）；所有者与超管管理共享，委托用“转移所有者”表达。
- 理由：现有效果就是两档；数据库 CHECK 只允许三种值；三档会引入“管理共享”这一所有权相邻能力，产品尚无对应场景；以后要加需重建表。
- 如果选三档：需要明确“管理共享者能否移除/降级所有者”“能否转移所有权”“审计如何记”，并接受一次表重建迁移。

### Q2. `ORGANIZATION`（组织内可见）是否允许编辑？

- **推荐：只读**。组织内所有人可打开查看；要编辑必须显式共享为编辑者。
- 理由：可解释“谁改了我的画布”；避免“组织可见”变成默认协作写权限；与现有 `ORG_POLICY=VIEWER` 一致。
- 如果选“组织内可编辑”：需要新增可见性值（如 `ORGANIZATION_EDIT`）或新角色，并重新评估列表/审计/误删风险；不建议 v1。

### Q3. 编辑者能否运行 AI 生成（消耗模型额度）？

- **推荐：允许，但 UI 明确提示**。编辑者本来就是“能改画布的人”，AI 生成是画布编辑的一部分；在共享面板的角色说明里写“编辑者可以修改画布并运行 AI 生成，会消耗模型额度”。
- 如果产品要控成本：v1 可先把“运行 AI”收紧为所有者（只让编辑者改文档、不让其触发生成），或后续加“可生成”独立开关；这会改变 `startRun/modelCall` 的权限判据，需要单独测试。
- 默认（不回答时）：按推荐，编辑者可生成 + 明确提示。

---

> 本设计只新增调研与方案，不改任何产品代码；实现包开始前请先确认 Q1–Q3 与 UI 方案（A/B）。
