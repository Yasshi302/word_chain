'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadDictionary: () => ipcRenderer.invoke('load-dictionary'),
  loadCustomWords: () => ipcRenderer.invoke('load-custom-words'),
  getCustomDict: () => ipcRenderer.invoke('get-custom-dict'),
  addCustomWord: (word) => ipcRenderer.invoke('add-custom-word', word),
  removeCustomWord: (word) => ipcRenderer.invoke('remove-custom-word', word),
  setCustomDict: (payload) => ipcRenderer.invoke('set-custom-dict', payload),

  // 自動更新 (取得元は常にGitHub Releases。main.js/updater.js参照)
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  downloadUpdate: (info) => ipcRenderer.invoke('download-update', info),
  onUpdateDownloadProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('update-download-progress', listener);
    return () => ipcRenderer.removeListener('update-download-progress', listener);
  },
  applyUpdate: (info) => ipcRenderer.invoke('apply-update', info),
  hasBackup: () => ipcRenderer.invoke('has-backup'),
  rollbackUpdate: () => ipcRenderer.invoke('rollback-update'),
  saveResumeIntent: (intent) => ipcRenderer.invoke('save-resume-intent', intent),
  getResumeIntent: () => ipcRenderer.invoke('get-resume-intent'),
});
