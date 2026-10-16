const { contextBridge, ipcRenderer, webUtils } = require("electron");

/**
 * 唯一的渲染进程桥（§37 / §38）。
 *
 * 暴露面**没有扩大** —— 仍是"只读下发 + 窄意图上行"：
 *   · 没有任何 ipcRenderer 原始对象
 *   · 没有任何 webContents / BrowserWindow / filesystem / shell
 *   · 上行只有三件事：同步窗口意图、导航、视图动作
 * 列表本身即白名单：新增能力必须同时改本文件与 electron/main.cjs，
 * 且都必须过 trusted(event) 校验。
 */
contextBridge.exposeInMainWorld("openarc", {
  /** 把 Window Manager 结算出的原生意图交给主进程。这是唯一的原生层上行通道。 */
  sync: (payload) => ipcRenderer.invoke("windows:sync", payload),
  // D5-01：tabId 可选 —— 缺省时作用于该窗口的活动标签（既有两参调用逐字不变）。
  navigate: (windowId, url, tabId) => ipcRenderer.invoke("browser:navigate", { windowId, url, tabId }),
  action: (windowId, action, tabId) => ipcRenderer.invoke("browser:action", { windowId, action, tabId }),
  /**
   * D5-01 浏览器命令面（受控白名单）：
   *   · browser/downloads（list / open / reveal / cancel / remove / clear）
   *   · browser/openExternal（**用户已确认**后才调用）
   *   · browser/controlList | controlSelect | controlRelease
   *     （D5-01 Closure-2：用户**显式选择**允许 AI 控制的标签；userId 由主进程注入，
   *       renderer 只能给 windowId/tabId，归属与存活由主进程校验）
   * 没有通用 shell / fs / 任意 IPC；downloadId 与 URL 都还要过主进程校验与 trusted(event)。
   */
  browser: (command) => ipcRenderer.invoke("browser:command", command),
  /** 原生状态（url / loading / title / 被拦截的弹窗与导航）只读下发。 */
  onNativeState: (callback) => {
    const listener = (_, state) => callback(state);
    ipcRenderer.on("native:state", listener);
    return () => ipcRenderer.removeListener("native:state", listener);
  },
  /** 只下发只读的显示器信息，不暴露任何窗口控制能力。 */
  onDisplay: (callback) => {
    const listener = (_, displays) => callback(displays);
    ipcRenderer.on("display:changed", listener);
    return () => ipcRenderer.removeListener("display:changed", listener);
  },

  /**
   * D3-01 身份桥。
   *
   * **只有两条能力**：派发领域命令、订阅身份事件。没有第三个口子。
   * 特别注意：这里**不存在**任何读取 session token 的方法 ——
   * 渲染进程拿不到 token，因此也就不可能把它写进 localStorage（§10 / §11）。
   * 命令的返回值由主进程 sanitize 后再过桥（token / verifier 一律不过）。
   */
  identity: {
    command: (command) => ipcRenderer.invoke("identity:command", command),
    onEvent: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on("identity:event", listener);
      return () => ipcRenderer.removeListener("identity:event", listener);
    },
  },

  /**
   * D3-02 对象授权桥。
   *
   * **只有一条只读能力**：下发授权查询命令。治理写操作（grant / revoke）不在桥上。
   * 这里没有暴露任何 Resource DB、Grant DB、SQL 或 session token ——
   * 渲染进程能拿到的只有本次授权的 decision / capabilities / safe metadata。
   * sessionRef 由主进程从 IdentityService 注入，渲染进程无法伪造身份。
   */
  authorization: {
    command: (command) => ipcRenderer.invoke("authorization:command", command),
  },
  /**
   * D3-03 设备桥。
   *
   * 这是本版本**唯一带写操作**的渲染进程桥（Start Pairing / Disable / Enable / Revoke，§49）。
   * 安全性不依赖"桥里只有读"，而是：
   *   ① sessionRef 由主进程从 IdentityService 注入，渲染进程无法伪造身份；
   *   ② 每个动作在 DeviceService 里都要过 SUPER_ADMIN + 动作授权；
   *   ③ 返回对象恒为 publicDevice —— 私钥 / 凭据 / pairing secret 永不出现（§48）。
   * 这里没有暴露任何 SQL、证书对象、device_credentials 或 device_access 表。
   */
  device: {
    command: (command) => ipcRenderer.invoke("device:command", command),
  },
  /**
   * D3-04A 资源桥。
   *
   * **只有受控 Resource Commands**：没有 readFile(path) / writeFile(path) /
   * deleteFile(path) 这类通用 fs 能力（§64）。手动导入 / 链接由主进程 dialog 选择文件，
   * 路径从不回到渲染进程（§14 §66）；返回值恒为 safe descriptor。
   */
  resource: {
    command: (command) => ipcRenderer.invoke("resource:command", command),
  },
  /**
   * D3-04D 治理桥。
   *
   * 治理写操作（用户 / 部门 / 权限 / App / Ownership / Scope）现在有了正式管理端，
   * 但仍**不暴露** raw SQL / raw ACL 表 / 凭据读取：只有受控治理命令；
   * sessionRef 由主进程注入，每个动作在 GovernanceService / AuthorizationService 内再次校验。
   * 返回对象是 safe projection —— password hash / salt / session token / device key 永不出现。
   */
  governance: {
    command: (command) => ipcRenderer.invoke("governance:command", command),
  },
  /**
   * D4-01 模型桥。
   *
   * 唯一入口 model.command(...)；**不暴露** raw credential / credentialRef /
   * Model Proxy capability / raw HTTP / raw SQL。sessionRef 与 appId 由主进程注入，
   * Renderer 自报的 userId/appId/role 一律忽略。
   */
  model: {
    command: (command) => ipcRenderer.invoke("model:command", command),
    /**
     * W5：模型流式调用下行事件（model:event）。
     * 事件体是主进程封装好的 P1 信封，渲染层只读；不暴露 ipcRenderer，也不新增顶层键。
     */
    onEvent: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on("model:event", listener);
      return () => ipcRenderer.removeListener("model:event", listener);
    },
  },
  /**
   * D5-03 第一批 MCP 桥。
   *
   * 唯一入口 mcp.command(...)；**不暴露** raw credential / credentialRef / 本机路径 /
   * 子进程句柄 / raw HTTP / raw SQL。本地连接只能给白名单 serverKey（程序与参数由主进程固定映射），
   * sessionRef 与 appId 由主进程注入，Renderer 自报的 userId/appId/role 一律忽略。
   * 工具调用**默认关闭**（<userData>/dxos/mcp.json 的显式开关）；开关打开后每次调用仍要单独
   * 通过审批，未批准 0 次外发（真实入口是 mcp/toolInvocation/call）。
   */
  mcp: {
    command: (command) => ipcRenderer.invoke("mcp:command", command),
  },
  /**
   * D5-02 画布桥（只给 OpenArc 宿主窗口，**画布页面本身拿不到**：它跑在 sandbox iframe 里）。
   *
   * 唯一入口 canvas.command(...)；不暴露文件路径 / 资源字节 / 模型地址 / 凭据。
   * sessionRef 与 appId 由主进程注入，Renderer 自报的身份字段一律忽略。
   */
  canvas: {
    command: (command) => ipcRenderer.invoke("canvas:command", command),
  },
  /**
   * D4-04 Task 桥。
   *
   * **只有两条能力**：派发受控 task 命令、订阅 task 进度事件。
   * Renderer 不能指定 userId / role / appId / sessionRef / modelConfig / verification ——
   * 这些都由主进程从当前 authenticated session + 真实 Task Runtime 推导。
   */
  task: {
    command: (command) => ipcRenderer.invoke("task:command", command),
    onEvent: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on("task:event", listener);
      return () => ipcRenderer.removeListener("task:event", listener);
    },
  },
  /**
   * B3 Agent 桥。
   *
   * **只有两条能力**：派发受控 agent 命令、订阅 agent 下行事件（P1 信封）。
   * 不暴露 ipcRenderer / 凭据 / 绝对路径；sessionRef 与 appId 由主进程注入，
   * Renderer 自报的 userId / role / appId 一律忽略（与 model / task 同一条 trusted 边界）。
   */
  agent: {
    command: (command) => ipcRenderer.invoke("agent:command", command),
    onEvent: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on("agent:event", listener);
      return () => ipcRenderer.removeListener("agent:event", listener);
    },
  },
  /**
   * B4 技能桥。
   *
   * **只有两条能力**：派发受控 skill 命令、订阅 skill 下行事件（P1 信封）。
   * 不暴露 ipcRenderer / 凭据 / 绝对路径；sessionRef 与 appId 由主进程注入，
   * Renderer 自报的 userId / role / appId 一律忽略（与 agent / model / task 同一条 trusted 边界）。
   */
  skill: {
    command: (command) => ipcRenderer.invoke("skill:command", command),
    onEvent: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on("skill:event", listener);
      return () => ipcRenderer.removeListener("skill:event", listener);
    },
  },
  /**
   * B5a 媒体桥（第 20 个顶层键）。
   *
   * **只有两条能力**：派发受控 media 命令、订阅 media 下行事件（P1 信封）。
   * 不暴露 ipcRenderer / ffmpeg 句柄 / 凭据 / 绝对路径；sessionRef 与 appId 由主进程注入，
   * Renderer 自报的 userId / role / appId 一律忽略（与 agent / skill / model / task 同一条 trusted 边界）。
   */
  media: {
    command: (command) => ipcRenderer.invoke("media:command", command),
    onEvent: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on("media:event", listener);
      return () => ipcRenderer.removeListener("media:event", listener);
    },
  },
  /**
   * D4-03C4 Trusted Approval Gateway 桥。
   *
   * **三条能力**：提交一个 approval decision、撤销一个"已批准、尚未执行"的操作、订阅 approval 请求事件。
   * Renderer 不能指定 userId / role / appId / sessionRef / callId / risk / planHash / effectClass /
   * argumentsHash —— 这些都由主进程从当前 authenticated session + SideEffectCall +
   * Tool Registry + Resource Domain 推导。返回值恒为 safe 投影。
   */
  sideEffect: {
    command: (command) => ipcRenderer.invoke("sideeffect:command", command),
    /** 只能给 approvalRequestId：callId / taskId / userId 由主进程从真实 call 推导。 */
    revokeApproval: ({ approvalRequestId }) => ipcRenderer.invoke("sideeffect:command", { type: "sideEffect/revokeApproval", approvalRequestId }),
    onEvent: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on("sideeffect:event", listener);
      return () => ipcRenderer.removeListener("sideeffect:event", listener);
    },
  },
  /**
   * D3-04 文件桥（**第二处显式登记的暴露面扩张**，2026-09-12）。
   *
   * 只有五件事，全部走 main.cjs 的 trusted(event) 校验：
   *   pathFor(file)            把拖进来的 File 换成磁盘路径（Electron 44 起 File.path 已移除）
   *   import(folderId, paths)  把外部文件**拷贝进** userData/files/<folderId>/
   *   list(folderId)           列出该文件夹的条目索引
   *   rename/remove            改名 / 永久删除条目（remove 保留为永久删除）
   *   trash/trashList/trashRestore/trashPurge/trashEmpty  系统回收站：软删除 / 列出 / 恢复 / 永久删除 / 清空
   * 没有暴露 fs / path / shell / 任意路径读取 —— 读写范围被 file-service.cjs
   * 的 folderId 白名单（[A-Za-z0-9_-]）与固定根目录锁死。
   */
  files: {
    pathFor: (file) => webUtils.getPathForFile(file),
    import: (folderId, paths) => ipcRenderer.invoke("files:import", { folderId, paths }),
    list: (folderId) => ipcRenderer.invoke("files:list", folderId),
    rename: (folderId, id, name) => ipcRenderer.invoke("files:rename", { folderId, id, name }),
    remove: (folderId, id) => ipcRenderer.invoke("files:remove", { folderId, id }),
    /** 系统级回收站（软删除）：删除入口走 trash，回收站窗口里才调 purge / empty。 */
    trash: (folderId, id, groupId) => ipcRenderer.invoke("files:trash", { folderId, id, groupId }),
    trashList: () => ipcRenderer.invoke("files:trashList"),
    trashRestore: (id) => ipcRenderer.invoke("files:trashRestore", { id }),
    trashPurge: (id) => ipcRenderer.invoke("files:trashPurge", { id }),
    trashEmpty: () => ipcRenderer.invoke("files:trashEmpty"),
    read: (folderId, id) => ipcRenderer.invoke("files:read", { folderId, id }),
    // 文稿：只写 .md/.txt（主进程校验扩展名与 1MB 上限），id 为空即新建
    writeText: (folderId, id, name, text) => ipcRenderer.invoke("files:writeText", { folderId, id, name, text }),
    thumb: (folderId, id, size) => ipcRenderer.invoke("files:thumb", { folderId, id, size }),
    info: (folderId, id) => ipcRenderer.invoke("files:info", { folderId, id }),
    /** 拖出到系统（Finder/桌面）：fire-and-forget，主进程用原生 startDrag。 */
    startDrag: (folderId, id) => ipcRenderer.send("files:startDrag", { folderId, id }),
    copy: (folderId, ids, toFolderId) => ipcRenderer.invoke("files:copy", { folderId, ids, toFolderId }),
    move: (folderId, ids, toFolderId) => ipcRenderer.invoke("files:move", { folderId, ids, toFolderId }),
    exportTo: (folderId, ids) => ipcRenderer.invoke("files:export", { folderId, ids }),
  },
  /**
   * B6a 自动化域桥。
   *
   * **只有两条能力**：派发受控 automation 命令（定义 CRUD / 启停 / 立即运行 / 取消 / 运行记录）、
   * 订阅 automation 下行事件（P1 信封；调度领取与每次运行的进度都走它）。
   * 不暴露 ipcRenderer / 数据库 / 凭据 / 绝对路径；sessionRef 与 appId 由主进程注入，
   * Renderer 自报的 userId / role / appId 一律忽略（与 agent / skill / media 同一条 trusted 边界）。
   */
  automation: {
    command: (command) => ipcRenderer.invoke("automation:command", command),
    onEvent: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on("automation:event", listener);
      return () => ipcRenderer.removeListener("automation:event", listener);
    },
  },
  /**
   * B6c 平台域桥（第 22 个顶层键；B6a 的 automation 是第 21 个键）。
   *
   * **只有一条能力**：派发受控 platform 命令（诊断 / 数据保护 / 网络安全 / 供应商测试安全）。
   * 不暴露 ipcRenderer / 环境变量 / 绝对路径 / 凭据；sessionRef 与 appId 由主进程注入，
   * Renderer 自报的 userId / role / appId 一律忽略（与 agent / skill / media 同一条 trusted 边界）。
   */
  platform: {
    command: (command) => ipcRenderer.invoke("platform:command", command),
  },
  /**
   * B7a 开发者平台桥（第 23 个顶层键；第 22 是 B6c 的 platform）。
   *
   * **只有一条能力**：派发受控 developer 命令（本地 App 装载 / 启用 / 禁用 / 回滚 / 卸载 / 清单校验 /
   * 凭据引用 / 出网判定）。不暴露 ipcRenderer / 包目录绝对路径 / 凭据密钥；sessionRef 与 appId 由
   * 主进程注入，Renderer 自报的 userId / role / appId 一律忽略（与 platform / automation 同一条 trusted 边界）。
   */
  developer: {
    command: (command) => ipcRenderer.invoke("developer:command", command),
  },
  /**
   * B7c 可选插件桥（平台域之后的第 24 个顶层键）。
   *
   * **只有一条能力**：派发受控 integration 命令（插件开关 / 依赖健康 / 钉钉·天气·黄历）。
   * 三个插件默认全关；缺依赖或运行时能力未注入一律结构化
   * { ok:false, error:"INTEGRATION_UNAVAILABLE", detail }，不假实现。
   * 不暴露 ipcRenderer / 凭据 / 绝对路径；sessionRef 与 appId 由主进程注入，
   * Renderer 自报的 userId / role / appId 一律忽略（与 platform / automation 同一条 trusted 边界）。
   */
  integration: {
    command: (command) => ipcRenderer.invoke("integration:command", command),
  },
  /**
   * B7c 本地市场桥（第 25 个顶层键）。
   *
   * **只有一条能力**：派发受控 market 命令，只读"随包 / 本地目录"的 catalog.json。
   * **不联网、不下载、不安装**；云发布 / 审核 / 灰度 / 市场远端服务（api.dx-os.com）一律 OUT。
   */
  market: {
    command: (command) => ipcRenderer.invoke("market:command", command),
  },
  // —— 10-15 新增的本地能力键：追加在 DX OS 契约键之后，保持既有键序不变 ——
  /**
   * 天气（10-15）：只能给城市名 / 经纬度，出网 URL 由主进程拼装（固定 Open-Meteo 两个主机）。
   */
  /**
   * 视频剪辑（10-15）：只给条目引用 + 入出点；FFmpeg 参数与输出位置由主进程决定。
   */
  video: {
    status: () => ipcRenderer.invoke("video:status"),
    probe: (folderId, id) => ipcRenderer.invoke("video:probe", { folderId, id }),
    export: (payload) => ipcRenderer.invoke("video:export", payload),
    cancel: () => ipcRenderer.invoke("video:cancel"),
    onProgress: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on("video:progress", listener);
      return () => ipcRenderer.removeListener("video:progress", listener);
    },
  },
  /** 图片声明（10-15）：只给条目引用与声明类型（ai / mix），写入与另存都在主进程。 */
  image: {
    declare: (items, kind) => ipcRenderer.invoke("image:declare", { items, kind }),
  },
  /** 系统信息（10-15）：版本、平台、磁盘与 OpenArc 数据占用的汇总数字（只读）。 */
  system: {
    info: () => ipcRenderer.invoke("system:info"),
  },
  weather: {
    geocode: (name) => ipcRenderer.invoke("weather:geocode", { name }),
    forecast: (lat, lon) => ipcRenderer.invoke("weather:forecast", { lat, lon }),
  },
  // —— 0.6.1 新增五域：追加在既有键之后，保持前面所有键的 index 逐字不变 ——
  /**
   * 系统字体域桥（第 30 个顶层键）。
   *
   * **只有两条能力**：派发受控 systemFonts 命令（字体清单 / 按 id 读字节）、订阅 systemFonts 下行事件。
   * 不暴露 ipcRenderer / 字体绝对路径 / 通用 fs；sessionRef 与 appId 由主进程注入，
   * Renderer 自报的 userId / role / appId 一律忽略（与 model / media 同一条 trusted 边界）。
   */
  systemFonts: {
    command: (command) => ipcRenderer.invoke("systemFonts:command", command),
    onEvent: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on("systemFonts:event", listener);
      return () => ipcRenderer.removeListener("systemFonts:event", listener);
    },
  },
  /**
   * OCR 域桥（第 31 个顶层键）。
   *
   * **只有两条能力**：派发受控 ocr 命令（provider/list、ocr/recognize）、订阅 ocr 下行事件。
   * 供应商密钥只在主进程内解出并通过既有 provider-protocol store 读取，桥面拿不到
   * api_key / credentialRef / ipcRenderer；sessionRef 由主进程注入。
   */
  ocr: {
    command: (command) => ipcRenderer.invoke("ocr:command", command),
    onEvent: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on("ocr:event", listener);
      return () => ipcRenderer.removeListener("ocr:event", listener);
    },
  },
  /**
   * 文件传输域桥（第 32 个顶层键）。
   *
   * **只有一条能力**：派发受控 fileTransfer 命令（begin / chunk / complete / status / cancel /
   * cleanup / health）。没有通用 fs / 任意路径读取；落盘根固定由主进程决定，
   * 身份由主进程注入，Renderer 自报的 userId / owner 一律忽略。
   */
  fileTransfer: {
    command: (command) => ipcRenderer.invoke("fileTransfer:command", command),
  },
  /**
   * codex-canvas 域桥（第 33 个顶层键）。
   *
   * **只有两条能力**：派发受控 codexCanvas 命令（status / pair / revoke / relay / setup / install /
   * commands）、订阅 codexCanvas 下行事件。中继只落到**既有**画布服务，不自起 HTTP、不新建画布、
   * 不实现云能力；桥面拿不到 MCP 令牌以外的内部句柄或 ipcRenderer。
   * 独立通道的原因（并入 canvas:command 需改冻结白名单）见 electron/main.cjs 注册块注释。
   */
  codexCanvas: {
    command: (command) => ipcRenderer.invoke("codexCanvas:command", command),
    onEvent: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on("codexCanvas:event", listener);
      return () => ipcRenderer.removeListener("codexCanvas:event", listener);
    },
  },
  /**
   * 本机代理探测桥（第 34 个顶层键）。
   *
   * **只有一条能力**：派发受控 desktop 命令（当前唯一命令 desktop/proxy/detect）。
   * 默认零出网（payload.probe === true 才试连）；不暴露子进程句柄 / 原始 netstat 文本 /
   * 环境变量 / ipcRenderer。独立通道的原因（并入 platform:command 需改冻结白名单）
   * 见 electron/main.cjs 注册块注释。
   */
  desktop: {
    command: (command) => ipcRenderer.invoke("desktop:command", command),
  },
  // —— 0.6.2 新增三域：追加在既有键之后，保持前面所有键的 index 逐字不变 ——
  /**
   * photos 域桥（第 35 个顶层键）。
   *
   * **只有一条能力**：派发受控 photos 命令（来源 / 虚拟文件夹 / 图库 / 源字节 / 缩略图 /
   * 导入 / 反向提示词 / 视觉模型 / 抠图 / health）。不暴露 ipcRenderer / 来源绝对路径 / 通用 fs；
   * sessionRef 与 appId 由主进程注入，renderer 自报的 userId / owner / appId 一律忽略。
   */
  photos: {
    command: (command) => ipcRenderer.invoke("photos:command", command),
  },
  /**
   * PhotoCraft 域桥（第 36 个顶层键）。
   *
   * **只有一条能力**：派发受控 photocraft 命令（项目 / 分组 / 源文件 / 导出 / 剪贴板 / 回收站）。
   * 不暴露 ipcRenderer / 虚拟树绝对路径；sessionRef 与 appId 由主进程注入，
   * renderer 自报的 userId / owner / appId 一律忽略。
   */
  photocraft: {
    command: (command) => ipcRenderer.invoke("photocraft:command", command),
  },
  /**
   * 应用互传域桥（第 37 个顶层键）。
   *
   * **只有一条能力**：派发受控 appExchange 命令（targets / get / inspect / exchange /
   * appExchange-images）。只传引用不传字节；不暴露 ipcRenderer / 宿主路径 / 凭据；
   * sessionRef 与 appId 由主进程注入，renderer 自报的 userId / appId 一律忽略。
   */
  appExchange: {
    command: (command) => ipcRenderer.invoke("appExchange:command", command),
  },
  // —— CLI 域：追加在既有键之后，保持前面所有键的 index 逐字不变 ——
  /**
   * CLI 域桥（第 38 个顶层键）。
   *
   * **只有一条能力**：派发受控 cli 命令（list / status / models / credit /
   * login/start / login/status / logout）。不暴露 ipcRenderer / 子进程句柄 / 凭据；
   * 探测与执行全部转发到既有 CLI 出口；sessionRef 与 appId 由主进程注入，
   * renderer 自报的 userId / role / appId 一律忽略。
   */
  cli: {
    command: (command) => ipcRenderer.invoke("cli:command", command),
  },
  // —— Stage 1 在线更新：追加在既有键之后，保持前面所有键的 index 逐字不变 ——
  /**
   * 画布在线更新桥（第 39 个顶层键）。
   *
   * **只有一条能力**：派发受控 market/update 命令（status / check / install / rollback / sources / source/set）。
   * 命令通道复用既有 market:command（唯一通道，命令表由 market-update-domain.cjs 冻结）；
   * 安装必须由用户显式触发并带 confirm:true，主进程再走验签→验摘要→解压围栏→原子切换→审计，
   * 不暴露 ipcRenderer / 签名私钥 / 绝对路径 / 任意 URL；owner/repo 也不由渲染层决定，
   * 只能从注册表里选 kind + owner/repo（不接受任意 URL）。
   */
  marketUpdate: {
    command: (command) => ipcRenderer.invoke("market:command", command),
  },
});
