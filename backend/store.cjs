'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { MAX_FILE_BYTES, MAX_TEXT_CHARS, TEXT_EXTENSIONS, describeFile, extractDocument } = require('./documents.cjs');
const { normalizeToolTrace, cancelToolTrace, hasUnfinishedToolCalls, remapToolTrace } = require('./tool-trace.cjs');
const { MAX_ARTIFACTS, strictRecord: artifactInput, validArray: artifactArray, artifactPath, revision: artifactRevision, dataKey: artifactDataKey, jsonValue: artifactJson, fileBytes: artifactFileBytes, sourceDigest, validateArtifactFiles, validateArtifactBuild, validateArtifact, publicArtifact, starterFiles } = require('./artifact-model.cjs');
const scheduleModel = require('./scheduler-model.cjs');
const knowledge = require('./knowledge-model.cjs');
const { normalizeCadence, nextOccurrence } = require('./schedule-time.cjs');

const STATE_VERSION = 1;
const BACKUP_FORMAT = 'muse-windows-backup';
const MAX_BACKUP_BYTES = 250 * 1024 * 1024;
const MAX_BACKUP_JSON_BYTES = 150 * 1024 * 1024;
const MAX_STATE_BYTES = 100 * 1024 * 1024;
const MAX_EDITABLE_FILE_BYTES = 1024 * 1024;
const MAX_REPLY_EXCERPT_CHARS = 2000;
const FILE_EDIT_DIRECTORY = /^\.file-edit-[0-9a-f-]{36}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const DEFAULTS = { baseUrl: 'https://api.openai.com/v1', model: '', systemPrompt: '你是一位认真、清晰、乐于协作的 AI 助手。请优先使用中文回答，并明确区分事实与推测。', temperature: 0.7, theme: 'system', language: 'zh', speechBaseUrl: '', transcriptionModel: '', synthesisModel:'', synthesisVoice:'', dictationAutoSend: false, backgroundTasks: false };
const SETTINGS_KEYS = Object.keys(DEFAULTS);
const stamp = () => new Date().toISOString();
const uid = kind => `${kind}_${crypto.randomUUID()}`;
const copy = value => structuredClone(value);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function safeTextName(value) {
  const name = safeName(value), stem = name.split('.')[0].replace(/[. ]+$/, '');
  if (/[\p{Cc}\p{Cf}]/u.test(name) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(stem)) fail('文件名包含控制字符或 Windows 保留名称。');
  if (!TEXT_EXTENSIONS.has(describeFile(name).ext)) fail('只能创建文本、Markdown、代码、JSON 或 CSV 等文本文件。');
  return name;
}
function decodeEditableText(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) fail('文本包含不支持的控制字符。');
  return text.replace(/\r\n?/g, '\n');
}
function textFileBytes(content) {
  string(content, '文本内容', MAX_TEXT_CHARS);
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_EDITABLE_FILE_BYTES || bytes.toString('utf8') !== content) fail('文本不是有效的 UTF-8，或超过 1 MB 编辑上限。');
  decodeEditableText(bytes);
  return bytes;
}

function fail(message) { throw new Error(message); }
function filesystemFailure(error, message) { if (typeof error?.code === 'string') fail(message); throw error; }
function record(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}格式无效。`); return value; }
function string(value, label, max, { empty = true } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || value.includes('\0')) fail(`${label}无效或超出长度限制。`);
  return value;
}
function identifier(value, label = '标识符') { if (typeof value !== 'string' || !ID.test(value)) fail(`${label}无效。`); return value; }
function date(value) { if (typeof value !== 'string' || value.length > 50 || !Number.isFinite(Date.parse(value))) fail('日期格式无效。'); return value; }
function onlyKeys(value, allowed, label) { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}包含不支持的字段：${key.slice(0, 80)}。`); }
function safeName(name) {
  string(name, '文件名', 240, { empty: false });
  if (name === '.' || name === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) fail('文件名包含不安全的字符或路径。');
  return name;
}
function validateSettings(value, current = DEFAULTS, patch = false) {
  record(value, '设置');
  const result = { ...current };
  for (const key of SETTINGS_KEYS) if (key in value) {
    if (key === 'backgroundTasks' || key === 'dictationAutoSend') { if (typeof value[key] !== 'boolean') fail('偏好选项必须是布尔值。'); result[key] = value[key]; }
    else if (key === 'temperature') { if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 2) fail('温度必须在 0 到 2 之间。'); result[key] = value[key]; }
    else if (key === 'theme') { if (!['light', 'dark', 'system'].includes(value[key])) fail('主题设置无效。'); result[key] = value[key]; }
    else if (key === 'language') { if (value[key] !== 'zh') fail('语言设置无效。'); result[key] = 'zh'; }
    else result[key] = string(value[key], '设置字段', key === 'systemPrompt' ? 50000 : ['baseUrl','speechBaseUrl'].includes(key) ? 2048 : ['transcriptionModel','synthesisModel'].includes(key)?600:key==='synthesisVoice'?200:500).trim();
  }
  if (!patch) onlyKeys(value, SETTINGS_KEYS, '设置');
  if (result.baseUrl) {
    let url; try { url = new URL(result.baseUrl); } catch { fail('API 地址无效，请填写完整的 HTTP/HTTPS 地址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('API 地址仅支持 HTTP/HTTPS，且不能包含登录信息或片段。');
  }
  if (result.speechBaseUrl) require('./asr-provider.cjs').normalizeSpeechBaseUrl(result.speechBaseUrl);
  if ([...result.transcriptionModel].length>300 || /[\u0000-\u001f\u007f]/.test(result.transcriptionModel)) fail('语音模型名称无效。');
  if ([...result.synthesisModel].length>300 || /[\p{Cc}\p{Cf}]/u.test(result.synthesisModel) || Buffer.from(result.synthesisModel).toString('utf8')!==result.synthesisModel || [...result.synthesisVoice].length>100 || /[\p{Cc}\p{Cf}]/u.test(result.synthesisVoice)||Buffer.from(result.synthesisVoice).toString('utf8')!==result.synthesisVoice) fail('声音试听模型或声音 ID 无效。');
  return result;
}
function workspaceShape(value) {
  record(value, '工作区');
  return { id: identifier(value.id), name: string(value.name, '工作区名称', 160, { empty: false }), description: string(value.description, '工作区描述', 4000), color: /^#[0-9a-fA-F]{6}$/.test(value.color) ? value.color : fail('工作区颜色无效。'), createdAt: date(value.createdAt), updatedAt: date(value.updatedAt) };
}
function replyShape(value) {
  record(value, '消息引用'); onlyKeys(value, ['messageId', 'role', 'excerpt'], '消息引用');
  if (!['user', 'assistant'].includes(value.role)) fail('引用消息角色无效。');
  return { messageId: identifier(value.messageId, '引用消息标识符'), role: value.role, excerpt: string(value.excerpt, '引用摘录', MAX_REPLY_EXCERPT_CHARS) };
}
function replyExcerpt(content) {
  let excerpt = content.slice(0, MAX_REPLY_EXCERPT_CHARS);
  if (/[\uD800-\uDBFF]/.test(excerpt.at(-1) || '')) excerpt = excerpt.slice(0, -1);
  return excerpt;
}
function messageShape(value) {
  record(value, '消息');
  if (!['user', 'assistant'].includes(value.role)) fail('消息角色无效。');
  if (value.status != null && !['complete', 'streaming', 'error', 'cancelled'].includes(value.status)) fail('消息状态无效。');
  const result = { id: identifier(value.id), role: value.role, content: string(value.content, '消息内容', 2000000), createdAt: date(value.createdAt) };
  if (value.status != null) result.status = value.status;
  if (value.error != null) result.error = string(value.error, '消息错误说明', 4000);
  if (value.agentMode != null) { if (value.role !== 'assistant' || typeof value.agentMode !== 'boolean') fail('文件助手模式无效。'); result.agentMode = value.agentMode; }
  if (value.toolTrace != null) { if (value.role !== 'assistant' || !value.agentMode) fail('工具记录只能属于文件助手回复。'); result.toolTrace = normalizeToolTrace(value.toolTrace); }
  if (value.replyTo != null) { if (value.role !== 'user') fail('只有用户消息可携带回复引用。'); result.replyTo = replyShape(value.replyTo); }
  if (value.artifactContext != null) { if (value.role !== 'user') fail('只有用户消息可携带应用选区。'); result.artifactContext = require('./artifact-annotation.cjs').annotationShape(value.artifactContext); }
  if (value.activePanel != null) { if (value.role !== 'user') fail('只有用户消息可携带当前应用引用。'); result.activePanel = require('./active-panel.cjs').activePanelShape(value.activePanel); }
  if (value.isDeleted != null) { if (value.role !== 'user' || typeof value.isDeleted !== 'boolean') fail('消息删除状态无效。'); result.isDeleted = value.isDeleted; }
  if (value.attachmentIds != null) {
    if (!Array.isArray(value.attachmentIds) || value.attachmentIds.length > 100) fail('附件列表无效。');
    result.attachmentIds = [...new Set(value.attachmentIds.map(id => identifier(id, '附件标识符')))];
  }
  if (result.isDeleted && (result.content !== '' || result.attachmentIds != null || result.replyTo != null || result.artifactContext != null || result.activePanel != null || result.error || result.status != null && result.status !== 'complete')) fail('已删除消息不能保留正文、附件、引用、选区、当前应用或活动状态。');
  return result;
}
function chatShape(value) {
  record(value, '对话');
  if (typeof value.pinned !== 'boolean' || !Array.isArray(value.messages) || value.messages.length > 20000) fail('对话格式无效。');
  const result = { id: identifier(value.id), title: string(value.title, '对话标题', 200, { empty: false }), workspaceId: value.workspaceId === null ? null : identifier(value.workspaceId), createdAt: date(value.createdAt), updatedAt: date(value.updatedAt), pinned: value.pinned, messages: value.messages.map(messageShape) };
  if (value.profileId != null) result.profileId = identifier(value.profileId); return result;
}
function publicFile(value) {
  const result = { id: value.id, name: value.name, mime: value.mime, size: value.size, workspaceId: value.workspaceId, createdAt: value.createdAt, textStatus: value.textStatus };
  if (value.textPreview) result.textPreview = value.textPreview;
  if (value.error) result.error = value.error;
  if (value._sha256) result.sha256 = value._sha256;
  return result;
}
function fileShape(value, internal = false) {
  record(value, '文件记录');
  if (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_FILE_BYTES || !['ready', 'unsupported', 'error'].includes(value.textStatus)) fail('文件记录格式无效。');
  const result = { id: identifier(value.id), name: safeName(value.name), mime: string(value.mime, '文件类型', 200, { empty: false }), size: value.size, workspaceId: value.workspaceId === null ? null : identifier(value.workspaceId), createdAt: date(value.createdAt), textStatus: value.textStatus };
  if (value.textPreview != null) result.textPreview = string(value.textPreview, '文件预览', 1500);
  if (value.error != null) result.error = string(value.error, '文件错误说明', 2000);
  if (internal) {
    const expected = `${result.id}.${describeFile(result.name).managedExtension}`;
    if (value._storedName !== expected || value._textName !== `${result.id}.text` || typeof value._textTruncated !== 'boolean') fail('本地文件路径记录无效。');
    result._storedName = expected; result._textName = value._textName; result._textTruncated = value._textTruncated;
    if (value._sha256 != null) { if (typeof value._sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value._sha256)) fail('本地文件校验值无效。'); result._sha256 = value._sha256; }
    if (value._contentRevision != null) result._contentRevision = identifier(value._contentRevision, '文件内容版本');
  }
  return result;
}
function unique(values, label) { if (new Set(values).size !== values.length) fail(`${label}存在重复的标识符。`); }
function knowledgeFields(value) {
  return { memoryDocuments: value.memoryDocuments === undefined ? [] : knowledge.array(value.memoryDocuments, 1001).map(knowledge.memoryDocument), memories: value.memories === undefined ? [] : knowledge.array(value.memories, knowledge.MAX_MEMORIES).map(knowledge.memory), skills: value.skills === undefined ? [] : knowledge.array(value.skills, knowledge.MAX_SKILLS).map(knowledge.skill), agentProfiles: value.agentProfiles === undefined ? [] : knowledge.array(value.agentProfiles, knowledge.MAX_PROFILES).map(knowledge.profile), memoryIndexes: value.memoryIndexes === undefined ? [] : knowledge.array(value.memoryIndexes, 1001).map(item => require('./knowledge-search.cjs').validateMemoryIndex(item)) };
}
function knowledgeSource(state, kind, id) {
  const collections = { memory_document: 'memoryDocuments', memory: 'memories', file: 'files', chat: 'chats', artifact: 'artifacts' };
  return (state[collections[kind]] || []).find(item => item.id === id);
}
function validSkillRef(state, profile, ref) {
  const skill = state.skills.find(item => item.id === ref.skillId), consent = skill?.consents.find(item => item.id === ref.consentId);
  return Boolean(skill && skill.workspaceId === profile.workspaceId && skill.enabled && skill.eligible && skill.digest === ref.digest && consent && consent.workspaceId === profile.workspaceId && consent.digest === skill.digest && consent.policyRevision === knowledge.POLICY_REVISION);
}
function validateKnowledgeRelations(state) {
  const workspaces = new Set(state.workspaces.map(item => item.id)), documents = new Map((state.memoryDocuments || []).map(item => [item.id, item])), profiles = new Map((state.agentProfiles || []).map(item => [item.id, item]));
  for (const key of ['memoryDocuments','memories','skills','agentProfiles']) { unique((state[key] || []).map(item => item.id), '知识记录'); for (const item of state[key] || []) if (item.workspaceId !== null && !workspaces.has(item.workspaceId)) fail('知识记录引用了不存在的工作区。'); }
  unique((state.memoryDocuments || []).map(item => item.workspaceId), '记忆文档范围'); unique((state.memoryIndexes || []).map(item => item.workspaceId), '记忆索引范围');
  for (const index of state.memoryIndexes || []) if (index.workspaceId !== null && !workspaces.has(index.workspaceId)) fail('记忆索引引用了不存在的工作区。');
  for (const index of state.memoryIndexes || []) {
    for (const doc of index.documents) { const memory = (state.memories || []).find(item => item.id === doc.id); if (!memory || memory.workspaceId !== index.workspaceId || doc.revision > memory.revision) fail('记忆索引引用了不存在、跨范围或未来版本的条目。'); }
    if (index.status === 'ready' && index.sourceDigest === require('./knowledge-search.cjs').memorySourceDigest(state.memories, index.workspaceId)) {
      const current = state.memories.filter(item => item.workspaceId === index.workspaceId); if (current.length !== index.documents.length || index.documents.some(doc => { const item = current.find(item => item.id === doc.id); return item.revision !== doc.revision || item.digest !== doc.digest; })) fail('记忆索引文档与来源不一致。');
    }
  }
  for (const memory of state.memories || []) if (memory.provenance.kind !== 'manual') {
    const source = knowledgeSource(state, memory.provenance.kind, memory.provenance.sourceId);
    if (!source || source.workspaceId !== memory.workspaceId) fail('记忆来源必须存在并属于同一范围。');
    if (memory.provenance.sourceRevision !== undefined && (source.revision ?? source.sourceRevision) !== undefined && memory.provenance.sourceRevision > (source.revision ?? source.sourceRevision)) fail('记忆来源不能指向未来版本。');
    const seen = new Set([memory.id]); let cursor = memory;
    while (cursor?.provenance.kind === 'memory') { const target = cursor.provenance.sourceId; if (seen.has(target)) fail('记忆来源不能循环引用。'); seen.add(target); cursor = (state.memories || []).find(item => item.id === target); }
  }
  for (const profile of profiles.values()) {
    for (const id of profile.memoryDocumentIds) if (documents.get(id)?.workspaceId !== profile.workspaceId) fail('助手只能选择同范围的记忆文档。');
    for (const snapshot of profile.knowledgeSnapshots) {
      const source = knowledgeSource(state, snapshot.kind, snapshot.sourceId);
      if (!source || source.workspaceId !== profile.workspaceId) fail('知识快照来源必须存在并属于同一范围。');
      const actual = source.revision ?? source.sourceRevision;
      if (snapshot.sourceRevision !== undefined && actual !== undefined && snapshot.sourceRevision > actual) fail('知识快照不能引用未来的来源版本。');
    }
    for (const ref of profile.skillRefs) { const skill = (state.skills || []).find(item => item.id === ref.skillId); if (!skill || skill.workspaceId !== profile.workspaceId || !profile.needsReview && !validSkillRef(state, profile, ref)) fail('助手技能引用或授权无效，请重新确认。'); }
  }
  for (const chat of state.chats) if (chat.profileId && profiles.get(chat.profileId)?.workspaceId !== chat.workspaceId) fail('对话助手必须存在并属于同一范围。');
}
function touchProfile(profile) { profile.revision = knowledge.bump(profile.revision); profile.updatedAt = stamp(); profile.needsReview = true; }
function removeKnowledgeSources(state, initial) {
  const removed = new Set(initial.map(item => `${item.kind}:${item.id}`)), scopes = new Set();
  let changed = true;
  while (changed) { changed = false; state.memories = state.memories.filter(item => { if (!removed.has(`memory:${item.id}`) && !removed.has(`${item.provenance.kind}:${item.provenance.sourceId}`)) return true; removed.add(`memory:${item.id}`); scopes.add(item.workspaceId); changed = true; return false; }); }
  for (const profile of state.agentProfiles) {
    const snapshots = profile.knowledgeSnapshots.filter(item => !removed.has(`${item.kind}:${item.sourceId}`)), documents = profile.memoryDocumentIds.filter(id => !removed.has(`memory_document:${id}`));
    if (snapshots.length !== profile.knowledgeSnapshots.length || documents.length !== profile.memoryDocumentIds.length) { profile.knowledgeSnapshots = snapshots; profile.memoryDocumentIds = documents; touchProfile(profile); }
  }
  state.memoryIndexes = state.memoryIndexes.filter(index => !scopes.has(index.workspaceId));
}
function validateRelations(state) {
  validateKnowledgeRelations(state);
  unique(state.workspaces.map(item => item.id), '工作区'); unique(state.chats.map(item => item.id), '对话'); unique(state.files.map(item => item.id), '文件');
  unique((state.artifacts || []).map(item => item.id), 'Space');
  unique((state.schedules || []).map(item => item.id), '计划'); unique((state.scheduleRuns || []).map(item => item.id), '计划执行记录');
  const workspaces = new Set(state.workspaces.map(item => item.id)), files = new Set(state.files.map(item => item.id));
  for (const item of [...state.chats, ...state.files, ...(state.artifacts || [])]) if (item.workspaceId !== null && !workspaces.has(item.workspaceId)) fail('数据引用了不存在的工作区。');
  const schedules = new Map((state.schedules || []).map(item => [item.id, item])), runs = new Map((state.scheduleRuns || []).map(item => [item.id, item])), chats = new Map(state.chats.map(item => [item.id, item]));
  for (const schedule of schedules.values()) {
    if (schedule.workspaceId !== null && !workspaces.has(schedule.workspaceId) || schedule.attachmentIds.some(id => !files.has(id))) fail('计划引用了不存在的授权范围。');
    if (schedule.lastRunId && runs.get(schedule.lastRunId)?.scheduleId !== schedule.id) fail('计划最近执行记录引用无效。');
  }
  const liveSchedules = new Set(), ownedMessages = new Set(), runCounts = new Map();
  for (const run of runs.values()) {
    if (run.scheduleId !== null) {
      const schedule = schedules.get(run.scheduleId); if (!schedule || run.scheduleRevision > schedule.revision) fail('执行记录引用了不存在的计划或未来版本。');
      runCounts.set(run.scheduleId, (runCounts.get(run.scheduleId) || 0) + 1); if (runCounts.get(run.scheduleId) > scheduleModel.MAX_RUNS_PER_SCHEDULE) fail('单个计划执行历史超出限制。');
      if (run.status === 'running') { if (liveSchedules.has(run.scheduleId)) fail('同一计划不能拥有重复的活动执行记录。'); liveSchedules.add(run.scheduleId); }
    }
    if (run.scopeSnapshot.workspaceId !== null && !workspaces.has(run.scopeSnapshot.workspaceId) || run.scopeSnapshot.attachmentIds.some(id => !files.has(id))) fail('执行记录引用了不存在的资料范围。');
    if (run.chatId !== null) {
      const chat = chats.get(run.chatId), message = chat?.messages.find(item => item.id === run.messageId), key = `${run.chatId}:${run.messageId}`;
      if (!message || message.role !== 'assistant' || ownedMessages.has(key)) fail('计划执行记录的对话或消息引用无效。'); ownedMessages.add(key);
    }
  }
  for (const chat of state.chats) {
    unique(chat.messages.map(item => item.id), '消息');
    const preceding = new Map();
    for (const message of chat.messages) {
      for (const id of message.attachmentIds || []) if (!files.has(id)) fail('消息引用了不存在的附件。');
      if (message.replyTo) {
        const target = preceding.get(message.replyTo.messageId);
        if (!target || target.role !== message.replyTo.role) fail('消息引用必须指向同一对话中更早的消息，并匹配目标角色。');
        if (target.isDeleted && message.replyTo.excerpt !== '') fail('已删除引用目标不能保留摘录。');
      }
      preceding.set(message.id, message);
    }
  }
}
function stateShape(value) {
  record(value, '本地数据');
  if (value.schemaVersion !== STATE_VERSION || !Array.isArray(value.workspaces) || value.workspaces.length > 1000 || !Array.isArray(value.chats) || value.chats.length > 5000 || !Array.isArray(value.files) || value.files.length > 10000) fail('本地数据版本或结构不受支持。');
  const encrypted = value.encryptedApiKey, encryptedSpeech = value.encryptedSpeechApiKey;
  for (const key of [encrypted, encryptedSpeech]) if (key != null && (typeof key !== 'string' || key.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(key))) fail('本地密钥记录损坏。');
  const artifacts = value.artifacts === undefined ? [] : artifactArray(value.artifacts, MAX_ARTIFACTS, 'Space 列表').map(validateArtifact);
  const schedules = value.schedules === undefined ? [] : scheduleModel.array(value.schedules, scheduleModel.MAX_SCHEDULES, '计划列表').map(scheduleModel.scheduleShape), scheduleRuns = value.scheduleRuns === undefined ? [] : scheduleModel.array(value.scheduleRuns, scheduleModel.MAX_SCHEDULE_RUNS, '执行记录').map(scheduleModel.runShape);
  const state = { schemaVersion: STATE_VERSION, settings: validateSettings(value.settings), encryptedApiKey: encrypted || null, encryptedSpeechApiKey: encryptedSpeech || null, workspaces: value.workspaces.map(workspaceShape), chats: value.chats.map(chatShape), files: value.files.map(item => fileShape(item, true)), artifacts, schedules, scheduleRuns, ...knowledgeFields(value) };
  validateRelations(state);
  return state;
}

class Store {
  constructor(dataDir, { encrypt, decrypt } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) fail('数据目录必须是绝对路径。');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.dataDir = fs.realpathSync(dataDir); this.attachmentsDir = path.join(this.dataDir, 'attachments');
    fs.mkdirSync(this.attachmentsDir, { recursive: true, mode: 0o700 });
    this._assertAttachmentDirectory();
    this.statePath = path.join(this.dataDir, 'state.json'); this.backupPath = path.join(this.dataDir, 'state.backup.json');
    this.encrypt = encrypt; this.decrypt = decrypt; this.recoveryNotice = null;
    if (!fs.existsSync(this.statePath)) {
      if (fs.existsSync(this.backupPath)) {
        try { this.state = this._load(this.backupPath); }
        catch { fail('本地数据缺失且自动备份无法读取。文件已保留，请从手动备份恢复。'); }
        this.recoveryNotice = '本地数据文件缺失，已恢复上一次自动备份。';
      } else this.state = { schemaVersion: 1, settings: { ...DEFAULTS }, encryptedApiKey: null, workspaces: [], chats: [], files: [], artifacts: [], schedules: [], scheduleRuns: [], ...knowledgeFields({}) };
    }
    else {
      try { this.state = this._load(this.statePath); }
      catch {
        try { this.state = this._load(this.backupPath); }
        catch { fail('本地数据和自动备份均无法读取。文件已保留，请从手动备份恢复。'); }
        fs.renameSync(this.statePath, `${this.statePath}.corrupt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
        this.recoveryNotice = '本地数据文件损坏，已恢复上一次自动备份。损坏文件已保留。';
      }
    }
    this._recoverFileEdits();
    let interrupted = false, scheduledInterrupted = false;
    if (this.recoveryNotice) { for (const schedule of this.state.schedules) if (schedule.enabled) { schedule.enabled = false; if (schedule.revision < Number.MAX_SAFE_INTEGER) schedule.revision++; } this.state.settings.backgroundTasks = false; }
    for (const run of this.state.scheduleRuns) if (run.status === 'running') {
      run.status = 'interrupted'; run.finishedAt = stamp(); run.error = '上次计划执行被中断，不会自动重发。'; interrupted = true; scheduledInterrupted = true;
      const message = this.state.chats.find(chat => chat.id === run.chatId)?.messages.find(message => message.id === run.messageId);
      if (message) { message.status = 'cancelled'; message.error = run.error; if (message.toolTrace) message.toolTrace = cancelToolTrace(message.toolTrace); }
    }
    for (const chat of this.state.chats) for (const message of chat.messages) if (message.status === 'streaming' || message.toolTrace && hasUnfinishedToolCalls(message.toolTrace)) { message.status = 'cancelled'; if (message.toolTrace) message.toolTrace = cancelToolTrace(message.toolTrace); interrupted = true; }
    if (interrupted) this.recoveryNotice = scheduledInterrupted ? '上次计划执行已标记为中断，不会自动重发；未完成的聊天生成已停止。' : '上次关闭时仍在生成的消息已标记为已停止，可以重试。';
    this._persistState(this.state, { replaceBackup: Boolean(interrupted || this.recoveryNotice) });
  }
  _load(filename) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) fail('本地数据文件无效。');
    return stateShape(JSON.parse(fs.readFileSync(filename, 'utf8')));
  }
  _assertAttachmentDirectory() {
    try {
      const stat = fs.lstatSync(this.attachmentsDir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(this.attachmentsDir) !== path.join(this.dataDir, 'attachments')) fail('附件目录包含不安全的链接。');
    } catch (error) { filesystemFailure(error, '无法访问本地附件目录，请检查目录和读取权限。'); }
  }
  _managedPath(name, mustExist = false) {
    this._assertAttachmentDirectory();
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(name) || path.basename(name) !== name) fail('附件路径无效。');
    const filename = path.join(this.attachmentsDir, name);
    if (fs.existsSync(filename)) {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('附件包含不安全的链接。');
    } else if (mustExist) fail('附件副本不存在，可能已被移动或删除。');
    return filename;
  }
  _writeSynced(filename, bytes) {
    let handle;
    try { handle = fs.openSync(filename, 'wx', 0o600); fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); }
    finally { if (handle != null) fs.closeSync(handle); }
  }
  _replaceManagedBytes(name, bytes) {
    const target = this._managedPath(name), temporary = path.join(this.attachmentsDir, `.edit-${crypto.randomUUID()}.tmp`);
    try { this._writeSynced(temporary, bytes); this._managedPath(name); fs.renameSync(temporary, target); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  _assertEditDirectory(directory) {
    if (path.dirname(directory) !== this.dataDir || !FILE_EDIT_DIRECTORY.test(path.basename(directory))) fail('文件编辑恢复目录无效。');
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail('文件编辑恢复目录不安全。');
  }
  _writeEditManifest(directory, journal) {
    this._assertEditDirectory(directory);
    const temporary = path.join(directory, 'manifest.tmp'), target = path.join(directory, 'manifest.json');
    try { this._writeSynced(temporary, JSON.stringify(journal)); fs.renameSync(temporary, target); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  _readEditPart(directory, name, digest) {
    this._assertEditDirectory(directory);
    const filename = path.join(directory, name), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EDITABLE_FILE_BYTES) fail('文件编辑恢复数据无效。');
    const bytes = fs.readFileSync(filename);
    if (bytes.length > MAX_EDITABLE_FILE_BYTES || sha256(bytes) !== digest) fail('文件编辑恢复数据校验失败。');
    return bytes;
  }
  _cleanupFileEdit(directory) {
    this._assertEditDirectory(directory);
    for (const name of ['manifest.json', 'manifest.tmp', 'before-source', 'before-text', 'after-source', 'after-text']) {
      const filename = path.join(directory, name);
      try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    fs.rmdirSync(directory);
  }
  _restoreFileEdit(directory, journal, side) {
    const metadata = journal[side];
    const source = this._readEditPart(directory, `${side}-source`, journal[`${side}SourceSha256`]);
    const text = this._readEditPart(directory, `${side}-text`, journal[`${side}TextSha256`]);
    this._replaceManagedBytes(metadata._storedName, source);
    this._replaceManagedBytes(metadata._textName, text);
  }
  _recoverFileEdits() {
    for (const entry of fs.readdirSync(this.dataDir, { withFileTypes: true })) {
      if (!FILE_EDIT_DIRECTORY.test(entry.name)) continue;
      const directory = path.join(this.dataDir, entry.name);
      this._assertEditDirectory(directory);
      const manifest = path.join(directory, 'manifest.json');
      if (!fs.existsSync(manifest)) { this._cleanupFileEdit(directory); continue; }
      const stat = fs.lstatSync(manifest);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) fail('文件编辑恢复记录无效，已保留恢复数据。');
      const journal = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (journal.version !== 1 || !['prepared', 'committed'].includes(journal.phase)) fail('文件编辑恢复版本无效。');
      const before = fileShape(journal.before, true), after = fileShape(journal.after, true);
      if (before.id !== after.id || before._storedName !== after._storedName || before._textName !== after._textName || !after._contentRevision || before._contentRevision === after._contentRevision) fail('文件编辑恢复对象不匹配。');
      const current = this.state.files.find(file => file.id === after.id);
      // A later edit/delete makes an old committed journal obsolete. Never
      // resurrect deleted files or roll back a newer revision after cleanup fails.
      if (!current || current._storedName !== after._storedName || current._contentRevision !== before._contentRevision && current._contentRevision !== after._contentRevision) { this._cleanupFileEdit(directory); continue; }
      const side = current._contentRevision === after._contentRevision || journal.phase === 'committed' ? 'after' : 'before';
      this._restoreFileEdit(directory, journal, side);
      const selected = side === 'after' ? after : before;
      for (const key of ['size', 'mime', 'textStatus', 'textPreview', '_textTruncated', '_sha256', '_contentRevision']) {
        if (key in selected) current[key] = selected[key]; else delete current[key];
      }
      if (selected.error) current.error = selected.error; else delete current.error;
      this.state = stateShape(this.state);
      // Align the automatic metadata backup with the recovered file bytes too.
      this._persistState(this.state); this._persistState(this.state);
      this._cleanupFileEdit(directory);
      this.recoveryNotice = '已恢复上次中断的文件编辑，文件与预览保持一致。';
    }
  }
  _persistState(state, { replaceBackup = false } = {}) {
    const json = JSON.stringify(state);
    if (Buffer.byteLength(json) > MAX_STATE_BYTES) fail('本地数据超出容量限制。');
    const temporary = path.join(this.dataDir, `.state-${crypto.randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(descriptor, json, 'utf8'); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = null;
      if (fs.existsSync(this.statePath) || replaceBackup) {
        if (fs.existsSync(this.statePath)) { const stat = fs.lstatSync(this.statePath); if (!stat.isFile() || stat.isSymbolicLink()) fail('本地数据路径不安全。'); }
        const backupTmp = path.join(this.dataDir, `.backup-${crypto.randomUUID()}.tmp`);
        try {
          // Deletion must not leave the removed body or quote snapshot in the
          // automatic recovery backup. Both durable copies get the tombstone.
          if (replaceBackup) this._writeSynced(backupTmp, Buffer.from(json, 'utf8'));
          else fs.copyFileSync(this.statePath, backupTmp, fs.constants.COPYFILE_EXCL);
          fs.renameSync(backupTmp, this.backupPath);
        }
        finally { if (fs.existsSync(backupTmp)) fs.unlinkSync(backupTmp); }
      }
      fs.renameSync(temporary, this.statePath);
    } catch (error) { filesystemFailure(error, '无法保存本地数据，请检查磁盘空间和文件权限。'); }
    finally { if (descriptor != null) fs.closeSync(descriptor); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  _commit(change, persistenceOptions) { const next = copy(this.state), result = change(next), validated = stateShape(next); this._persistState(validated, persistenceOptions); this.state = validated; return copy(result); }
  _workspace(id, state = this.state) { const workspace = state.workspaces.find(item => item.id === id); if (!workspace) fail('工作区不存在。'); return workspace; }
  _workspaceId(id, state = this.state) { if (id == null) return null; identifier(id); this._workspace(id, state); return id; }
  _chat(id, state = this.state) { identifier(id); const chat = state.chats.find(item => item.id === id); if (!chat) fail('对话不存在。'); return chat; }
  _file(id, state = this.state) { identifier(id); const file = state.files.find(item => item.id === id); if (!file) fail('附件不存在。'); return file; }
  _artifact(id, state = this.state) { identifier(id); const artifact = state.artifacts.find(item => item.id === id); if (!artifact) fail('Space 不存在。'); return artifact; }
  _schedule(id, state = this.state) { identifier(id); const schedule = state.schedules.find(item => item.id === id); if (!schedule) fail('计划不存在。'); return schedule; }
  _scheduleRun(id, state = this.state) { identifier(id); const run = state.scheduleRuns.find(item => item.id === id); if (!run) fail('计划执行记录不存在。'); return run; }
  snapshot() { return { settings: this.settings(), workspaces: copy(this.state.workspaces), chats: copy(this.state.chats), files: this.state.files.map(publicFile), artifacts: this.state.artifacts.map(publicArtifact), schedules: copy(this.state.schedules), scheduleRuns: copy(this.state.scheduleRuns), memoryDocuments: copy(this.state.memoryDocuments.map(knowledge.publicMemory)), memories: copy(this.state.memories.map(knowledge.publicMemory)), skills: copy(this.state.skills.map(knowledge.publicSkill)), agentProfiles: copy(this.state.agentProfiles.map(knowledge.publicProfile)), memoryIndexes: this.state.memoryIndexes.map(index => ({ schemaVersion: 1, workspaceId: index.workspaceId, revision: index.revision, status: index.sourceDigest !== require('./knowledge-search.cjs').memorySourceDigest(this.state.memories, index.workspaceId) ? 'stale' : index.status, sourceDigest: index.sourceDigest, indexDigest: index.indexDigest, builtAt: index.builtAt, documentCount: index.documents.length, ...(index.errorCode ? { errorCode: index.errorCode } : {}) })), app: { version: '0.1.0', platform: process.platform } }; }
  settings() { return { ...copy(this.state.settings), hasApiKey: Boolean(this.state.encryptedApiKey), hasSpeechApiKey: Boolean(this.state.encryptedSpeechApiKey) }; }
  speechSecret() {
    if (!this.state.encryptedSpeechApiKey) return '';
    if (typeof this.decrypt !== 'function') fail('系统语音密钥解密服务不可用，请重新输入。');
    try { const value = this.decrypt(Buffer.from(this.state.encryptedSpeechApiKey, 'base64')); if (typeof value !== 'string') fail('invalid'); return value; }
    catch { fail('无法解密本机语音密钥，请在设置中重新输入。'); }
  }
  secret() {
    if (!this.state.encryptedApiKey) return '';
    if (typeof this.decrypt !== 'function') fail('系统密钥解密服务不可用，请重新输入 API 密钥。');
    try { const value = this.decrypt(Buffer.from(this.state.encryptedApiKey, 'base64')); if (typeof value !== 'string') fail('invalid'); return value; }
    catch { fail('无法解密本机 API 密钥，请在设置中重新输入。'); }
  }
  saveSettings(input) {
    record(input, '设置'); onlyKeys(input, [...SETTINGS_KEYS, 'apiKey', 'clearApiKey', 'speechApiKey', 'clearSpeechApiKey'], '设置');
    const settings = validateSettings(input, this.state.settings, true);
    let encrypted = this.state.encryptedApiKey;
    if (input.clearApiKey != null && typeof input.clearApiKey !== 'boolean') fail('清除密钥选项无效。');
    if (input.apiKey != null && typeof input.apiKey !== 'string') fail('API 密钥格式无效。');
    const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (key.length > 16384 || /[\r\n\0]/.test(key)) fail('API 密钥格式无效。');
    if (key && input.clearApiKey) fail('不能同时保存和清除 API 密钥。');
    if (input.clearApiKey) encrypted = null;
    else if (key) {
      if (typeof this.encrypt !== 'function') fail('系统加密服务不可用，API 密钥未保存。');
      try { const bytes = this.encrypt(key); if (!(bytes instanceof Uint8Array) || !bytes.length) fail('invalid'); encrypted = Buffer.from(bytes).toString('base64'); }
      catch { fail('系统无法加密 API 密钥，设置未保存。'); }
    }
    let encryptedSpeech = this.state.encryptedSpeechApiKey || null;
    if (input.clearSpeechApiKey != null && typeof input.clearSpeechApiKey !== 'boolean') fail('清除语音密钥选项无效。');
    if (input.speechApiKey != null && typeof input.speechApiKey !== 'string') fail('语音密钥格式无效。');
    const speechKey = typeof input.speechApiKey === 'string' ? input.speechApiKey.trim() : '';
    if (speechKey.length > 8192 || speechKey && /[^\x21-\x7e]/.test(speechKey)) fail('语音密钥格式无效。');
    if (speechKey && input.clearSpeechApiKey) fail('不能同时保存和清除语音密钥。');
    if (input.clearSpeechApiKey) encryptedSpeech = null;
    else if (speechKey) {
      if (typeof this.encrypt !== 'function') fail('系统加密服务不可用，语音密钥未保存。');
      try { const bytes = this.encrypt(speechKey); if (!(bytes instanceof Uint8Array) || !bytes.length) fail('invalid'); encryptedSpeech = Buffer.from(bytes).toString('base64'); }
      catch { fail('系统无法加密语音密钥，设置未保存。'); }
    }
    this._commit(next => { next.settings = settings; next.encryptedApiKey = encrypted; next.encryptedSpeechApiKey = encryptedSpeech; return null; }); return this.settings();
  }
  createWorkspace(input) {
    record(input, '工作区'); onlyKeys(input, ['name', 'description', 'color'], '工作区');
    const now = stamp(), workspace = workspaceShape({ id: uid('ws'), name: input.name?.trim(), description: input.description || '', color: input.color || '#8b5cf6', createdAt: now, updatedAt: now });
    return this._commit(next => { next.workspaces.push(workspace); return workspace; });
  }
  updateWorkspace(input) {
    record(input, '工作区'); onlyKeys(input, ['id', 'name', 'description', 'color'], '工作区'); this._workspace(input.id);
    return this._commit(next => { const item = this._workspace(input.id, next), value = workspaceShape({ ...item, ...input, updatedAt: stamp() }); Object.assign(item, value); return item; });
  }
  deleteWorkspace(id) {
    this._workspace(id); this._commit(next => {
      const sources = [...next.memoryDocuments.filter(item => item.workspaceId === id).map(item => ({ kind: 'memory_document', id: item.id })), ...next.memories.filter(item => item.workspaceId === id).map(item => ({ kind: 'memory', id: item.id }))];
      const profileIds = new Set(next.agentProfiles.filter(item => item.workspaceId === id).map(item => item.id));
      for (const key of ['memoryDocuments','memories','skills','agentProfiles','memoryIndexes']) next[key] = next[key].filter(item => item.workspaceId !== id);
      for (const chat of next.chats) if (profileIds.has(chat.profileId)) delete chat.profileId;
      removeKnowledgeSources(next, sources);
      next.workspaces = next.workspaces.filter(item => item.id !== id); for (const item of [...next.chats, ...next.files, ...next.artifacts]) if (item.workspaceId === id) { item.workspaceId = null; if ('updatedAt' in item) item.updatedAt = stamp(); }
      for (const schedule of next.schedules) if (schedule.workspaceId === id) { schedule.workspaceId = null; schedule.enabled = false; if (schedule.revision < Number.MAX_SAFE_INTEGER) schedule.revision++; schedule.updatedAt = stamp(); }
      for (const run of next.scheduleRuns) if (run.scopeSnapshot.workspaceId === id) run.scopeSnapshot.workspaceId = null;
      return null;
    }, { replaceBackup: true }); return this.snapshot();
  }
  createChat(input = {}) {
    record(input, '对话'); onlyKeys(input, ['workspaceId', 'title', 'profileId'], '对话');
    const now = stamp(), chat = chatShape({ id: uid('chat'), title: input.title || '新对话', workspaceId: this._workspaceId(input.workspaceId), ...(input.profileId == null ? {} : { profileId: input.profileId }), createdAt: now, updatedAt: now, pinned: false, messages: [] });
    return this._commit(next => { if (chat.profileId) this._bindProfile(chat.profileId, chat.workspaceId, next); next.chats.push(chat); return chat; });
  }
  updateChat(input) {
    record(input, '对话'); onlyKeys(input, ['id', 'title', 'pinned', 'workspaceId', 'profileId'], '对话'); this._chat(input.id);
    if ('workspaceId' in input) this._workspaceId(input.workspaceId);
    return this._commit(next => { const item = this._chat(input.id, next), moved = 'workspaceId' in input && input.workspaceId !== item.workspaceId, value = chatShape({ ...item, ...input, updatedAt: stamp(), ...(moved ? { profileId: null } : {}) }); if (value.profileId && Object.hasOwn(input, 'profileId')) this._bindProfile(value.profileId, value.workspaceId, next); if (!value.profileId) delete item.profileId; Object.assign(item, value); if (moved) removeKnowledgeSources(next, [{ kind: 'chat', id: item.id }]); return item; }, { replaceBackup: true });
  }
  deleteChat(id) { this._chat(id); this._commit(next => { next.chats = next.chats.filter(item => item.id !== id); removeKnowledgeSources(next, [{ kind: 'chat', id }]); for (const run of next.scheduleRuns) if (run.chatId === id) { run.chatId = null; run.messageId = null; } return null; }, { replaceBackup: true }); return this.snapshot(); }
  getChat(id) { return copy(this._chat(id)); }
  appendMessage(chatId, input) {
    record(input, '消息'); onlyKeys(input, ['id', 'role', 'content', 'createdAt', 'status', 'attachmentIds', 'error', 'agentMode', 'toolTrace', 'replyToMessageId', 'artifactContext', 'activePanel'], '消息');
    const { replyToMessageId, ...fields } = input;
    const message = messageShape({ id: input.id || uid('msg'), createdAt: stamp(), status: 'complete', ...fields });
    for (const id of message.attachmentIds || []) this._file(id);
    return this._commit(next => {
      const chat = this._chat(chatId, next); if (chat.messages.some(item => item.id === message.id)) fail('消息标识符已存在。');
      if (replyToMessageId != null) {
        identifier(replyToMessageId, '引用消息标识符');
        const target = chat.messages.find(item => item.id === replyToMessageId);
        if (message.role !== 'user' || !target || target.isDeleted || target.status === 'streaming' || target.id === message.id) fail('回复引用必须指向同一对话中既有、未删除且已停止生成的消息。');
        message.replyTo = { messageId: target.id, role: target.role, excerpt: replyExcerpt(target.content) };
      }
      chat.messages.push(message); chat.updatedAt = stamp(); return message;
    });
  }
  // Main-process admission cleanup only. The caller must establish that HTTP
  // dispatch has NOT begun; Store cannot prove network delivery or undo it.
  // This method is intentionally absent from the renderer/preload API.
  rollbackUnsentMessages(input) {
    record(input, '未发送消息回滚'); onlyKeys(input, ['chatId', 'messageIds'], '未发送消息回滚');
    identifier(input.chatId, '对话标识符');
    if (!Array.isArray(input.messageIds) || input.messageIds.length < 1 || input.messageIds.length > 2) fail('只能回滚本次准入新增的末尾一至两条消息。');
    const ids = input.messageIds.map(id => identifier(id, '消息标识符'));
    unique(ids, '回滚消息');
    return this._commit(next => {
      const chat = this._chat(input.chatId, next), suffix = chat.messages.slice(-ids.length);
      if (suffix.length !== ids.length || suffix.some((message, index) => message.id !== ids[index])) fail('消息顺序或对话末尾已变化，不能回滚未发送消息。');
      if (suffix.some(message => message.toolTrace?.length)) fail('消息已有工具执行记录，不能作为未发送消息回滚。');
      const selected = new Set(ids);
      // Store relations are chat-local. Another chat may legitimately reuse an
      // ID, so its unrelated reference must not be treated as this target.
      if (chat.messages.some(message => message.replyTo && selected.has(message.replyTo.messageId))) fail('消息已被其它消息引用，不能回滚。');
      chat.messages.splice(chat.messages.length - ids.length, ids.length);
      chat.updatedAt = stamp(); return chat;
    }, { replaceBackup: true });
  }
  deleteTurn(input) {
    record(input, '消息删除'); onlyKeys(input, ['chatId', 'messageId'], '消息删除'); identifier(input.messageId, '消息标识符');
    return this._commit(next => {
      const chat = this._chat(input.chatId, next), index = chat.messages.findIndex(item => item.id === input.messageId), selected = chat.messages[index];
      if (!selected || selected.role !== 'user') fail('只能删除本对话中既有的用户消息。');
      chat.messages[index] = { id: selected.id, role: 'user', content: '', createdAt: selected.createdAt, status: 'complete', isDeleted: true };
      for (const message of chat.messages) if (message.replyTo?.messageId === selected.id) message.replyTo.excerpt = '';
      chat.updatedAt = stamp();
      removeKnowledgeSources(next, [{ kind: 'chat', id: chat.id }]);
      return { chat, deletedMessageIds: [selected.id] };
    }, { replaceBackup: true });
  }
  updateMessage(chatId, messageId, patch) {
    record(patch, '消息'); onlyKeys(patch, ['content', 'status', 'attachmentIds', 'error', 'agentMode', 'toolTrace'], '消息');
    return this._commit(next => { const chat = this._chat(chatId, next), index = chat.messages.findIndex(item => item.id === messageId); if (index < 0) fail('消息不存在。'); const value = messageShape({ ...chat.messages[index], ...patch }); for (const id of value.attachmentIds || []) this._file(id, next); chat.messages[index] = value; chat.updatedAt = stamp(); return value; });
  }
  async _prepareFile(buffer, name, workspaceId) {
    const id = uid('file'), ext = describeFile(name).managedExtension, extracted = await extractDocument(buffer, name);
    const item = { id, name, mime: extracted.mime, size: buffer.length, workspaceId, createdAt: stamp(), textStatus: extracted.textStatus, textPreview: extracted.text.slice(0, 1000), ...(extracted.error ? { error: extracted.error } : {}), _storedName: `${id}.${ext}`, _textName: `${id}.text`, _textTruncated: extracted.truncated, _sha256: sha256(buffer), _contentRevision: uid('revision') };
    const written = [];
    try { for (const [name, data] of [[item._storedName, buffer], [item._textName, extracted.text]]) { const filename = this._managedPath(name); fs.writeFileSync(filename, data, { flag: 'wx', mode: 0o600 }); written.push(filename); } }
    catch (error) { for (const filename of written) fs.unlinkSync(filename); throw error; }
    return item;
  }
  _discardFile(item) { for (const name of [item._storedName, item._textName]) { const filename = this._managedPath(name); try { fs.unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; } } }
  async addFile({ sourcePath, workspaceId = null }) {
    this._workspaceId(workspaceId);
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) fail('请选择有效的本地文件。');
    const name = safeName(path.basename(sourcePath));
    let handle, buffer;
    try {
      if (fs.lstatSync(sourcePath).isSymbolicLink()) fail('暂不支持通过文件链接导入，请选择原始文件。');
      handle = await fs.promises.open(sourcePath, 'r'); const stat = await handle.stat();
      if (!stat.isFile()) fail('只能导入普通文件。'); if (stat.size > MAX_FILE_BYTES) fail('单个文件不能超过 25 MB。');
      buffer = await handle.readFile(); if (buffer.length > MAX_FILE_BYTES) fail('单个文件不能超过 25 MB。');
    } catch (error) { filesystemFailure(error, error.code === 'ENOENT' ? '所选文件不存在，可能已被移动或删除。' : '无法读取所选文件，请检查文件是否被占用或缺少权限。'); }
    finally { await handle?.close(); }
    const item = await this._prepareFile(buffer, name, workspaceId);
    try { return this._commit(next => { this._workspaceId(workspaceId, next); next.files.push(item); return publicFile(item); }); }
    catch (error) { this._discardFile(item); throw error; }
  }
  async createTextFile(input) {
    record(input, '新文件'); onlyKeys(input, ['workspaceId', 'name', 'content'], '新文件');
    const name = safeTextName(input.name), workspaceId = this._workspaceId(input.workspaceId);
    const bytes = textFileBytes(input.content ?? '');
    const item = await this._prepareFile(bytes, name, workspaceId);
    try {
      this._commit(next => { this._workspaceId(workspaceId, next); next.files.push(item); return null; });
      return { file: this.getFile(item.id), preview: this.readFile(item.id) };
    } catch (error) { this._discardFile(item); throw error; }
  }
  saveTextFile(input) {
    record(input, '保存文件'); onlyKeys(input, ['id', 'content', 'expectedSha256'], '保存文件');
    const item = this._file(input.id);
    if (typeof input.expectedSha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(input.expectedSha256)) fail('保存文件需要有效的原内容校验值，请重新载入文件。');
    const preview = this.readFile(item.id);
    if (preview.sha256 !== input.expectedSha256.toLowerCase()) fail('文件已被其他编辑器修改，请重新载入后再保存。');
    if (!preview.editable) fail('此文件只能预览；只允许编辑未截取、1 MB 以内的 UTF-8 普通文本。');
    const bytes = textFileBytes(input.content), text = decodeEditableText(bytes);
    const beforeSource = fs.readFileSync(this._managedPath(item._storedName, true));
    if (sha256(beforeSource) !== preview.sha256) fail('文件已发生变化，请重新载入后再保存。');
    if (beforeSource.equals(bytes)) return { file: this.getFile(item.id), preview };
    const beforeText = fs.readFileSync(this._managedPath(item._textName, true));
    const after = { ...copy(item), size: bytes.length, textStatus: 'ready', textPreview: text.slice(0, 1000), _textTruncated: false, _sha256: sha256(bytes), _contentRevision: uid('revision') };
    delete after.error;
    const directory = path.join(this.dataDir, `.file-edit-${crypto.randomUUID()}`);
    const journal = { version: 1, phase: 'prepared', before: copy(item), after,
      beforeSourceSha256: sha256(beforeSource), beforeTextSha256: sha256(beforeText), afterSourceSha256: after._sha256, afterTextSha256: sha256(Buffer.from(text, 'utf8')) };
    fs.mkdirSync(directory, { mode: 0o700 });
    let prepared = false, committed = false;
    try {
      for (const [name, content] of [['before-source', beforeSource], ['before-text', beforeText], ['after-source', bytes], ['after-text', Buffer.from(text, 'utf8')]]) this._writeSynced(path.join(directory, name), content);
      this._writeEditManifest(directory, journal); prepared = true;
      this._restoreFileEdit(directory, journal, 'after');
      this._commit(next => { Object.assign(this._file(item.id, next), after); delete this._file(item.id, next).error; return null; });
      committed = true;
    } catch (error) {
      // An OS error can arrive after the durable state rename. Read its revision
      // before deciding to undo file bytes; otherwise disk and memory may diverge.
      try { const disk = this._load(this.statePath); if (disk.files.find(file => file.id === item.id)?._contentRevision === after._contentRevision) { this.state = disk; committed = true; } } catch {}
      if (!committed) {
        try { if (prepared) this._restoreFileEdit(directory, journal, 'before'); this._cleanupFileEdit(directory); }
        catch { fail('文件保存被中断，恢复数据已保留；请重新打开应用后再编辑。'); }
        filesystemFailure(error, '无法保存文件，原内容已恢复。请检查磁盘空间和文件权限。');
      }
    }
    // Commit the decision before synchronizing the automatic state backup. A
    // retained journal lets startup finish a committed edit even from that backup.
    try { journal.phase = 'committed'; this._writeEditManifest(directory, journal); this._persistState(this.state); this._cleanupFileEdit(directory); }
    catch { /* The committed bytes/state are valid; startup can finish cleanup. */ }
    return { file: this.getFile(item.id), preview: this.readFile(item.id) };
  }
  removeFile(id) {
    const item = this._file(id); this._managedPath(item._storedName); this._managedPath(item._textName);
    this._commit(next => {
      removeKnowledgeSources(next, [{ kind: 'file', id }]);
      next.files = next.files.filter(file => file.id !== id); for (const chat of next.chats) for (const message of chat.messages) if (message.attachmentIds) message.attachmentIds = message.attachmentIds.filter(fileId => fileId !== id);
      for (const schedule of next.schedules) if (schedule.attachmentIds.includes(id)) { schedule.attachmentIds = schedule.attachmentIds.filter(fileId => fileId !== id); schedule.enabled = false; if (schedule.revision < Number.MAX_SAFE_INTEGER) schedule.revision++; schedule.updatedAt = stamp(); }
      for (const run of next.scheduleRuns) run.scopeSnapshot.attachmentIds = run.scopeSnapshot.attachmentIds.filter(fileId => fileId !== id);
      return null;
    }, { replaceBackup: true });
    this._discardFile(item); return this.snapshot();
  }
  getFile(id) { return copy(publicFile(this._file(id))); }
  filePath(id) { return this._managedPath(this._file(id)._storedName, true); }
  readFile(id) {
    const item = this._file(id);
    if (item.textStatus !== 'ready') fail(item.error || '此文件格式不支持文字预览。');
    const filename = this._managedPath(item._textName, true), stat = fs.statSync(filename);
    if (stat.size > 4 * MAX_TEXT_CHARS + 16) fail('文件预览缓存无效。');
    const text = fs.readFileSync(filename, 'utf8'), truncated = item._textTruncated || text.length > MAX_TEXT_CHARS;
    const source = this._managedPath(item._storedName, true), sourceStat = fs.statSync(source);
    if (sourceStat.size > MAX_FILE_BYTES) fail('文件副本超出大小限制。');
    const bytes = fs.readFileSync(source);
    if (bytes.length > MAX_FILE_BYTES) fail('文件副本超出大小限制。');
    const digest = sha256(bytes);
    let editable = false;
    if (!truncated && bytes.length <= MAX_EDITABLE_FILE_BYTES && TEXT_EXTENSIONS.has(describeFile(item.name).ext) && (!item._sha256 || item._sha256 === digest)) {
      try { editable = decodeEditableText(bytes) === text; } catch { /* Binary/non-UTF8 text remains preview-only. */ }
    }
    return { name: item.name, text: text.slice(0, MAX_TEXT_CHARS), truncated, sha256: digest, editable };
  }
  // Convenience for the main process: a new/global chat does not implicitly see
  // every unscoped file; cross-workspace files require an explicit attachment.
  contextDocuments(chatId, attachmentIds = []) {
    const chat = this._chat(chatId), explicit = new Set(attachmentIds.map(id => this._file(id).id));
    return this.state.files.filter(file => (chat.workspaceId !== null && file.workspaceId === chat.workspaceId) || explicit.has(file.id)).filter(file => file.textStatus === 'ready').map(file => ({ ...publicFile(file), ...this.readFile(file.id) }));
  }
  _knowledgeItem(collection, id, state = this.state) { knowledge.id(id); const item = state[collection].find(item => item.id === id); if (!item) fail('所选知识记录不存在。'); return item; }
  _bindProfile(id, workspaceId, state = this.state) { const profile = this._knowledgeItem('agentProfiles', id, state); if (profile.workspaceId !== workspaceId || profile.needsReview) fail('请先确认同一范围内的助手配置。'); for (const ref of profile.skillRefs) if (!validSkillRef(state, profile, ref)) fail('助手技能授权已变化，请重新确认。'); return profile; }
  _captureKnowledgeSource(kind, id, workspaceId, state = this.state) {
    if (!knowledge.SOURCE_KINDS.includes(kind)) fail('知识来源类型无效。'); knowledge.id(id);
    const source = knowledgeSource(state, kind, id); if (!source || source.workspaceId !== workspaceId) fail('只能选择同一范围内的现有知识来源。');
    let name, contentMarkdown, sourceDigest, sourceRevision, sourceTruncated = false;
    if (kind === 'memory' || kind === 'memory_document') { name = source.name || 'MEMORY.md'; contentMarkdown = source.contentMarkdown; sourceDigest = source.digest; sourceRevision = source.revision; }
    else if (kind === 'file') { const preview = this.readFile(id); name = source.name; contentMarkdown = preview.text; sourceDigest = preview.sha256; sourceTruncated = preview.truncated; }
    else if (kind === 'chat') {
      if (source.messages.some(item => item.status === 'streaming')) fail('请等待对话生成结束后再保存知识快照。');
      const messages = source.messages.filter(item => !item.isDeleted).map(({ id, role, content }) => ({ id, role, content }));
      name = source.title; sourceDigest = knowledge.hash(JSON.stringify(messages)); contentMarkdown = JSON.stringify(messages.slice(-32)); sourceTruncated = messages.length > 32; if ([...contentMarkdown].length > 100000) { contentMarkdown = [...contentMarkdown].slice(0, 100000).join(''); sourceTruncated = true; }
    } else { name = source.name; sourceRevision = source.sourceRevision; sourceDigest = require('./artifact-model.cjs').sourceDigest(source); contentMarkdown = JSON.stringify({ name: source.name, runtime: source.runtime, entryPath: source.entryPath, files: source.files.map(file => Object.hasOwn(file, 'text') ? file : { path: file.path, binary: true, size: artifactFileBytes(file).length, sha256: sha256(artifactFileBytes(file)) }) }); if ([...contentMarkdown].length > 100000) { contentMarkdown = [...contentMarkdown].slice(0, 100000).join(''); sourceTruncated = true; } }
    const captured = knowledge.truncateSnapshot(contentMarkdown); return { name, sourceDigest, ...(sourceRevision === undefined ? {} : { sourceRevision }), ...captured, truncated: sourceTruncated || captured.truncated };
  }
  _memoryProvenance(value, workspaceId, state = this.state) {
    if (value === undefined) return { kind: 'manual', capturedAt: stamp() };
    const result = knowledge.provenance(value); if (result.kind === 'manual') return result;
    const captured = this._captureKnowledgeSource(result.kind, result.sourceId, workspaceId, state);
    return { kind: result.kind, sourceId: result.sourceId, sourceDigest: captured.sourceDigest, ...(captured.sourceRevision === undefined ? {} : { sourceRevision: captured.sourceRevision }), capturedAt: result.capturedAt };
  }
  getMemoryDocument(input = {}) { knowledge.input(input, ['workspaceId']); const workspaceId = this._workspaceId(input.workspaceId); const item = this.state.memoryDocuments.find(item => item.workspaceId === workspaceId); return item ? copy(item) : null; }
  saveMemoryDocument(input) {
    knowledge.input(input, ['workspaceId','expectedRevision','contentMarkdown']); const workspaceId = this._workspaceId(input.workspaceId), expected = knowledge.revision(input.expectedRevision, true), contentMarkdown = knowledge.memoryText(input.contentMarkdown);
    return this._commit(next => { const old = next.memoryDocuments.find(item => item.workspaceId === workspaceId); if ((old?.revision || 0) !== expected) fail('记忆文档已变化，请重新载入后再保存。'); const now = stamp(), item = knowledge.memoryDocument({ id: old?.id || uid('memorydoc'), workspaceId, path: 'MEMORY.md', contentMarkdown, revision: old ? knowledge.bump(old.revision) : 1, digest: knowledge.hash(contentMarkdown), createdAt: old?.createdAt || now, updatedAt: now }); if (old) Object.assign(old, item); else next.memoryDocuments.push(item); return item; }, { replaceBackup: true });
  }
  deleteMemoryDocument(input) { knowledge.input(input, ['id','expectedRevision']); this._commit(next => { const item = this._knowledgeItem('memoryDocuments', input.id, next); knowledge.checkRevision(item, input.expectedRevision); next.memoryDocuments = next.memoryDocuments.filter(item => item.id !== input.id); removeKnowledgeSources(next, [{ kind: 'memory_document', id: input.id }]); return null; }, { replaceBackup: true }); return this.snapshot(); }
  createMemory(input) {
    knowledge.input(input, ['name','contentMarkdown','workspaceId','provenance']); const workspaceId = this._workspaceId(input.workspaceId), contentMarkdown = knowledge.memoryText(input.contentMarkdown), now = stamp();
    return this._commit(next => { if (next.memories.length >= knowledge.MAX_MEMORIES) fail('记忆条目数量超出限制。'); const item = knowledge.memory({ id: uid('memory'), name: input.name, contentMarkdown, workspaceId, revision: 1, digest: knowledge.hash(contentMarkdown), provenance: this._memoryProvenance(input.provenance, workspaceId, next), createdAt: now, updatedAt: now }); next.memories.push(item); return item; }, { replaceBackup: true });
  }
  getMemory(id) { return copy(this._knowledgeItem('memories', id)); }
  updateMemory(input) {
    knowledge.input(input, ['id','expectedRevision','name','contentMarkdown','provenance']);
    return this._commit(next => { const item = this._knowledgeItem('memories', input.id, next); knowledge.checkRevision(item, input.expectedRevision); const contentMarkdown = input.contentMarkdown === undefined ? item.contentMarkdown : knowledge.memoryText(input.contentMarkdown), value = knowledge.memory({ ...item, ...(input.name === undefined ? {} : { name: input.name }), contentMarkdown, digest: knowledge.hash(contentMarkdown), provenance: input.provenance === undefined ? item.provenance : this._memoryProvenance(input.provenance, item.workspaceId, next), revision: knowledge.bump(item.revision), updatedAt: stamp() }); Object.assign(item, value); return item; }, { replaceBackup: true });
  }
  deleteMemory(input) { knowledge.input(input, ['id','expectedRevision']); this._commit(next => { const item = this._knowledgeItem('memories', input.id, next); knowledge.checkRevision(item, input.expectedRevision); removeKnowledgeSources(next, [{ kind: 'memory', id: input.id }]); return null; }, { replaceBackup: true }); return this.snapshot(); }
  getMemoryIndex(input = {}) { knowledge.input(input, ['workspaceId']); const workspaceId = this._workspaceId(input.workspaceId), index = this.state.memoryIndexes.find(item => item.workspaceId === workspaceId); return index ? copy(index) : null; }
  commitMemoryIndex(input) {
    knowledge.input(input, ['workspaceId','expectedRevision','sourceDigest','index']); const workspaceId = this._workspaceId(input.workspaceId), expected = knowledge.revision(input.expectedRevision, true), sourceDigest = knowledge.digest(input.sourceDigest);
    return this._commit(next => { const old = next.memoryIndexes.find(item => item.workspaceId === workspaceId); if ((old?.revision || 0) !== expected) fail('记忆索引已变化，请重新建立索引。'); if (require('./knowledge-search.cjs').memorySourceDigest(next.memories, workspaceId) !== sourceDigest) fail('记忆来源已变化，请重新建立索引。'); const index = require('./knowledge-search.cjs').validateMemoryIndex(input.index); if (index.workspaceId !== workspaceId || index.sourceDigest !== sourceDigest || index.revision !== expected + 1) fail('索引范围、来源或版本不匹配。'); if (old) next.memoryIndexes[next.memoryIndexes.indexOf(old)] = index; else next.memoryIndexes.push(index); return index; }, { replaceBackup: true });
  }
  createSkill(input) {
    knowledge.input(input, ['name','description','version','manifestVersion','guidanceMarkdown','toolRequirements','workspaceId','digest','eligible','ineligibleReasons','enabled']); const workspaceId = this._workspaceId(input.workspaceId), now = stamp(); if (input.enabled !== undefined && input.enabled !== false) fail('请先明确批准技能指导授权。');
    const base = { name: input.name, description: input.description, version: input.version, manifestVersion: input.manifestVersion === undefined ? 1 : input.manifestVersion, guidanceMarkdown: input.guidanceMarkdown, toolRequirements: knowledge.requirements(input.toolRequirements === undefined ? [] : input.toolRequirements) }, digest = knowledge.skillDigest(base), eligible = knowledge.eligibility(base.toolRequirements);
    if (input.digest !== undefined && input.digest !== digest || input.eligible !== undefined && input.eligible !== eligible.eligible || input.ineligibleReasons !== undefined && JSON.stringify(input.ineligibleReasons) !== JSON.stringify(eligible.ineligibleReasons)) fail('技能解析元数据不匹配。');
    return this._commit(next => { if (next.skills.length >= knowledge.MAX_SKILLS) fail('技能指导数量超出限制。'); const item = knowledge.skill({ id: uid('skill'), ...base, workspaceId, revision: 1, digest, enabled: false, ...eligible, consents: [], createdAt: now, updatedAt: now }); next.skills.push(item); return item; }, { replaceBackup: true });
  }
  getSkill(id) { return copy(this._knowledgeItem('skills', id)); }
  updateSkill(input) {
    knowledge.input(input, ['id','expectedRevision','name','description','version','guidanceMarkdown','toolRequirements','enabled']);
    return this._commit(next => { const item = this._knowledgeItem('skills', input.id, next); knowledge.checkRevision(item, input.expectedRevision); const value = { ...item }; for (const key of ['name','description','version','guidanceMarkdown','toolRequirements','enabled']) if (Object.hasOwn(input, key)) value[key] = input[key]; value.toolRequirements = knowledge.requirements(value.toolRequirements); value.digest = knowledge.skillDigest(value); Object.assign(value, knowledge.eligibility(value.toolRequirements)); if (value.digest !== item.digest) { value.consents = []; value.enabled = false; } if (value.enabled && (!value.eligible || !value.consents.length)) fail('请先明确批准当前技能内容与工具需求。'); value.revision = knowledge.bump(item.revision); value.updatedAt = stamp(); Object.assign(item, knowledge.skill(value)); for (const profile of next.agentProfiles) if (profile.skillRefs.some(ref => ref.skillId === item.id)) touchProfile(profile); return item; }, { replaceBackup: true });
  }
  setSkillConsent(input) {
    knowledge.input(input, ['id','expectedRevision','workspaceId','approved','policyRevision']); if (typeof input.approved !== 'boolean' || input.policyRevision !== knowledge.POLICY_REVISION) fail('技能授权选项无效。');
    return this._commit(next => { const item = this._knowledgeItem('skills', input.id, next); knowledge.checkRevision(item, input.expectedRevision); const workspaceId = input.workspaceId === undefined ? item.workspaceId : this._workspaceId(input.workspaceId, next); if (workspaceId !== item.workspaceId) fail('技能授权必须属于相同范围。'); if (input.approved && !item.eligible) fail('技能包含不支持的工具需求，无法启用。'); item.consents = input.approved ? [{ id: uid('consent'), workspaceId, digest: item.digest, version: item.version, toolRequirements: copy(item.toolRequirements), policyRevision: knowledge.POLICY_REVISION, approvedAt: stamp() }] : []; item.enabled = input.approved; item.revision = knowledge.bump(item.revision); item.updatedAt = stamp(); for (const profile of next.agentProfiles) if (profile.skillRefs.some(ref => ref.skillId === item.id)) touchProfile(profile); return item; }, { replaceBackup: true });
  }
  deleteSkill(input) { knowledge.input(input, ['id','expectedRevision']); this._commit(next => { const item = this._knowledgeItem('skills', input.id, next); knowledge.checkRevision(item, input.expectedRevision); next.skills = next.skills.filter(item => item.id !== input.id); for (const profile of next.agentProfiles) if (profile.skillRefs.some(ref => ref.skillId === input.id)) { profile.skillRefs = profile.skillRefs.filter(ref => ref.skillId !== input.id); touchProfile(profile); } return null; }, { replaceBackup: true }); return this.snapshot(); }
  createAgentProfile(input) {
    knowledge.input(input, ['name','workspaceId','instructions','memoryDocumentIds','toolPolicy','skillRefs']); const workspaceId = this._workspaceId(input.workspaceId), now = stamp();
    return this._commit(next => { if (next.agentProfiles.length >= knowledge.MAX_PROFILES) fail('助手配置数量超出限制。'); const item = knowledge.profile({ id: uid('profile'), name: input.name, workspaceId, instructions: input.instructions === undefined ? '' : input.instructions, revision: 1, needsReview: true, knowledgeSnapshots: [], skillRefs: input.skillRefs === undefined ? [] : input.skillRefs, memoryDocumentIds: input.memoryDocumentIds === undefined ? [] : input.memoryDocumentIds, toolPolicy: input.toolPolicy === undefined ? 'read' : input.toolPolicy, createdAt: now, updatedAt: now }); next.agentProfiles.push(item); return item; }, { replaceBackup: true });
  }
  getAgentProfile(id) { return copy(this._knowledgeItem('agentProfiles', id)); }
  updateAgentProfile(input) {
    knowledge.input(input, ['id','expectedRevision','name','instructions','memoryDocumentIds','toolPolicy','skillRefs']);
    return this._commit(next => { const item = this._knowledgeItem('agentProfiles', input.id, next); knowledge.checkRevision(item, input.expectedRevision); const value = { ...item }; for (const key of ['name','instructions','memoryDocumentIds','toolPolicy','skillRefs']) if (Object.hasOwn(input, key)) value[key] = input[key]; touchProfile(value); Object.assign(item, knowledge.profile(value)); return item; }, { replaceBackup: true });
  }
  captureProfileKnowledge(input) {
    knowledge.input(input, ['id','expectedRevision','kind','sourceId']);
    return this._commit(next => { const item = this._knowledgeItem('agentProfiles', input.id, next); knowledge.checkRevision(item, input.expectedRevision); if (item.knowledgeSnapshots.some(snapshot => snapshot.kind === input.kind && snapshot.sourceId === input.sourceId)) fail('该来源已存在，请显式刷新已有快照。'); if (item.knowledgeSnapshots.length >= 50) fail('知识快照最多 50 项。'); const source = this._captureKnowledgeSource(input.kind, input.sourceId, item.workspaceId, next); item.knowledgeSnapshots.push(knowledge.knowledgeSnapshot({ id: uid('snapshot'), kind: input.kind, sourceId: input.sourceId, ...source, contentDigest: knowledge.hash(source.contentMarkdown), capturedAt: stamp() })); touchProfile(item); return item; }, { replaceBackup: true });
  }
  refreshProfileKnowledge(input) {
    knowledge.input(input, ['id','expectedRevision','snapshotId']);
    return this._commit(next => { const item = this._knowledgeItem('agentProfiles', input.id, next); knowledge.checkRevision(item, input.expectedRevision); const index = item.knowledgeSnapshots.findIndex(snapshot => snapshot.id === input.snapshotId); if (index < 0) fail('知识快照不存在。'); const old = item.knowledgeSnapshots[index], source = this._captureKnowledgeSource(old.kind, old.sourceId, item.workspaceId, next); item.knowledgeSnapshots[index] = knowledge.knowledgeSnapshot({ id: old.id, kind: old.kind, sourceId: old.sourceId, ...source, contentDigest: knowledge.hash(source.contentMarkdown), capturedAt: stamp() }); touchProfile(item); return item; }, { replaceBackup: true });
  }
  removeProfileKnowledge(input) { knowledge.input(input, ['id','expectedRevision','snapshotId']); return this._commit(next => { const item = this._knowledgeItem('agentProfiles', input.id, next); knowledge.checkRevision(item, input.expectedRevision); if (!item.knowledgeSnapshots.some(snapshot => snapshot.id === input.snapshotId)) fail('知识快照不存在。'); item.knowledgeSnapshots = item.knowledgeSnapshots.filter(snapshot => snapshot.id !== input.snapshotId); touchProfile(item); return item; }, { replaceBackup: true }); }
  reviewAgentProfile(input) { knowledge.input(input, ['id','expectedRevision']); return this._commit(next => { const item = this._knowledgeItem('agentProfiles', input.id, next); knowledge.checkRevision(item, input.expectedRevision); for (const ref of item.skillRefs) if (!validSkillRef(next, item, ref)) fail('请重新批准并选择当前有效的技能指导。'); item.needsReview = false; item.revision = knowledge.bump(item.revision); item.updatedAt = stamp(); return item; }, { replaceBackup: true }); }
  deleteAgentProfile(input) { knowledge.input(input, ['id','expectedRevision']); this._commit(next => { const item = this._knowledgeItem('agentProfiles', input.id, next); knowledge.checkRevision(item, input.expectedRevision); next.agentProfiles = next.agentProfiles.filter(item => item.id !== input.id); for (const chat of next.chats) if (chat.profileId === input.id) delete chat.profileId; return null; }, { replaceBackup: true }); return this.snapshot(); }
  getSchedule(id) { return copy(this._schedule(id)); }
  getScheduleRun(id) { return copy(this._scheduleRun(id)); }
  createSchedule(input, at = stamp()) {
    scheduleModel.input(input, ['name','prompt','workspaceId','attachmentIds','enabled','cadence','providerBinding','authorization','notification']); const now = scheduleModel.iso(at);
    let cadence = normalizeCadence(input.cadence); if (cadence.kind === 'interval' && !Object.hasOwn(input.cadence, 'anchorAt')) cadence = normalizeCadence({ ...cadence, anchorAt: now });
    const schedule = scheduleModel.scheduleShape({ id: uid('schedule'), name: typeof input.name === 'string' ? input.name.trim() : input.name, prompt: input.prompt, workspaceId: this._workspaceId(input.workspaceId), attachmentIds: scheduleModel.attachments(input.attachmentIds === undefined ? [] : input.attachmentIds), enabled: input.enabled === undefined ? true : input.enabled, cadence, revision: 1, createdAt: now, updatedAt: now, nextRunAt: scheduleModel.initialNextRun(cadence, now), providerBinding: input.providerBinding, authorization: input.authorization, notification: input.notification === undefined ? 'all' : input.notification });
    return this._commit(next => { if (next.schedules.length >= scheduleModel.MAX_SCHEDULES) fail('计划数量超过限制。'); this._workspaceId(schedule.workspaceId, next); for (const id of schedule.attachmentIds) this._file(id, next); next.schedules.push(schedule); return schedule; }, { replaceBackup: true });
  }
  updateSchedule(input, at = stamp()) {
    scheduleModel.input(input, ['id','expectedRevision','name','prompt','workspaceId','attachmentIds','enabled','cadence','providerBinding','authorization','notification']); const now = scheduleModel.iso(at), expectedRevision = scheduleModel.revision(input.expectedRevision);
    const { id, expectedRevision: ignored, ...patch } = input;
    return this._commit(next => {
      const schedule = this._schedule(id, next); if (schedule.revision !== expectedRevision) fail('计划已被其他操作修改，请重新载入并确认。'); if (schedule.revision === Number.MAX_SAFE_INTEGER) fail('计划版本超出限制。');
      const candidate = { ...schedule, ...patch, revision: schedule.revision + 1, updatedAt: now };
      if ('name' in patch && typeof patch.name === 'string') candidate.name = patch.name.trim();
      if ('cadence' in patch) { candidate.cadence = normalizeCadence(patch.cadence); if (candidate.cadence.kind === 'interval' && !Object.hasOwn(patch.cadence, 'anchorAt')) candidate.cadence = normalizeCadence({ ...candidate.cadence, anchorAt: now }); }
      if (JSON.stringify(candidate.cadence) !== JSON.stringify(schedule.cadence) || patch.enabled === true && !schedule.enabled) candidate.nextRunAt = scheduleModel.initialNextRun(candidate.cadence, now);
      const value = scheduleModel.scheduleShape(candidate); this._workspaceId(value.workspaceId, next); for (const attachment of value.attachmentIds) this._file(attachment, next);
      Object.assign(schedule, value); return schedule;
    }, { replaceBackup: true });
  }
  deleteSchedule(id) {
    this._schedule(id); this._commit(next => { next.schedules = next.schedules.filter(schedule => schedule.id !== id); for (const run of next.scheduleRuns) if (run.scheduleId === id) run.scheduleId = null; return null; }, { replaceBackup: true }); return this.snapshot();
  }
  claimScheduleRun(input) {
    scheduleModel.input(input, ['id','expectedRevision','trigger','now']); const now = scheduleModel.iso(input.now), expectedRevision = scheduleModel.revision(input.expectedRevision);
    if (!['scheduled','manual'].includes(input.trigger)) fail('计划触发方式无效。');
    return this._commit(next => {
      const schedule = this._schedule(input.id, next);
      if (schedule.revision !== expectedRevision) fail('计划已变化，请重新确认。');
      if (next.scheduleRuns.some(run => run.scheduleId === schedule.id && run.status === 'running')) fail('这项计划正在执行，请先停止。');
      if (input.trigger === 'scheduled' && (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > Date.parse(now))) fail('计划尚未到期或已暂停。');
      this._workspaceId(schedule.workspaceId, next); for (const attachment of schedule.attachmentIds) this._file(attachment, next);
      scheduleModel.authorization(schedule.authorization); scheduleModel.providerBinding(schedule.providerBinding);
      const captured = copy(schedule), chatId = uid('chat'), messageId = uid('msg'), runId = uid('run');
      const user = messageShape({ id: uid('msg'), role: 'user', content: schedule.prompt, createdAt: now, status: 'complete', attachmentIds: copy(schedule.attachmentIds) });
      const assistant = messageShape({ id: messageId, role: 'assistant', content: '', createdAt: now, status: 'streaming', agentMode: schedule.authorization.allowReadTools, ...(schedule.authorization.allowReadTools ? { toolTrace: [] } : {}) });
      const chat = chatShape({ id: chatId, title: schedule.name, workspaceId: schedule.workspaceId, createdAt: now, updatedAt: now, pinned: false, messages: [user, assistant] });
      if (next.chats.length >= 5000) fail('对话数量超过限制，请整理历史记录后再运行。');
      const run = scheduleModel.runShape({ id: runId, scheduleId: schedule.id, scheduleRevision: schedule.revision, scheduleName: schedule.name, chatId, messageId, scheduledFor: input.trigger === 'scheduled' ? schedule.nextRunAt : now, trigger: input.trigger, status: 'running', dispatchStarted: false, createdAt: now, startedAt: now, scopeSnapshot: { workspaceId: schedule.workspaceId, attachmentIds: copy(schedule.attachmentIds) }, providerBinding: copy(schedule.providerBinding), authorization: copy(schedule.authorization) });
      next.chats.push(chat); next.scheduleRuns.push(run); schedule.lastRunId = runId;
      if (input.trigger === 'scheduled') { schedule.nextRunAt = nextOccurrence(schedule.cadence, now); if (schedule.nextRunAt === null) schedule.enabled = false; }
      schedule.updatedAt = now; scheduleModel.pruneRuns(next); return { schedule: captured, run };
    }, { replaceBackup: true });
  }
  markScheduleDispatched(input) {
    scheduleModel.input(input, ['runId','now']); scheduleModel.iso(input.now);
    return this._commit(next => {
      const run = this._scheduleRun(input.runId, next); if (run.status !== 'running' || run.dispatchStarted) fail('计划请求已结束或已经开始，不允许重发。');
      const schedule = run.scheduleId === null ? null : this._schedule(run.scheduleId, next), chat = next.chats.find(chat => chat.id === run.chatId), message = chat?.messages.find(message => message.id === run.messageId);
      if (!schedule || schedule.revision !== run.scheduleRevision || JSON.stringify({ workspaceId: schedule.workspaceId, attachmentIds: schedule.attachmentIds }) !== JSON.stringify(run.scopeSnapshot) || JSON.stringify(schedule.providerBinding) !== JSON.stringify(run.providerBinding) || JSON.stringify(schedule.authorization) !== JSON.stringify(run.authorization) || !message || message.status !== 'streaming' || chat.workspaceId !== run.scopeSnapshot.workspaceId) fail('计划授权、资料范围或执行对话已变化，本次没有发送。');
      this._workspaceId(schedule.workspaceId, next); for (const attachment of schedule.attachmentIds) this._file(attachment, next);
      run.dispatchStarted = true; return run;
    }, { replaceBackup: true });
  }
  finishScheduleRun(input) {
    scheduleModel.input(input, ['runId','status','now','content','toolTrace','error','pause']); const now = scheduleModel.iso(input.now);
    if (!['succeeded','failed','cancelled'].includes(input.status) || input.pause != null && typeof input.pause !== 'boolean') fail('计划完成状态无效。');
    const error = input.error == null ? '' : scheduleModel.text(input.error, 1400, '计划执行错误', true);
    if (input.content != null) string(input.content, '计划回复', 2000000);
    const trace = input.toolTrace == null ? null : normalizeToolTrace(input.toolTrace);
    return this._commit(next => {
      const run = this._scheduleRun(input.runId, next);
      if (run.status !== 'running') { if (run.status === input.status) return run; fail('计划执行已经结束，不能改写终态记录。'); }
      run.status = input.status; run.finishedAt = now; run.error = error;
      const chat = next.chats.find(chat => chat.id === run.chatId), message = chat?.messages.find(message => message.id === run.messageId);
      if (message) {
        if (input.content != null) message.content = input.content;
        if (trace !== null) { if (!message.agentMode && trace.length) fail('普通计划回复不能保存工具记录。'); if (message.agentMode) message.toolTrace = input.status === 'succeeded' ? trace : cancelToolTrace(trace); }
        else if (message.toolTrace && input.status !== 'succeeded') message.toolTrace = cancelToolTrace(message.toolTrace);
        if (input.status === 'succeeded' && message.toolTrace && hasUnfinishedToolCalls(message.toolTrace)) fail('工具记录尚未结束，不能把计划标记为成功。');
        message.status = input.status === 'succeeded' ? 'complete' : input.status === 'failed' ? 'error' : 'cancelled'; message.error = error; chat.updatedAt = now;
      }
      if (input.pause && run.scheduleId !== null) { const schedule = this._schedule(run.scheduleId, next); if (schedule.revision === run.scheduleRevision) { schedule.enabled = false; if (schedule.revision < Number.MAX_SAFE_INTEGER) schedule.revision++; schedule.updatedAt = now; } }
      scheduleModel.pruneRuns(next); return run;
    }, { replaceBackup: true });
  }
  getArtifact(id) { return publicArtifact(this._artifact(id)); }
  createArtifact(input) {
    artifactInput(input, ['name', 'workspaceId', 'runtime']);
    const now = stamp(), runtime = input.runtime, workspaceId = this._workspaceId(input.workspaceId);
    const artifact = validateArtifact({ id: uid('artifact'), name: typeof input.name === 'string' ? input.name.trim() : input.name, workspaceId, runtime, entryPath: runtime === 'html' ? 'index.html' : 'src/main.tsx', sourceRevision: 1, createdAt: now, updatedAt: now, files: starterFiles(runtime), builds: [], data: { version: 0, values: {} } });
    return this._commit(next => { if (next.artifacts.length >= MAX_ARTIFACTS) fail('Space 数量超过限制。'); this._workspaceId(workspaceId, next); next.artifacts.push(artifact); return publicArtifact(artifact); });
  }
  writeArtifactFiles(input) {
    artifactInput(input, ['id', 'expectedRevision', 'files', 'deletePaths', 'entryPath']);
    const expectedRevision = artifactRevision(input.expectedRevision), files = validateArtifactFiles(input.files);
    const deletePaths = artifactArray(input.deletePaths ?? [], 200, '删除源码路径').map(artifactPath);
    if (new Set(deletePaths.map(value => value.toLowerCase())).size !== deletePaths.length) fail('删除源码路径重复。');
    if (!files.length && !deletePaths.length && input.entryPath == null) fail('没有需要修改的 Space 源码。');
    const entryPath = input.entryPath == null ? null : artifactPath(input.entryPath);
    if (files.some(file => deletePaths.includes(file.path))) fail('同一路径不能同时写入和删除。');
    return this._commit(next => {
      const artifact = this._artifact(input.id, next);
      if (artifact.sourceRevision !== expectedRevision) fail('Space 源码已被其他编辑器修改，请重新载入。');
      if (artifact.sourceRevision === Number.MAX_SAFE_INTEGER) fail('Space 版本超出限制。');
      for (const deleted of deletePaths) if (!artifact.files.some(file => file.path === deleted)) fail('待删除的源码文件不存在。');
      const replacements = new Map(files.map(file => [file.path, file]));
      artifact.files = artifact.files.filter(file => !deletePaths.includes(file.path)).map(file => { const replacement = replacements.get(file.path); replacements.delete(file.path); return replacement || file; });
      artifact.files.push(...replacements.values());
      if (entryPath !== null) artifact.entryPath = entryPath;
      artifact.sourceRevision++; artifact.updatedAt = stamp();
      return publicArtifact(validateArtifact(artifact));
    });
  }
  readArtifactFile(input) {
    artifactInput(input, ['id', 'path']); const name = artifactPath(input.path), artifact = this._artifact(input.id);
    const file = artifact.files.find(item => item.path === name); if (!file) fail('Space 源码文件不存在。');
    const bytes = artifactFileBytes(file);
    return { ...copy(file), sha256: sha256(bytes), size: bytes.length, editable: Object.hasOwn(file, 'text') };
  }
  // Host-only: not included in the general state snapshot or the preview SDK.
  artifactSourceSnapshot(id) {
    const { name, workspaceId, runtime, entryPath, sourceRevision, createdAt, updatedAt, files } = this._artifact(id);
    return { id, name, workspaceId, runtime, entryPath, sourceRevision, createdAt, updatedAt, files: copy(files) };
  }
  commitArtifactBuild(input) {
    artifactInput(input, ['id', 'sourceRevision', 'build']); const sourceRevision = artifactRevision(input.sourceRevision), build = validateArtifactBuild(input.build);
    return this._commit(next => {
      const artifact = this._artifact(input.id, next);
      if (artifact.sourceRevision !== sourceRevision || build.sourceRevision !== sourceRevision || build.sourceDigest !== sourceDigest(artifact)) fail('Space 源码已变化，构建结果未保存，请重新构建。');
      if (artifact.builds.some(item => item.id === build.id)) fail('构建标识符已存在，不能覆盖不可变构建。');
      const expectedPage = artifact.runtime === 'react' ? 'index.html' : artifact.entryPath;
      if (!build.pages.some(page => page.path === expectedPage)) fail('构建缺少入口页面。');
      artifact.builds = [...artifact.builds, build].slice(-3); artifact.updatedAt = stamp(); return publicArtifact(artifact);
    });
  }
  readArtifactBuild(input) {
    artifactInput(input, ['id', 'buildId']); const artifact = this._artifact(input.id);
    if (input.buildId != null) identifier(input.buildId, '构建标识符');
    const build = input.buildId == null ? artifact.builds.at(-1) : artifact.builds.find(item => item.id === input.buildId);
    if (!build) fail('Space 尚无可用构建。'); return copy(build);
  }
  deleteArtifact(id) { this._artifact(id); this._commit(next => { next.artifacts = next.artifacts.filter(item => item.id !== id); removeKnowledgeSources(next, [{ kind: 'artifact', id }]); return null; }, { replaceBackup: true }); return this.snapshot(); }
  artifactDataGet(input) {
    artifactInput(input, ['id', 'key']); const key = artifactDataKey(input.key), data = this._artifact(input.id).data;
    return { key, found: Object.hasOwn(data.values, key), ...(Object.hasOwn(data.values, key) ? { value: copy(data.values[key]) } : {}), version: data.version };
  }
  artifactDataList(input) {
    artifactInput(input, ['id', 'prefix']); const prefix = artifactDataKey(input.prefix ?? '', true), data = this._artifact(input.id).data;
    return { version: data.version, items: Object.keys(data.values).filter(key => key.startsWith(prefix)).sort().map(key => ({ key, value: copy(data.values[key]) })) };
  }
  artifactDataSet(input) {
    artifactInput(input, ['id', 'key', 'value', 'expectedVersion']); const key = artifactDataKey(input.key), value = artifactJson(input.value), expectedVersion = artifactRevision(input.expectedVersion, true);
    return this._commit(next => { const artifact = this._artifact(input.id, next), data = artifact.data; if (data.version !== expectedVersion) fail('Space 数据已变化，请重新读取后再保存。'); if (data.version === Number.MAX_SAFE_INTEGER) fail('Space 数据版本超出限制。'); data.values[key] = value; data.version++; artifact.updatedAt = stamp(); return { version: data.version, key, value }; });
  }
  artifactDataDelete(input) {
    artifactInput(input, ['id', 'key', 'expectedVersion']); const key = artifactDataKey(input.key), expectedVersion = artifactRevision(input.expectedVersion, true);
    return this._commit(next => { const artifact = this._artifact(input.id, next), data = artifact.data; if (data.version !== expectedVersion) fail('Space 数据已变化，请重新读取后再删除。'); if (data.version === Number.MAX_SAFE_INTEGER) fail('Space 数据版本超出限制。'); const deleted = Object.hasOwn(data.values, key); delete data.values[key]; data.version++; artifact.updatedAt = stamp(); return { version: data.version, deleted }; }, { replaceBackup: true });
  }
  exportData() {
    let total = 0;
    const files = this.state.files.map(file => { const bytes = fs.readFileSync(this.filePath(file.id)); total += bytes.length; if (total > MAX_BACKUP_BYTES) fail('附件总量过大，请分批备份。'); return { ...publicFile(file), dataBase64: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') }; });
    const exportedAt = stamp(), chats = copy(this.state.chats), schedules = this.state.schedules.map(schedule => ({ ...copy(schedule), enabled: false }));
    const scheduleRuns = this.state.scheduleRuns.map(item => {
      const run = copy(item); if (run.status !== 'running') return run;
      run.status = 'interrupted'; run.finishedAt = exportedAt; run.error = '备份中的计划执行已停止，导入后不会自动重发。';
      const message = chats.find(chat => chat.id === run.chatId)?.messages.find(message => message.id === run.messageId);
      if (message) { message.status = 'cancelled'; message.error = run.error; if (message.toolTrace) message.toolTrace = cancelToolTrace(message.toolTrace); }
      return run;
    });
    const data = { format: BACKUP_FORMAT, schemaVersion: 1, exportedAt, settings: { ...copy(this.state.settings), backgroundTasks: false }, workspaces: copy(this.state.workspaces), chats, files, artifacts: this.state.artifacts.map(artifact => ({ ...copy(artifact), builds: copy(artifact.builds.slice(-1)) })), schedules, scheduleRuns, memoryDocuments: copy(this.state.memoryDocuments), memories: copy(this.state.memories), skills: copy(this.state.skills), agentProfiles: copy(this.state.agentProfiles), memoryIndexes: copy(this.state.memoryIndexes) };
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_BACKUP_JSON_BYTES) fail('备份超过 150 MB，请先减少附件数量后重试。');
    return data;
  }
  async importData(data) {
    record(data, '备份'); onlyKeys(data, ['format', 'schemaVersion', 'exportedAt', 'settings', 'workspaces', 'chats', 'files', 'artifacts', 'schedules', 'scheduleRuns','memoryDocuments','memories','skills','agentProfiles','memoryIndexes'], '备份');
    let serialized;
    try { serialized = JSON.stringify(data); } catch { fail('备份结构无效，无法读取。'); }
    if (Buffer.byteLength(serialized) > MAX_BACKUP_JSON_BYTES) fail('备份超过 150 MB，无法导入。');
    if (data.format !== BACKUP_FORMAT || data.schemaVersion !== 1) fail('不是受支持的 Muse Windows 备份。');
    date(data.exportedAt);
    const settings = validateSettings(data.settings); settings.backgroundTasks = this.state.settings.backgroundTasks;
    settings.speechBaseUrl=this.state.settings.speechBaseUrl;settings.transcriptionModel=this.state.settings.transcriptionModel;settings.dictationAutoSend=false;
    settings.synthesisModel=this.state.settings.synthesisModel;settings.synthesisVoice=this.state.settings.synthesisVoice;
    if (!Array.isArray(data.workspaces) || data.workspaces.length > 1000 || !Array.isArray(data.chats) || data.chats.length > 5000 || !Array.isArray(data.files) || data.files.length > 10000) fail('备份内容超出限制或格式无效。');
    for (const item of data.workspaces) onlyKeys(record(item, '工作区'), ['id', 'name', 'description', 'color', 'createdAt', 'updatedAt'], '备份工作区');
    for (const item of data.chats) {
      onlyKeys(record(item, '对话'), ['id', 'title', 'workspaceId', 'createdAt', 'updatedAt', 'pinned', 'messages','profileId'], '备份对话');
      if (!Array.isArray(item.messages)) fail('备份消息列表无效。');
      for (const message of item.messages) onlyKeys(record(message, '消息'), ['id', 'role', 'content', 'createdAt', 'status', 'attachmentIds', 'error', 'agentMode', 'toolTrace', 'replyTo', 'isDeleted', 'artifactContext', 'activePanel'], '备份消息');
    }
    let total = 0;
    const buffers = new Map(), source = { workspaces: data.workspaces.map(workspaceShape), chats: data.chats.map(chatShape), files: data.files.map(file => {
      onlyKeys(record(file, '文件'), ['id', 'name', 'mime', 'size', 'workspaceId', 'createdAt', 'textStatus', 'textPreview', 'error', 'dataBase64', 'sha256'], '备份文件');
      const item = fileShape(file);
      if (typeof file.dataBase64 !== 'string' || file.dataBase64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.dataBase64)) fail('备份附件的 Base64 数据无效。');
      const bytes = Buffer.from(file.dataBase64, 'base64'); total += bytes.length;
      if (total > MAX_BACKUP_BYTES || bytes.length !== item.size || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) fail('备份附件大小或校验值不匹配。');
      buffers.set(item.id, bytes); return item;
    }), artifacts: data.artifacts === undefined ? [] : artifactArray(data.artifacts, MAX_ARTIFACTS, '备份 Space').map(validateArtifact), schedules: data.schedules === undefined ? [] : scheduleModel.array(data.schedules, scheduleModel.MAX_SCHEDULES, '备份计划').map(scheduleModel.scheduleShape), scheduleRuns: data.scheduleRuns === undefined ? [] : scheduleModel.array(data.scheduleRuns, scheduleModel.MAX_SCHEDULE_RUNS, '备份执行记录').map(scheduleModel.runShape), ...knowledgeFields(data) };
    validateRelations(source);
    const importedGlobalDocument = source.memoryDocuments.find(item => item.workspaceId === null), existingGlobalDocument = this.state.memoryDocuments.find(item => item.workspaceId === null);
    if (importedGlobalDocument && existingGlobalDocument && importedGlobalDocument.digest !== existingGlobalDocument.digest) fail('全局长期记忆 MEMORY.md 内容冲突，导入未改变任何数据。请保留两边备份，明确整理或删除当前全局记忆后再导入。');
    const reusedGlobalDocument = importedGlobalDocument && existingGlobalDocument ? existingGlobalDocument : null;
    const workspaceIds = new Map(source.workspaces.map(item => [item.id, uid('ws')])), fileIds = new Map(), prepared = [];
    const artifactIds = new Map(source.artifacts.map(item => [item.id, uid('artifact')])), buildIds = new Map();
    const chatIds = new Map(source.chats.map(item => [item.id, uid('chat')])), messageIdsByChat = new Map(source.chats.map(chat => [chat.id, new Map(chat.messages.map(message => [message.id, uid('msg')]))]));
    const scheduleIds = new Map(source.schedules.map(item => [item.id, uid('schedule')])), runIds = new Map(source.scheduleRuns.map(item => [item.id, uid('run')]));
    const memoryDocumentIds = new Map(source.memoryDocuments.map(item => [item.id, reusedGlobalDocument && item.id === importedGlobalDocument.id ? reusedGlobalDocument.id : uid('memorydoc')])), memoryIds = new Map(source.memories.map(item => [item.id, uid('memory')])), skillIds = new Map(source.skills.map(item => [item.id, uid('skill')])), profileIds = new Map(source.agentProfiles.map(item => [item.id, uid('profile')]));
    const snapshotIds = new Map(source.agentProfiles.flatMap(profile => profile.knowledgeSnapshots.map(item => [item.id, uid('snapshot')])));
    // Only the retained latest build exists after import. Older historical IDs
    // stay historical instead of being remapped to phantom build identities.
    for (const item of source.artifacts) for (const build of item.builds.slice(-1)) if (!buildIds.has(build.id)) buildIds.set(build.id, uid('build'));
    try {
      for (const item of source.files) { const file = await this._prepareFile(buffers.get(item.id), item.name, item.workspaceId === null ? null : workspaceIds.get(item.workspaceId)); file.createdAt = item.createdAt; prepared.push(file); fileIds.set(item.id, file.id); }
      const workspaces = source.workspaces.map(item => ({ ...item, id: workspaceIds.get(item.id) }));
      const artifacts = source.artifacts.map(item => ({ ...item, id: artifactIds.get(item.id), workspaceId: item.workspaceId === null ? null : workspaceIds.get(item.workspaceId), builds: item.builds.slice(-1).map(build => ({ ...build, id: buildIds.get(build.id) })) }));
      // Message annotations are historical references, not live app authority.
      // Remap only identities actually restored by this import; a removed app
      // or an older, unretained build keeps its descriptive historical ID.
      const remapArtifactContext = context => ({ ...context, artifactId: artifactIds.has(context.artifactId) ? artifactIds.get(context.artifactId) : context.artifactId, buildId: buildIds.has(context.buildId) ? buildIds.get(context.buildId) : context.buildId });
      const remapActivePanel = panel => ({ ...panel, artifactId: artifactIds.has(panel.artifactId) ? artifactIds.get(panel.artifactId) : panel.artifactId });
      const remapSource = (kind, id) => ({ memory_document: memoryDocumentIds, memory: memoryIds, file: fileIds, chat: chatIds, artifact: artifactIds }[kind]).get(id), remapWorkspace = id => id === null ? null : workspaceIds.get(id);
      const remapSourceVersion = item => reusedGlobalDocument && item.kind === 'memory_document' && item.sourceId === importedGlobalDocument.id ? { sourceRevision: reusedGlobalDocument.revision, sourceDigest: reusedGlobalDocument.digest } : {};
      const memoryDocuments = source.memoryDocuments.filter(item => !(reusedGlobalDocument && item.id === importedGlobalDocument.id)).map(item => ({ ...item, id: memoryDocumentIds.get(item.id), workspaceId: remapWorkspace(item.workspaceId) }));
      const memories = source.memories.map(item => ({ ...item, id: memoryIds.get(item.id), workspaceId: remapWorkspace(item.workspaceId), provenance: item.provenance.kind === 'manual' ? item.provenance : { ...item.provenance, ...remapSourceVersion(item.provenance), sourceId: remapSource(item.provenance.kind, item.provenance.sourceId) } }));
      const skills = source.skills.map(item => ({ ...item, id: skillIds.get(item.id), workspaceId: remapWorkspace(item.workspaceId), enabled: false, consents: [] }));
      const agentProfiles = source.agentProfiles.map(item => ({ ...item, id: profileIds.get(item.id), workspaceId: remapWorkspace(item.workspaceId), needsReview: true, memoryDocumentIds: item.memoryDocumentIds.map(id => memoryDocumentIds.get(id)), skillRefs: item.skillRefs.map(ref => ({ ...ref, skillId: skillIds.get(ref.skillId), consentId: null })), knowledgeSnapshots: item.knowledgeSnapshots.map(snapshot => ({ ...snapshot, ...remapSourceVersion(snapshot), id: snapshotIds.get(snapshot.id), sourceId: remapSource(snapshot.kind, snapshot.sourceId) })) }));
      // A stale index is a derived cache, not source knowledge. Keep no stale
      // imported postings. Global merging also needs an explicit rebuild.
      const memoryIndexes = source.memoryIndexes.filter(index => index.workspaceId !== null && index.sourceDigest === require('./knowledge-search.cjs').memorySourceDigest(source.memories, index.workspaceId)).map(index => {
        const result = { ...index, workspaceId: remapWorkspace(index.workspaceId), sourceDigest: require('./knowledge-search.cjs').memorySourceDigest(memories, remapWorkspace(index.workspaceId)), documents: index.documents.map(doc => ({ ...doc, id: memoryIds.get(doc.id) })).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), postings: index.postings.map(term => ({ ...term, documents: term.documents.map(doc => ({ ...doc, id: memoryIds.get(doc.id) })).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) })) }; result.indexDigest = require('./knowledge-search.cjs').indexHash(result); return require('./knowledge-search.cjs').validateMemoryIndex(result);
      });
      const schedules = source.schedules.map(item => ({ ...item, id: scheduleIds.get(item.id), workspaceId: item.workspaceId === null ? null : workspaceIds.get(item.workspaceId), attachmentIds: item.attachmentIds.map(id => fileIds.get(id)), enabled: false, ...(item.lastRunId ? { lastRunId: runIds.get(item.lastRunId) } : {}) }));
      const scheduleRuns = source.scheduleRuns.map(item => ({ ...item, id: runIds.get(item.id), scheduleId: item.scheduleId === null ? null : scheduleIds.get(item.scheduleId), chatId: item.chatId === null ? null : chatIds.get(item.chatId), messageId: item.chatId === null ? null : messageIdsByChat.get(item.chatId).get(item.messageId), scopeSnapshot: { workspaceId: item.scopeSnapshot.workspaceId === null ? null : workspaceIds.get(item.scopeSnapshot.workspaceId), attachmentIds: item.scopeSnapshot.attachmentIds.map(id => fileIds.get(id)) }, ...(item.status === 'running' ? { status: 'interrupted', finishedAt: stamp(), error: '导入的计划执行已停止，不会自动重发。' } : {}) }));
      const chats = source.chats.map(item => {
        const messageIds = messageIdsByChat.get(item.id);
        return { ...item, id: chatIds.get(item.id), workspaceId: item.workspaceId === null ? null : workspaceIds.get(item.workspaceId), ...(item.profileId ? { profileId: profileIds.get(item.profileId) } : {}), messages: item.messages.map(message => ({ ...message, id: messageIds.get(message.id), status: message.status === 'streaming' || message.toolTrace && hasUnfinishedToolCalls(message.toolTrace) ? 'cancelled' : message.status, ...(message.replyTo ? { replyTo: { ...message.replyTo, messageId: messageIds.get(message.replyTo.messageId) } } : {}), ...(message.artifactContext ? { artifactContext: remapArtifactContext(message.artifactContext) } : {}), ...(message.activePanel ? { activePanel: remapActivePanel(message.activePanel) } : {}), ...(message.toolTrace ? { toolTrace: remapToolTrace(cancelToolTrace(message.toolTrace), { fileIds, workspaceIds, artifactIds, buildIds, scheduleIds, runIds, chatIds, messageIdsByChat, memoryIds }) } : {}), ...(message.attachmentIds ? { attachmentIds: message.attachmentIds.map(id => fileIds.get(id)) } : {}) })) };
      });
      this._commit(next => { if (next.workspaces.length + workspaces.length > 1000 || next.chats.length + chats.length > 5000 || next.files.length + prepared.length > 10000 || next.artifacts.length + artifacts.length > MAX_ARTIFACTS || next.schedules.length + schedules.length > scheduleModel.MAX_SCHEDULES) fail('合并后的数据数量超出限制。'); next.settings = settings; next.workspaces.push(...workspaces); next.chats.push(...chats); next.files.push(...prepared); next.artifacts.push(...artifacts); next.schedules.push(...schedules); next.scheduleRuns.push(...scheduleRuns); next.memoryDocuments.push(...memoryDocuments); next.memories.push(...memories); next.skills.push(...skills); next.agentProfiles.push(...agentProfiles); next.memoryIndexes.push(...memoryIndexes); scheduleModel.pruneRuns(next); return null; });
      return this.snapshot();
    } catch (error) { for (const item of prepared) this._discardFile(item); throw error; }
  }
  flush() { this._persistState(this.state); }
}

module.exports = { Store, DEFAULTS, BACKUP_FORMAT, STATE_VERSION, MAX_BACKUP_JSON_BYTES, MAX_EDITABLE_FILE_BYTES };
