const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('openReel', {
  search: (query, page) => ipcRenderer.invoke('catalog:search', query, page),
  addTorrent: (input) => ipcRenderer.invoke('torrent:add', input),
  listDownloads: () => ipcRenderer.invoke('torrent:list'),
  pause: (id) => ipcRenderer.invoke('torrent:pause', id),
  resume: (id) => ipcRenderer.invoke('torrent:resume', id),
  remove: (id, deleteFiles) => ipcRenderer.invoke('torrent:remove', id, deleteFiles),
  pickVideo: () => ipcRenderer.invoke('library:pick'),
  listLibrary: (folder) => ipcRenderer.invoke('library:list', folder),
  openLibraryFile: (filePath) => ipcRenderer.invoke('library:open-file', filePath),
  getThumbnail: (filePath) => ipcRenderer.invoke('library:thumbnail', filePath),
  onMediaStatus: (callback) => { const listener = (_event, data) => callback(data); ipcRenderer.on('media:status', listener); return () => ipcRenderer.removeListener('media:status', listener); },
  openDownloaded: (id, fileIndex) => ipcRenderer.invoke('library:open-download', id, fileIndex),
  openFolder: () => ipcRenderer.invoke('downloads:open-folder'),
  getDirectory: () => ipcRenderer.invoke('downloads:directory'),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  onTorrentUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('torrent:update', listener);
    return () => ipcRenderer.removeListener('torrent:update', listener);
  }
});