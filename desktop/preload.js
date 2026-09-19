const { contextBridge, ipcRenderer } = require("electron");

// Expose one capability, never ipcRenderer or a general-purpose filesystem API.
contextBridge.exposeInMainWorld("forkdeckDesktop", Object.freeze({
  chooseDirectory: () => ipcRenderer.invoke("forkdeck:choose-directory")
}));
