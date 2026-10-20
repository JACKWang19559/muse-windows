const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = operation => payload => ipcRenderer.invoke('muse:invoke', operation, payload);
const api = {};
for (const name of ['bootstrap','saveSettings','testConnection','listModels','createWorkspace','updateWorkspace','deleteWorkspace','createChat','updateChat','deleteChat','sendMessage','stopGeneration','retryMessage','importFiles','removeFile','createTextFile','saveTextFile','readFile','openFile','exportChat','exportData','importData','copyText','openExternal','windowControl']) api[name] = call(name);
api.importDroppedFiles = (files, workspaceId) => {
  const paths = Array.from(files || [], file => webUtils.getPathForFile(file));
  if (!paths.length || paths.some(p => !p)) return Promise.reject(new Error('请选择本机的真实文件。'));
  return ipcRenderer.invoke('muse:invoke', 'importDroppedPaths', { paths, workspaceId });
};
api.subscribe = callback => {
  if (typeof callback !== 'function') throw new Error('事件处理器无效。');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on('muse:event', listener);
  return () => ipcRenderer.removeListener('muse:event', listener);
};
contextBridge.exposeInMainWorld('muse', Object.freeze(api));
