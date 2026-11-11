const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("interviewAgent", {
  listSources: () => ipcRenderer.invoke("sources:list"),
  selectSource: (sourceId) => ipcRenderer.invoke("sources:select", sourceId),
  enterOverlay: () => ipcRenderer.invoke("window:overlay"),
  returnToPrepare: () => ipcRenderer.invoke("window:prepare"),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  close: () => ipcRenderer.invoke("window:close"),
  checkServices: () => ipcRenderer.invoke("services:check"),
  transcribe: (wavBytes) => ipcRenderer.invoke("audio:transcribe", wavBytes),
  suggestAnswer: (payload) => ipcRenderer.invoke("answers:suggest", payload),
});
