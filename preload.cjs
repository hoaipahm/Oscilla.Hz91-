'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld('green', {
  bootstrap: () => invoke('bootstrap'),
  importMusic: mode => invoke('import', mode),
  saveSettings: input => invoke('settings', input),
  saveCollections: input => invoke('collections', input),
  removeTrack: id => invoke('remove-track', id),
  trashTrack: id => invoke('trash-track', id),
  revealTrack: id => invoke('reveal-track', id),
  refreshLibrary: () => invoke('refresh-library'),
  exportLibrary: () => invoke('export'),
  onImportProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('import-progress', listener);
    return () => ipcRenderer.removeListener('import-progress', listener);
  }
});
