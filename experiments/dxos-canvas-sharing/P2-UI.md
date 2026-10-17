# 画布三档共享 · P2 实现回执（宿主面板 + 列表入口 + 权限自动刷新）

> 版本：2026-10-17 · 基线 = P1 后端（工作树未提交）+ 既有未提交改动（重新 vendor / 尺寸表 / 延迟修复）。
> 既有改动全部保留，本包没有回退它们；后端只动 restoreCanvas 一处。
> 验收证据：artifacts/dxos-canvas-sharing/REAL-DEVICE.md · real-device.json · shots/**。

---

## 0. 结论

- 入口：画布列表卡片菜单「共享…」（第 18 处脚本化 vendor 改动）+ 画布页右上角宿主入口；两者打开**同一个** React 岛面板。
- 三档角色 / 私有·组织可见 / 成员增删改 / 转移所有者 / 只读视图全部按服务端能力投影，前端不另写一套权限判定。
- 撤销或降级后：已打开页面在 208ms（降级）/ 677ms（撤销）内自动变只读或返回列表，不等用户刷新。
- 真机 36/36 PASS；单测 12/12（面板纯逻辑+接线）、16/16（共享后端，含 restore 收紧）、258/258（画布回归）；tsc / vue-tsc / build 全 0。

---

## 1. 改动清单（文件 · 行）

| 文件 | 改动 |
| --- | --- |
| src/canvas/CanvasSharePanel.tsx（新增，约 500 行） | 入口按钮 + 宿主浮层面板：可见性、成员行、候选搜索/添加、改角色、两步移除、二次确认转移、只读视图、空/加载/错误态、Esc + 焦点回位。 |
| src/canvas/canvasShareModel.ts（新增，261 行） | 纯逻辑：三档文案、能力矩阵、成员行状态、错误码中文、权限签名、两步确认状态机、转移候选、列表入口消息解析。 |
| src/canvas/CanvasHost.tsx | 引入面板；current 增加 canManage/canShare/source；权限签名 + notifyAccess + accessLost + refreshCurrentAccess；open-share 消息；轮询比较 access 并 pushContext；画布页入口渲染；canvas.list 回列表清 current（39-51、79-85、109-120、398-465、506-520、897-905、1101-1121、1182-1205）。 |
| src/styles.css | 新增宿主共享浮层样式（1363-1535 行附近，紧跟 .canvas-host-frame）：只消费既有 token 与 .ds-btn/.ds-field/.segmented.text/.gov-row/.ds-badge；窄窗用容器查询；减少动态效果。 |
| electron/canvas-service.cjs | **唯一后端改动**：restoreCanvas 收紧为 canRestore（385-390 行）。 |
| public/novai-canvas/openarc-bridge.js | 新增 window.__openarcBridge.openShare(canvasId)（174-180 行）：只发 {kind:"open-share", canvasId, token}，空 id 返回 false；不登记新端点、不放宽出网/CSP/token。 |
| public/novai-canvas/static/canvas-list.html | 生成件（vendor 第 18 处改动）：卡片菜单「共享…」（1274-1278 行）+ action === 'share' 分支（1336-1344 行）。页面里没有共享 UI。 |
| experiments/d5-02/vendor-novai-app.mjs | 头部登记第 18 处改动（46 行）+ LIST_PATCHES 两项（550-568 行）；幂等、缺锚点即报错。 |
| public/novai-canvas/SOURCE.md / PRUNE.md | 记录第 18 处改动、文件集合不变、manifest 幂等哈希。 |
| tests/dxos-canvas-share-panel.test.mjs（新增） | 12 条：角色矩阵/按钮禁用、错误码、两步确认、签名变化、列表入口、接线契约。 |
| tests/dxos-canvas-sharing.test.mjs | 新增第 16 条 restore 收紧（编辑者/管理者/查看者被拒、所有者/超管可恢复、外组织看不到）；既有 15 条不放宽。 |
| experiments/dxos-canvas-sharing/ui-probe.mjs（新增） | 双进程真机多账号探针（36 条断言，输出 REAL-DEVICE.md / real-device.json / shots）。 |

未改：electron/canvas-domain.cjs、canvas-store.cjs、canvas-bootstrap.cjs、image-params.cjs、dist/**、src-vue/**、provider/模型层、集成服务。

---

## 2. 面板状态与交互

### 2.1 能力矩阵（服务端 canManage + source 驱动）

| 主体 | 入口文案 | 成员列表 | 可见性 | 添加/改角色/移除 | 转移所有者 |
| --- | --- | --- | --- | --- | --- |
| 所有者 OWNER_POLICY | 共享 | 是（含 owner 行） | 是 | 是 | 是（二次确认） |
| 超管 SUPER_ADMIN | 共享 | 是 | 是 | 是 | 是（二次确认） |
| 管理共享 SHARE_MANAGER | 共享 | 是 | 是 | 是 | 否 |
| 编辑者 SHARE_EDITOR | 编辑者 | 否（只给人数/自己角色） | 只读说明 | 否 | 否 |
| 查看者 SHARE_VIEWER | 只读共享 | 否 | 只读说明 | 否 | 否 |
| 组织成员 ORG_POLICY | 组织内可查看 | 否 | 只读说明 | 否 | 否 |

### 2.2 状态表

| 状态 | 呈现 | 行为 |
| --- | --- | --- |
| 加载中 | 3 行骨架（.gov-row 高度）；data-canvas-share-ready=0 | 不显示假数据 |
| 管理视图 | 可见性分段 + owner 行 + 成员行 + 添加 + 转移（仅 owner/超管） | 成员行：头像首字/名字、@账号、正常/已停用/账号不存在、加入 MM-DD、角色下拉、移除图标 |
| 只读视图 | 可见性文字 + 我的角色（查看者/编辑者/组织内可查看）+ 一句说明 | **DOM 里没有任何成员行/成员 ID**；服务端 shares=null |
| 空态 | 还没有共享给任何人 | 添加区仍可用 |
| 候选搜索 | 220ms 防抖；空/无结果/失败各有文案 | 点击候选项按当前所选角色添加 |
| 改角色 | 行内 select；保存中禁用该行 | 成功用服务端返回的 shares 覆盖；失败保留旧值 + 行内错误 |
| 移除 | 图标 → 行内「移除？[移除][取消]」 | 取消保留；确认后从列表消失；失败行内报错 |
| 可见性 | .segmented.text；保存中禁用 | 成功即生效并 flash 提示；失败回滚并显示错误 |
| 转移 | 选择新所有者 → 「转移…」→ 二次确认 | 成功后旧 owner 变编辑者、面板按服务端事实切只读视图 |
| 权限被降级 | 面板按 refreshToken 重读；页面被 pushContext 切只读 | 不需要刷新页面 |
| 权限被撤销 | 面板关闭、提示、返回列表 | NOT_FOUND_OR_FORBIDDEN 路径 |
| 目标停用/不存在 | 状态文字 carrying 语义 + 角色下拉禁用 | 仍可移除（管理共享） |

### 2.3 无障碍 / 窄窗

- 面板 role=complementary + aria-labelledby；打开时焦点进关闭按钮；Esc 关闭；关闭后焦点回入口按钮（列表入口回应用帧）。
- 入口 aria-expanded；按钮/下拉/移除均有可访问名称；状态不只靠颜色（文字 + 色调）。
- 窄窗（容器宽度 ≤760px）：入口收成 40px 图标，面板宽 calc(100cqw - 16px)，成员行两行网格，不横向滚动。
- 减少动态效果：.desktop.reduced 与 prefers-reduced-motion 下面板 animation:none（只呈现终态）。

---

## 3. 列表入口（vendor 第 18 处改动）

1. canvas-list.html 卡片菜单在「复制画布」与「删除」之间新增「共享…」（沿用 .card-more-menu-item）。
2. 点击只调用 window.__openarcBridge.openShare(c.id)；桥 post {kind:"open-share", canvasId, token}（实例 token 是宿主消息闸门的硬条件）。
3. CanvasHost 校验 event.source/令牌后 setShareTarget({canvasId, title, origin:"list"})，打开同一个宿主面板；列表页**不画**共享 UI。
4. 补丁写在 LIST_PATCHES 第 8/9 条，幂等；源锚点缺失即报错退出。文件集合不变（60 files / 11,539,262 B），只有 canvas-list.html 内容变化（listHtmlHash=50f50e1c8ed2f0cd）。
5. 真机 A6 验证：列表卡片菜单点击 → 面板 data-canvas-share-open = 目标画布 id；A17 验证画布内入口 + Esc 焦点回位。

---

## 4. 错误码 → 中文（mapShareError）

| 错误 / detail | 面板中文 |
| --- | --- |
| NOT_FOUND_OR_FORBIDDEN | 这本画布已不可访问（可能已被移出共享） |
| NOT_FOUND | 画布不存在或已被删除 |
| NOT_FOUND detail=share | 这个成员还没有被共享，无法修改角色 |
| READ_ONLY | 只有所有者和管理共享的人可以修改共享设置 |
| READ_ONLY detail=owner-changed | 所有权已被其他操作变更，请重新打开共享面板 |
| INVALID_INPUT target | 找不到这个成员（账号可能已被删除） |
| INVALID_INPUT target-disabled | 该账号已停用，不能共享 |
| INVALID_INPUT target-org | 只能共享给同一组织的成员 |
| INVALID_INPUT owner | 不能对画布所有者执行这个操作 |
| INVALID_INPUT role | 角色不合法（只能是查看者 / 编辑者 / 管理共享） |
| INVALID_INPUT visibility | 可见性取值不合法（只能私有或组织内可见） |
| INTERNAL_ERROR / audit | 保存失败：审计未写入，本次操作已回滚 |
| NO_BRIDGE | 宿主桥不可用（无法读取共享设置） |
| 未知码 | 操作失败：CODE（不吞掉） |

---

## 5. 权限变化自动刷新（bug3 前端部分）

- 权限签名 = canView | canEdit | canManage | canShare | source（source 已含 SHARE_VIEWER/EDITOR/MANAGER 档位）。
- 800ms 轮询 canvas/meta：每轮比较签名；变化即 setCurrent + pushContext({canvasId, canEdit})，页面只读闸当场更新。
- canvas/get 与 canvas/save 的 access 也走同一签名；保存被 READ_ONLY 拒绝时立刻 accessLost。
- canvas/meta / canvas/get 返回 READ_ONLY 或 NOT_FOUND_OR_FORBIDDEN：
  - READ_ONLY → 切只读 + pushContext + 提示（保留页面）；
  - NOT_FOUND_OR_FORBIDDEN → 关面板 + 清 current + 提示 + 整帧回列表（不能停在旧文档）。
- 页面回到列表（canvas.list）时清 current，列表页不再残留上一本的入口/轮询。
- 真机：降级 208ms、撤销 677ms；V2/E2 证明查看者/编辑者的页面只读与保存结果。

---

## 6. restore 收紧（唯一后端改动）

- 位置：electron/canvas-service.cjs:385-390。
- 规则：仍走 #load(needEdit, allowTrashed)，再要求 domain.canRestore(r.access)；EDITOR/MANAGER 被 READ_ONLY（detail=SHARE_EDITOR/SHARE_MANAGER），VIEWER 在 needEdit 处即 READ_ONLY，外组织 NOT_FOUND_OR_FORBIDDEN；所有者/超管照常恢复。
- 测试：tests/dxos-canvas-sharing.test.mjs 第 16 条（含恢复后编辑者仍可编辑、超管恢复他人画布）。
- 没有改 canvas-domain / canvas-store / bootstrap，也没有新增命令或审计。

---

## 7. 验证数字（真实执行）

| 检查 | 结果 |
| --- | --- |
| node --test tests/dxos-canvas-share-panel.test.mjs | 12/12 通过 |
| node --test tests/dxos-canvas-sharing.test.mjs | 16/16 通过（新增 restore 收紧） |
| node --test tests/dxos-canvas-*.test.mjs tests/d5-02-canvas-*.test.mjs tests/canvas-library-list.test.mjs | 258/258 通过 |
| npx tsc --noEmit | exit 0 |
| npx vue-tsc --noEmit -p tsconfig.vue.json | exit 0 |
| npm run build | exit 0 |
| vendor 幂等（连跑两次） | manifest sha256 相同 = 5acd748a53ea439804828912ecbf44deace016bb0ca5578967c1f392923076af |
| 真机多账号（experiments/dxos-canvas-sharing/ui-probe.mjs） | **PASS 36 / FAIL 0**；0 console error / 0 pageerror；真实 profile 零改动 |
| 权限变化时延 | 降级 → 只读 208ms；撤销 → 回列表 677ms |

### 真机逐项

| 项 | 证据 |
| --- | --- |
| 查看者：能打开、页面真只读（编辑被拒） | V1（data-openarc-readonly=1 + bridge readOnly）；V2（页面命令/后端保存 READ_ONLY，节点数不变） |
| 查看者：面板无成员列表、看不到别人 ID | V3（mode=readonly、members=0、DOM 无其他成员 ID/名字）；viewer-panel-light.png |
| 编辑者：能编辑保存、不能改共享、UI 不给入口 | E1/E2（可编辑 + 节点落库 + 保存成功）；E3（READ_ONLY + readonly 面板）；editor-panel-light.png |
| 管理共享：能加/删/改角色/切可见性，不能删画布/转移 | M1/M2/M3（命令成功 + READ_ONLY ×2）；manager-panel-dark.png |
| 撤销共享后立即只读或无法打开 | L1 208ms 自动只读；L2 677ms 自动回列表 + 提示；revoke-*.png |
| 组织可见：未共享只读；显式编辑者仍可编辑（bug1） | O1（source=SHARE_EDITOR + canEdit=true + 页面编辑成功）；查看者/组织可见只读在 P1 单测 |
| 跨组织/停用不能共享 | X1（INVALID_INPUT target-org / target-disabled；候选人排除） |
| 0 console error / 0 pageerror | Z1/Z2 |
| 浅/深 + 窄窗截图 | admin-panel-light/dark/narrow、admin-empty、admin-candidate、admin-transfer-confirm、viewer-panel、editor-panel、manager-panel-dark、revoke-*、entry、list-share-menu |

---

## 8. 截图索引

- 列表入口 + 管理员面板：artifacts/dxos-canvas-sharing/shots/list-share-menu-light.png
- 管理员面板（浅/深/窄/空/候选/转移确认）：admin-panel-light.png / admin-panel-dark.png / admin-panel-narrow.png / admin-empty-light.png / admin-candidate-light.png / admin-transfer-confirm-light.png
- 画布内入口 / 面板：canvas-share-entry-light.png / admin-panel-in-canvas-light.png
- 查看者 / 编辑者 / 管理共享：viewer-panel-light.png / editor-panel-light.png / manager-panel-dark.png
- 撤销后：revoke-downgraded-readonly-light.png / revoke-back-to-list-light.png

---

## 9. 遗留与边界

1. 共享投影（canvas/shares）只返回 displayName/username，没有 avatarRef；面板用名字首字圆形头像，不伪造图片。要真头像需扩展后端投影，超出本包写入范围。
2. 列表卡片「共享…」对所有角色可见：无管理权的人打开只读信息面板；这符合“入口在列表卡片菜单”的拍板。
3. 窄窗截图用 CDP Emulation 改渲染视口（Browser.setWindowBounds 在该环境失败）；容器查询实测面板 704px / 视口 720px、入口 40px 图标，行内无横向滚动。
4. 跨组织真机用例：产品只允许一个根组织、没有建第二个组织的命令；探针在隔离 identity.db 里加一个夹具团队并移动 outsider，再验证 target-org / 候选人排除。产品代码未改。
5. 双进程共用同一隔离 userData 并共享 identity.db：两进程均在初始化前启动，B 之后用 identity/login 登录普通账号；A 的管理员会话在内存中保持有效（真机 Z3 证明真实 profile 未动）。该做法只用于验收，不是产品能力。
6. 未 git commit / push；dist/** 为 npm run build 产物，未手改。
7. 动效只做了静态契约与减少动态效果验证，**没有连续录屏**；打开 220ms / 关闭即时（不做 160ms 退出动画，保证焦点回位不被动画拖延）。见第 10 节。

---

## 10. 设计规范对照（DESIGN_SYSTEM / MOTION_SYSTEM / PLAN §4、§42）

| 项 | 规范要求 | 本包落实 |
| --- | --- | --- |
| 语义设计值 | 颜色/圆角/阴影/字号只取 token | 面板只用 --surface-rgb/--surface-alpha、--glass-filter、--shadow、--radius-xl/md/sm/pill、--fs-*；没有新增十六进制颜色 |
| 字阶与字重 | --fs-title/heading/body/secondary/caption/micro；400/500 | 标题 --fs-heading，成员名 --fs-secondary，说明/状态 --fs-micro；weight 只用 regular/medium |
| 密度与尺寸 | 现有浮层/列表的密度 | 面板 340px、16px 内边距、26px 头像，与 .ai-panel（22px 内边距）和 .gov-row（8/10px）同一量级；窄窗 40px 图标入口 |
| 层级 | 不设无限 z-index；菜单/浮层在窗口内容之上 | .canvas-share-layer z-index 2（iframe 之上），面板/入口 z-index 2–3；标题栏仍是 3 且面板从 top:66 开始避开红绿灯 |
| 焦点 | 2px 中性焦点环、2px 间隔；菜单 Esc、焦点回触发者 | 复用全局 focus-visible；面板打开焦点进关闭按钮，Esc 关闭，关闭后焦点回入口按钮（列表入口回应用帧）；aria-expanded |
| 组件状态 | 默认/悬停/按下/焦点/禁用 + 加载/错误/成功 | .ds-btn/.ds-iconbtn 的既有状态；骨架加载、行内错误+重试、成功 flash、保存中禁用、停用/不存在状态文字 + 角色下拉禁用 |
| 内容可读 | 画布内容保持完整可读，玻璃集中在工具栏/外壳 | 非模态右侧浮层，无全屏遮罩，不遮画布左侧主体；面板自身是玻璃面 |
| 可访问性 | 名称、键盘、状态不只靠颜色、减少动态 | role=complementary + aria-labelledby；所有按钮/下拉有可访问名称；状态=文字+色调；.desktop.reduced 与 prefers-reduced-motion 下面板 animation:none |
| 动效 | Drawer 打开 220ms；浮层退出 120–160ms 可统一 | 打开 animation 220ms（var(--standard)）；退出即时卸载（见遗留 7）；减少动态为 0ms/无动画 |
| 页面映射 | 画布与浏览器内容完整可读 | 上游列表页/智能画布页一个字的 DOM 都没改（vendor 只加菜单项 + share 分支） |
| 交付 | 功能/视觉/动效分别记录，浅深+窄窗截图 | 功能：单测 + 真机 36 条；视觉：浅/深/窄/空/候选/转移/只读/撤销后截图；动效：只做静态契约 + 减少动态验证（未录屏，如实登记） |

### 基准与冲突

- 共享面板是**新组件**，没有历史已确认基准；最接近的既有基准是右侧 .ai-panel（src/styles.css:1596）与 .gov-row 列表（src/styles.css:3126）。本包第一轮真机截图就是第一个确认状态，后续改动以此为对照。
- 冲突 1：DESIGN_SYSTEM §7 说“普通非模态侧栏不抢走当前输入焦点”，而本次用户拍板的共享设计（DESIGN.md §5.5）要求“打开后焦点进入第一个可操作项”。本包按任务专属设计执行：焦点进面板关闭按钮（不是背景），关闭后回入口；面板打开是用户显式点击，不打断正在输入的页面。
- 冲突 2：共享设计文档写“关闭 160ms”，实现选择即时卸载（不做退出动画），避免动画期间焦点回位/旧回调误关新层；这是有意的取舍，已登记在遗留 7。
- 冲突 3：没有新的颜色/圆角/阴影，也没有把状态色单独当语义（停用/不存在都有文字）。
