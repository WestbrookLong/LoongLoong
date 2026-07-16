const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pet", {
  bootstrap: () => ipcRenderer.invoke("app:bootstrap"),
  sendMessage: (payload) => ipcRenderer.invoke("chat:send", payload),
  newChat: () => ipcRenderer.invoke("chat:new"),
  transcribe: (payload) => ipcRenderer.invoke("voice:transcribe", payload),
  getRecords: (payload) => ipcRenderer.invoke("data:records", payload),
  getDashboard: () => ipcRenderer.invoke("data:dashboard"),
  consolidate: (date) => ipcRenderer.invoke("memory:consolidate", date),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  testConnection: (settings) => ipcRenderer.invoke("settings:test", settings),
});
