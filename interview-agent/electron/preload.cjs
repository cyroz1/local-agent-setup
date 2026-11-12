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
  transcribe: (wavBytes, identifySpeaker) => ipcRenderer.invoke("audio:transcribe", wavBytes, identifySpeaker),
  enrollVoice: (wavBytes) => ipcRenderer.invoke("speaker:enroll", wavBytes),
  clearVoiceProfile: () => ipcRenderer.invoke("speaker:clear"),
  suggestAnswer: (payload) => ipcRenderer.invoke("answers:suggest", payload),
  onAnswerChunk: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("answers:chunk", listener);
    return () => ipcRenderer.removeListener("answers:chunk", listener);
  },
});
