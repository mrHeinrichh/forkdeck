const { contextBridge, ipcRenderer } = require("electron");

// Expose narrow capabilities, never ipcRenderer or a general-purpose filesystem API.
contextBridge.exposeInMainWorld("forkdeckDesktop", Object.freeze({
  chooseDirectory: () => ipcRenderer.invoke("forkdeck:choose-directory"),
  getPreferences: () => ipcRenderer.invoke("forkdeck:get-preferences"),
  setPreferences: (values) => ipcRenderer.invoke("forkdeck:set-preferences", values)
}));
