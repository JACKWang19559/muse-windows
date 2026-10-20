const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = operation => payload => ipcRenderer.invoke('muse:invoke', operation, payload);
const api = {};
api.exportFile = call('exportFile');
api.renameFile = call('renameFile');
api.readImageFile = call('readImageFile');
api.readVideoFile = call('readVideoFile');
api.readPdfFile = call('readPdfFile');
api.readPdfAsset = call('readPdfAsset');
api.cancelSendAdmission = call('cancelSendAdmission');
for(const name of ['startDictation','dictationCaptureReady','finishDictation','cancelDictation','getDictationState'])api[name]=call(name);
for(const name of ['prepareAudio','updateAudioState','stopAudio','getAudioState'])api[name]=call(name);
for (const name of ['bootstrap','saveSettings','testConnection','listModels','createWorkspace','updateWorkspace','deleteWorkspace','createChat','updateChat','deleteChat','searchMessages','deleteTurn','sendMessage','cancelQueuedMessage','stopGeneration','respondApproval','retryMessage','importFiles','removeFile','createTextFile','saveTextFile','readFile','openFile','exportChat','exportData','importData','copyText','openExternal','windowControl','createArtifact','writeArtifactFiles','readArtifactFile','buildArtifact','deleteArtifact','openArtifactPreview','activateArtifactPreview','closeArtifactPreview','artifactRequest','exportArtifact']) api[name] = call(name);
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
for(const name of ['previewSchedule','createSchedule','updateSchedule','pauseSchedule','deleteSchedule','runScheduleNow','stopSchedule','saveBackgroundSettings'])api[name]=call(name);
for(const name of ['getMemoryDocument','saveMemoryDocument','deleteMemoryDocument','createMemory','getMemory','updateMemory','deleteMemory','rebuildMemoryIndex','searchMemories','getSkill','importSkillPackage','replaceSkillPackage','updateSkill','deleteSkill','setSkillConsent','getAgentProfile','createAgentProfile','updateAgentProfile','captureProfileKnowledge','refreshProfileKnowledge','removeProfileKnowledge','reviewAgentProfile','deleteAgentProfile','previewSelectedContext'])api[name]=call(name);
if (typeof process === 'undefined' || process.isMainFrame !== false) contextBridge.exposeInMainWorld('muse', Object.freeze(api));
