'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  getSources: () => ipcRenderer.invoke('sources:get'),
  saveSources: (list) => ipcRenderer.invoke('sources:save', list),
  testSource: (url) => ipcRenderer.invoke('sources:test', { url }),
  search: (keyword, deep) => ipcRenderer.invoke('search:run', { keyword, deep }),
  browseClasses: (url) => ipcRenderer.invoke('browse:classes', { url }),
  browseList: (url, typeId, page) => ipcRenderer.invoke('browse:list', { url, typeId, page }),
  browseTagged: (tag, page) => ipcRenderer.invoke('browse:tagged', { tag, page }),
  getConfig: () => ipcRenderer.invoke('app:config'),
  saveConfig: (patch) => ipcRenderer.invoke('app:config:save', patch),
  refreshSources: () => ipcRenderer.invoke('sources:refresh'),
  onSourcesRefreshed: (cb) => ipcRenderer.on('sources:refreshed', (_e, data) => { try { cb(data); } catch (_) {} }),
  resolveStream: (url) => ipcRenderer.invoke('stream:resolve', { url }),
  lanInfo: () => ipcRenderer.invoke('lan:info'),
  onLanReady: (cb) => ipcRenderer.on('lan:ready', (_e, data) => { try { cb(data); } catch (_) {} }),
  uiZoom: (action) => ipcRenderer.invoke('ui:zoom', action),
  downloadStart: (job) => ipcRenderer.invoke('dl:start', job),
  downloadCancel: (id) => ipcRenderer.invoke('dl:cancel', id),
  onDownloadProgress: (cb) => ipcRenderer.on('dl:progress', (_e, data) => { try { cb(data); } catch (_) {} }),
  openDownloadDir: () => ipcRenderer.invoke('dl:openDir'),
  getFavorites: () => ipcRenderer.invoke('favorites:get'),
  saveFavorites: (list) => ipcRenderer.invoke('favorites:save', list),
  getHistory: () => ipcRenderer.invoke('history:get'),
  saveHistory: (list) => ipcRenderer.invoke('history:save', list),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  openDataDir: () => ipcRenderer.invoke('shell:datadir')
});
