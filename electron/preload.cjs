const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pet", {
  bootstrap: () => ipcRenderer.invoke("app:bootstrap"),
  sendMessage: (payload) => ipcRenderer.invoke("chat:send", payload),
  cancelChat: (requestId) => ipcRenderer.invoke("chat:cancel", requestId),
  onChatStream: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("chat:stream", listener);
    return () => ipcRenderer.removeListener("chat:stream", listener);
  },
  newChat: () => ipcRenderer.invoke("chat:new"),
  transcribe: (payload) => ipcRenderer.invoke("voice:transcribe", payload),
  getRecords: (payload) => ipcRenderer.invoke("data:records", payload),
  getDashboard: () => ipcRenderer.invoke("data:dashboard"),
  consolidate: (date) => ipcRenderer.invoke("memory:consolidate", date),
  scanTopics: () => ipcRenderer.invoke("memory:scan-topics"),
  evaluateContinuity: () => ipcRenderer.invoke("continuity:evaluate"),
  continuityProfileAction: (payload) => ipcRenderer.invoke("continuity:profile-action", payload),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  testConnection: (settings) => ipcRenderer.invoke("settings:test", settings),
});
