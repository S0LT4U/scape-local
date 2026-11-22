'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scapeHost', {
  isElectron: true,
  setStatus: (s) => ipcRenderer.send('status', s),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (on) => ipcRenderer.invoke('autostart:set', on),
  hide: () => ipcRenderer.send('window:hide'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  apoStatus: () => ipcRenderer.invoke('apo:status'),
  apoSet: (db) => ipcRenderer.invoke('apo:set', db),
  apoSetMic: (db) => ipcRenderer.invoke('apo:setMic', db),
});
