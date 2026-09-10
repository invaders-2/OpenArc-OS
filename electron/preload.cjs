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
});
