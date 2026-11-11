const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("interviewAgent", {
  listSources: () => ipcRenderer.invoke("sources:list"),
  selectSource: (sourceId) => ipcRenderer.invoke("sources:select", sourceId),
  enterOverlay: () => ipcRenderer.invoke("window:overlay"),
  returnToPrepare: () => ipcRenderer.invoke("window:prepare"),
  setClickThrough: (enabled) => ipcRenderer.invoke("window:click-through", enabled),
  onClickThroughChanged: (callback) => {
    const listener = (_event, enabled) => callback(Boolean(enabled));
    ipcRenderer.on("window:click-through-changed", listener);
    return () => ipcRenderer.removeListener("window:click-through-changed", listener);
  },
  minimize: () => ipcRenderer.invoke("window:minimize"),
  close: () => ipcRenderer.invoke("window:close"),
  checkServices: () => ipcRenderer.invoke("services:check"),
  transcribe: (wavBytes) => ipcRenderer.invoke("audio:transcribe", wavBytes),
  suggestAnswer: (payload) => ipcRenderer.invoke("answers:suggest", payload),
});
