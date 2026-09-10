const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("openarc", {
  navigate: (url) => ipcRenderer.invoke("browser:navigate", url),
  layout: (payload) => ipcRenderer.invoke("browser:layout", payload),
  action: (action) => ipcRenderer.invoke("browser:action", action),
  onBrowser: (callback) => {
    const listener = (_, state) => callback(state);
    ipcRenderer.on("browser:state", listener);
    return () => ipcRenderer.removeListener("browser:state", listener);
  },
  // 只下发只读的显示器信息，不暴露任何窗口控制能力
  onDisplay: (callback) => {
    const listener = (_, displays) => callback(displays);
    ipcRenderer.on("display:changed", listener);
    return () => ipcRenderer.removeListener("display:changed", listener);
  },
});
