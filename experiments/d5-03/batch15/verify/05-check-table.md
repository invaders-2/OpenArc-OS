| # | section | 判据（name） | run1 | run2 | expected | actual 摘要（run1，截断） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | boot | V0 · 真实 electron . 启动（隔离 userData / 隔离 CDP 端口） | PASS | PASS | CDP 可用 | connected |
| 2 | boot | V1 · 真实 UI 登录 admin | PASS | PASS | ready | ready |
| 3 | setup | V2 · 真实视图加载纯色页面（像素判定的基准） | PASS | PASS | PAINT-MARKER-2f7d | http://127.0.0.1:5391/paint |
| 4 | safety | V3 · 真实点击前先确认「最前面的窗口就是我们自己的实例」 | PASS | PASS | 本实例窗口在最前 | {"ours":162275,"front":[{"pid":25293,"id":162275},{"pid":18158,"id":152537},{"pid":24060,"id":162238}],"tries":1} |
| 5 | pixel | V4 · 屏幕像素证明确实「看得见」网页（视口中心是页面纯绿） | PASS | PASS | 页面纯绿（绿占优） | 56,123,83 |
| 6 | pixel | V4b · 截图确实是本窗口的画面（图像尺寸 = 窗口 bounds × 缩放） | PASS | PASS | 尺寸一致 | {"image":[2880,1880],"win":{"w":1440,"h":940},"scale":2,"titlebar":0} |
| 7 | pixel | V4c · 三条独立通道一致：像素真值 = DOM 预留矩形 = 指针反推（/Δ/≤3pt，宽高也对） | PASS | PASS | 三路一致（/Δ/≤3pt） | {"pixels":{"left":308,"top":418,"right":1137.5,"bottom":738.5,"width":829.5,"height":320.5},"domReserved":{"left":308,"top":417.5,"right":1138,"bottom… |
| 8 | pixel | V4d · 提示条/错误条存在时网页**让位**（条带高度 > 0，且条带内像素不是网页绿） | PASS | PASS | 条带让位且不被网页覆盖 | {"banner":{"kind":"permission","h":115,"text":"网站权限\n已拒绝 该网站 的 media 申请。\n网站权限\n已拒绝 该网站 的 web-app-installation 申请。\n网站权限\n已拒绝 该网站 的 "},"stripH":115,"s… |
| 9 | safety | V3c · 真实指针确实到达本实例外壳（激活后的第一下点击可能被系统用于激活窗口，先热身） | PASS | PASS | 外壳收到真实 pointerdown（≤3 次热身点击） | {"ok":true,"tries":1,"seen":1,"point":{"x":723,"y":191},"trace":[{"i":0,"click":{"ok":true,"attempt":1},"shellPointer":1}]} |
| 10 | safety | V3b · 真实点击只落在本实例窗口内（每次点击前重新校验前台与内容区） | PASS | PASS | 点击被安全闸放行 | {"ok":true,"attempt":1,"trace":[{"ours":162275,"front":[{"pid":25293,"id":162275},{"pid":18158,"id":152537},{"pid":24060,"id":162238},{"pid":22673,"id… |
| 11 | pointer | V6 · 统一换算给出的地址栏坐标 + 真实指针 → 焦点真的进入输入框 | PASS | PASS | activeElement=地址栏 | {"point":{"x":754,"y":277},"fromDom":{"x":610,"y":243.5},"click":{"ok":true,"attempt":1,"trace":[{"ours":162275,"front":[{"pid":25293,"id":162275},{"p… |
| 12 | pointer | V5 · 真实指针点击标签栏「新建标签」→ 真的多出一个标签（外壳收到该按钮的 isTrusted 点击） | PASS | PASS | 标签数 +1 且外壳收到该按钮点击 | {"before":1,"after":2,"elementAtPoint":"新建标签","screen":{"x":424,"y":235},"pointPixel":"110,110,115","click":{"ok":true,"tries":1,"trace":[{"i":0,"clic… |
| 13 | pointer | V5b · 真实指针点击第二个标签 → 活动标签真的切换 | PASS | PASS | 第二个标签变为活动 | {"want":"t2","active":"t2","click":{"ok":true,"attempt":1,"trace":[{"ours":162275,"front":[{"pid":25293,"id":162275},{"pid":18158,"id":152537},{"pid":… |
| 14 | pixel | V5c · 操作前后两帧像素确实不同（画面真的变了） | PASS | PASS | 帧不同 | 02-tab-switch.png |
| 15 | pointer | V7 · 真实指针点击**网页内部**按钮 → 页面自己收到点击并计数 | PASS | PASS | 页面收到真实点击并计数 | {"button":{"last":{"x":190,"y":185,"target":"paint-btn"},"count":"COUNT-2","click":{"ok":true,"attempt":1,"trace":[{"ours":162275,"front":[{"pid":2529… |
| 16 | pointer | V7b · 落点就是按钮本体（页面收到的坐标 = 目标，误差 ≤ 6px，target=paint-btn） | PASS | PASS | 命中按钮 | {"got":{"x":190,"y":185,"target":"paint-btn"},"wantPagePoint":{"x":190,"y":185}} |
| 17 | pixel | V8 · 面板打开时网页**让位**（视口中心像素不再是页面绿） | PASS | PASS | 非页面绿 | {"pixel":"255,255,255","click":{"ok":true,"attempt":1,"trace":[{"ours":162275,"front":[{"pid":25293,"id":162275},{"pid":18158,"id":152537},{"pid":2406… |
| 18 | pixel | V8b · 面板关闭后网页回到可见（像素回到页面绿） | PASS | PASS | 页面绿 | 56,123,83 |
| 19 | pointer | V9 · 窗口缩放后重新测量坐标，真实指针点击仍然命中页面内部（落点误差 ≤ 8px） | PASS | PASS | 落点命中 | {"last":{"x":190,"y":185,"target":"paint-btn"},"click":{"ok":true,"attempt":1,"trace":[{"ours":162275,"front":[{"pid":25293,"id":162275},{"pid":18158,… |
| 20 | pixel | V9b · 缩放后截图尺寸随之变化（画面确实是缩放后的窗口） | PASS | PASS | 比例一致 | {"image":[2360,1480],"win":{"w":1180,"h":740},"frame":"07-after-resize.png"} |
| 21 | pointer | V11 · 网页**四边近边界**的真实指针命中（坐标由实测视图矩形换算；落点像素独立证明在网页内） | PASS | PASS | 四边都命中 | {"viewRect":{"left":308,"top":338,"w":830,"h":321},"probes":[{"name":"上边中点","page":{"x":415,"y":3},"screen":{"x":723,"y":341},"pixel":"56,123,83","pix… |
| 22 | pointer | V12 · 真实指针点窗口「最大化」按钮 → 窗口状态 + 网页布局真的变化，且最大化后网页仍能被真实指针命中 | PASS | PASS | 状态/布局/命中都成立 | {"frontOk":true,"button":{"label":"最大化browser","rect":{"left":218,"top":72,"w":12,"h":12},"elementAtPoint":"最大化browser","screen":{"x":368,"y":111},"po… |
| 23 | pixel | V12b · 恢复后窗口矩形与网页布局回到最大化之前，且像素真值跟着回到原位 | PASS | PASS | 尺寸/布局恢复 | {"restState":true,"click":{"ok":true,"tries":1,"trace":[{"i":0,"click":{"ok":true,"attempt":1},"received":true}]},"windowRect":{"before":{"left":164,"… |
| 24 | pixel | V10 · 连续截图可用（一段连续操作的多帧都真实落盘） | PASS | PASS | 4 帧 | {"frames":["08-burst-0.png","08-burst-1.png","08-burst-2.png","08-burst-3.png"],"bytes":[346808,346954,347041,346901]} |
| 25 | hygiene | H1 · 主进程无未处理错误 | PASS | PASS | 无错误行 | clean |
