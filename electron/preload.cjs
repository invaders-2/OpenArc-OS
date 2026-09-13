const { contextBridge, ipcRenderer } = require("electron");

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
  navigate: (windowId, url) => ipcRenderer.invoke("browser:navigate", { windowId, url }),
  action: (windowId, action) => ipcRenderer.invoke("browser:action", { windowId, action }),
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
});
