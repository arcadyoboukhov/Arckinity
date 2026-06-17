const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('arkinityAPI', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  pickVideoFolder: () => ipcRenderer.invoke('settings:pickFolder'),
  startServer: (payload) => ipcRenderer.invoke('server:start', payload),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  getServerStatus: () => ipcRenderer.invoke('server:status'),
  openBrowser: (url) => ipcRenderer.invoke('server:openBrowser', url),
  onServerLog: (handler) => {
    ipcRenderer.on('server:log', (_event, line) => handler(line));
  },
  onServerState: (handler) => {
    ipcRenderer.on('server:state', (_event, payload) => handler(payload));
  }
});
