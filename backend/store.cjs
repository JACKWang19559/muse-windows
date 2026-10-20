'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { MAX_FILE_BYTES, MAX_TEXT_CHARS, TEXT_EXTENSIONS, describeFile, extractDocument } = require('./documents.cjs');
const { normalizeToolTrace, cancelToolTrace, hasUnfinishedToolCalls, remapToolTrace } = require('./tool-trace.cjs');

const STATE_VERSION = 1;
const BACKUP_FORMAT = 'muse-windows-backup';
const MAX_BACKUP_BYTES = 250 * 1024 * 1024;
const MAX_BACKUP_JSON_BYTES = 150 * 1024 * 1024;
const MAX_STATE_BYTES = 100 * 1024 * 1024;
const MAX_EDITABLE_FILE_BYTES = 1024 * 1024;
const FILE_EDIT_DIRECTORY = /^\.file-edit-[0-9a-f-]{36}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const DEFAULTS = { baseUrl: 'https://api.openai.com/v1', model: '', systemPrompt: '你是一位认真、清晰、乐于协作的 AI 助手。请优先使用中文回答，并明确区分事实与推测。', temperature: 0.7, theme: 'system', language: 'zh', transcriptionModel: '' };
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
    if (key === 'temperature') { if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 2) fail('温度必须在 0 到 2 之间。'); result[key] = value[key]; }
    else if (key === 'theme') { if (!['light', 'dark', 'system'].includes(value[key])) fail('主题设置无效。'); result[key] = value[key]; }
    else if (key === 'language') { if (value[key] !== 'zh') fail('语言设置无效。'); result[key] = 'zh'; }
    else result[key] = string(value[key], '设置字段', key === 'systemPrompt' ? 50000 : key === 'baseUrl' ? 2048 : 500).trim();
  }
  if (!patch) onlyKeys(value, SETTINGS_KEYS, '设置');
  if (result.baseUrl) {
    let url; try { url = new URL(result.baseUrl); } catch { fail('API 地址无效，请填写完整的 HTTP/HTTPS 地址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('API 地址仅支持 HTTP/HTTPS，且不能包含登录信息或片段。');
  }
  return result;
}
function workspaceShape(value) {
  record(value, '工作区');
  return { id: identifier(value.id), name: string(value.name, '工作区名称', 160, { empty: false }), description: string(value.description, '工作区描述', 4000), color: /^#[0-9a-fA-F]{6}$/.test(value.color) ? value.color : fail('工作区颜色无效。'), createdAt: date(value.createdAt), updatedAt: date(value.updatedAt) };
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
  if (value.attachmentIds != null) {
    if (!Array.isArray(value.attachmentIds) || value.attachmentIds.length > 100) fail('附件列表无效。');
    result.attachmentIds = [...new Set(value.attachmentIds.map(id => identifier(id, '附件标识符')))];
  }
  return result;
}
function chatShape(value) {
  record(value, '对话');
  if (typeof value.pinned !== 'boolean' || !Array.isArray(value.messages) || value.messages.length > 20000) fail('对话格式无效。');
  return { id: identifier(value.id), title: string(value.title, '对话标题', 200, { empty: false }), workspaceId: value.workspaceId === null ? null : identifier(value.workspaceId), createdAt: date(value.createdAt), updatedAt: date(value.updatedAt), pinned: value.pinned, messages: value.messages.map(messageShape) };
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
function validateRelations(state) {
  unique(state.workspaces.map(item => item.id), '工作区'); unique(state.chats.map(item => item.id), '对话'); unique(state.files.map(item => item.id), '文件');
  const workspaces = new Set(state.workspaces.map(item => item.id)), files = new Set(state.files.map(item => item.id));
  for (const item of [...state.chats, ...state.files]) if (item.workspaceId !== null && !workspaces.has(item.workspaceId)) fail('数据引用了不存在的工作区。');
  for (const chat of state.chats) {
    unique(chat.messages.map(item => item.id), '消息');
    for (const message of chat.messages) for (const id of message.attachmentIds || []) if (!files.has(id)) fail('消息引用了不存在的附件。');
  }
}
function stateShape(value) {
  record(value, '本地数据');
  if (value.schemaVersion !== STATE_VERSION || !Array.isArray(value.workspaces) || value.workspaces.length > 1000 || !Array.isArray(value.chats) || value.chats.length > 5000 || !Array.isArray(value.files) || value.files.length > 10000) fail('本地数据版本或结构不受支持。');
  const encrypted = value.encryptedApiKey;
  if (encrypted != null && (typeof encrypted !== 'string' || encrypted.length > 65536 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted))) fail('本地密钥记录损坏。');
  const state = { schemaVersion: STATE_VERSION, settings: validateSettings(value.settings), encryptedApiKey: encrypted || null, workspaces: value.workspaces.map(workspaceShape), chats: value.chats.map(chatShape), files: value.files.map(item => fileShape(item, true)) };
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
      } else this.state = { schemaVersion: 1, settings: { ...DEFAULTS }, encryptedApiKey: null, workspaces: [], chats: [], files: [] };
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
    let interrupted = false;
    for (const chat of this.state.chats) for (const message of chat.messages) if (message.status === 'streaming' || message.toolTrace && hasUnfinishedToolCalls(message.toolTrace)) { message.status = 'cancelled'; if (message.toolTrace) message.toolTrace = cancelToolTrace(message.toolTrace); interrupted = true; }
    if (interrupted) this.recoveryNotice = '上次关闭时仍在生成的消息已标记为已停止，可以重试。';
    this._persistState(this.state);
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
  _persistState(state) {
    const json = JSON.stringify(state);
    if (Buffer.byteLength(json) > MAX_STATE_BYTES) fail('本地数据超出容量限制。');
    const temporary = path.join(this.dataDir, `.state-${crypto.randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(descriptor, json, 'utf8'); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = null;
      if (fs.existsSync(this.statePath)) {
        const stat = fs.lstatSync(this.statePath);
        if (!stat.isFile() || stat.isSymbolicLink()) fail('本地数据路径不安全。');
        const backupTmp = path.join(this.dataDir, `.backup-${crypto.randomUUID()}.tmp`);
        try { fs.copyFileSync(this.statePath, backupTmp, fs.constants.COPYFILE_EXCL); fs.renameSync(backupTmp, this.backupPath); }
        finally { if (fs.existsSync(backupTmp)) fs.unlinkSync(backupTmp); }
      }
      fs.renameSync(temporary, this.statePath);
    } catch (error) { filesystemFailure(error, '无法保存本地数据，请检查磁盘空间和文件权限。'); }
    finally { if (descriptor != null) fs.closeSync(descriptor); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  _commit(change) { const next = copy(this.state), result = change(next), validated = stateShape(next); this._persistState(validated); this.state = validated; return copy(result); }
  _workspace(id, state = this.state) { const workspace = state.workspaces.find(item => item.id === id); if (!workspace) fail('工作区不存在。'); return workspace; }
  _workspaceId(id, state = this.state) { if (id == null) return null; identifier(id); this._workspace(id, state); return id; }
  _chat(id, state = this.state) { identifier(id); const chat = state.chats.find(item => item.id === id); if (!chat) fail('对话不存在。'); return chat; }
  _file(id, state = this.state) { identifier(id); const file = state.files.find(item => item.id === id); if (!file) fail('附件不存在。'); return file; }
  snapshot() { return { settings: this.settings(), workspaces: copy(this.state.workspaces), chats: copy(this.state.chats), files: this.state.files.map(publicFile), app: { version: '0.1.0', platform: process.platform } }; }
  settings() { return { ...copy(this.state.settings), hasApiKey: Boolean(this.state.encryptedApiKey) }; }
  secret() {
    if (!this.state.encryptedApiKey) return '';
    if (typeof this.decrypt !== 'function') fail('系统密钥解密服务不可用，请重新输入 API 密钥。');
    try { const value = this.decrypt(Buffer.from(this.state.encryptedApiKey, 'base64')); if (typeof value !== 'string') fail('invalid'); return value; }
    catch { fail('无法解密本机 API 密钥，请在设置中重新输入。'); }
  }
  saveSettings(input) {
    record(input, '设置'); onlyKeys(input, [...SETTINGS_KEYS, 'apiKey', 'clearApiKey'], '设置');
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
    this._commit(next => { next.settings = settings; next.encryptedApiKey = encrypted; return null; }); return this.settings();
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
    this._workspace(id); this._commit(next => { next.workspaces = next.workspaces.filter(item => item.id !== id); for (const item of [...next.chats, ...next.files]) if (item.workspaceId === id) { item.workspaceId = null; if ('updatedAt' in item) item.updatedAt = stamp(); } return null; }); return this.snapshot();
  }
  createChat(input = {}) {
    record(input, '对话'); onlyKeys(input, ['workspaceId', 'title'], '对话');
    const now = stamp(), chat = chatShape({ id: uid('chat'), title: input.title || '新对话', workspaceId: this._workspaceId(input.workspaceId), createdAt: now, updatedAt: now, pinned: false, messages: [] });
    return this._commit(next => { next.chats.push(chat); return chat; });
  }
  updateChat(input) {
    record(input, '对话'); onlyKeys(input, ['id', 'title', 'pinned', 'workspaceId'], '对话'); this._chat(input.id);
    if ('workspaceId' in input) this._workspaceId(input.workspaceId);
    return this._commit(next => { const item = this._chat(input.id, next), value = chatShape({ ...item, ...input, updatedAt: stamp() }); Object.assign(item, value); return item; });
  }
  deleteChat(id) { this._chat(id); this._commit(next => { next.chats = next.chats.filter(item => item.id !== id); return null; }); return this.snapshot(); }
  getChat(id) { return copy(this._chat(id)); }
  appendMessage(chatId, input) {
    record(input, '消息'); onlyKeys(input, ['id', 'role', 'content', 'createdAt', 'status', 'attachmentIds', 'error', 'agentMode', 'toolTrace'], '消息');
    const message = messageShape({ id: input.id || uid('msg'), createdAt: stamp(), status: 'complete', ...input });
    for (const id of message.attachmentIds || []) this._file(id);
    return this._commit(next => { const chat = this._chat(chatId, next); if (chat.messages.some(item => item.id === message.id)) fail('消息标识符已存在。'); chat.messages.push(message); chat.updatedAt = stamp(); return message; });
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
    this._commit(next => { next.files = next.files.filter(file => file.id !== id); for (const chat of next.chats) for (const message of chat.messages) if (message.attachmentIds) message.attachmentIds = message.attachmentIds.filter(fileId => fileId !== id); return null; });
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
  exportData() {
    let total = 0;
    const files = this.state.files.map(file => { const bytes = fs.readFileSync(this.filePath(file.id)); total += bytes.length; if (total > MAX_BACKUP_BYTES) fail('附件总量过大，请分批备份。'); return { ...publicFile(file), dataBase64: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') }; });
    const data = { format: BACKUP_FORMAT, schemaVersion: 1, exportedAt: stamp(), settings: copy(this.state.settings), workspaces: copy(this.state.workspaces), chats: copy(this.state.chats), files };
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_BACKUP_JSON_BYTES) fail('备份超过 150 MB，请先减少附件数量后重试。');
    return data;
  }
  async importData(data) {
    record(data, '备份'); onlyKeys(data, ['format', 'schemaVersion', 'exportedAt', 'settings', 'workspaces', 'chats', 'files'], '备份');
    let serialized;
    try { serialized = JSON.stringify(data); } catch { fail('备份结构无效，无法读取。'); }
    if (Buffer.byteLength(serialized) > MAX_BACKUP_JSON_BYTES) fail('备份超过 150 MB，无法导入。');
    if (data.format !== BACKUP_FORMAT || data.schemaVersion !== 1) fail('不是受支持的 Muse Windows 备份。');
    date(data.exportedAt);
    const settings = validateSettings(data.settings);
    if (!Array.isArray(data.workspaces) || data.workspaces.length > 1000 || !Array.isArray(data.chats) || data.chats.length > 5000 || !Array.isArray(data.files) || data.files.length > 10000) fail('备份内容超出限制或格式无效。');
    for (const item of data.workspaces) onlyKeys(record(item, '工作区'), ['id', 'name', 'description', 'color', 'createdAt', 'updatedAt'], '备份工作区');
    for (const item of data.chats) {
      onlyKeys(record(item, '对话'), ['id', 'title', 'workspaceId', 'createdAt', 'updatedAt', 'pinned', 'messages'], '备份对话');
      if (!Array.isArray(item.messages)) fail('备份消息列表无效。');
      for (const message of item.messages) onlyKeys(record(message, '消息'), ['id', 'role', 'content', 'createdAt', 'status', 'attachmentIds', 'error', 'agentMode', 'toolTrace'], '备份消息');
    }
    let total = 0;
    const buffers = new Map(), source = { workspaces: data.workspaces.map(workspaceShape), chats: data.chats.map(chatShape), files: data.files.map(file => {
      onlyKeys(record(file, '文件'), ['id', 'name', 'mime', 'size', 'workspaceId', 'createdAt', 'textStatus', 'textPreview', 'error', 'dataBase64', 'sha256'], '备份文件');
      const item = fileShape(file);
      if (typeof file.dataBase64 !== 'string' || file.dataBase64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.dataBase64)) fail('备份附件的 Base64 数据无效。');
      const bytes = Buffer.from(file.dataBase64, 'base64'); total += bytes.length;
      if (total > MAX_BACKUP_BYTES || bytes.length !== item.size || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) fail('备份附件大小或校验值不匹配。');
      buffers.set(item.id, bytes); return item;
    }) };
    validateRelations(source);
    const workspaceIds = new Map(source.workspaces.map(item => [item.id, uid('ws')])), fileIds = new Map(), prepared = [];
    try {
      for (const item of source.files) { const file = await this._prepareFile(buffers.get(item.id), item.name, item.workspaceId === null ? null : workspaceIds.get(item.workspaceId)); file.createdAt = item.createdAt; prepared.push(file); fileIds.set(item.id, file.id); }
      const workspaces = source.workspaces.map(item => ({ ...item, id: workspaceIds.get(item.id) }));
      const chats = source.chats.map(item => ({ ...item, id: uid('chat'), workspaceId: item.workspaceId === null ? null : workspaceIds.get(item.workspaceId), messages: item.messages.map(message => ({ ...message, id: uid('msg'), status: message.status === 'streaming' || message.toolTrace && hasUnfinishedToolCalls(message.toolTrace) ? 'cancelled' : message.status, ...(message.toolTrace ? { toolTrace: remapToolTrace(cancelToolTrace(message.toolTrace), { fileIds, workspaceIds }) } : {}), ...(message.attachmentIds ? { attachmentIds: message.attachmentIds.map(id => fileIds.get(id)) } : {}) })) }));
      this._commit(next => { if (next.workspaces.length + workspaces.length > 1000 || next.chats.length + chats.length > 5000 || next.files.length + prepared.length > 10000) fail('合并后的数据数量超出限制。'); next.settings = settings; next.workspaces.push(...workspaces); next.chats.push(...chats); next.files.push(...prepared); return null; });
      return this.snapshot();
    } catch (error) { for (const item of prepared) this._discardFile(item); throw error; }
  }
  flush() { this._persistState(this.state); }
}

module.exports = { Store, DEFAULTS, BACKUP_FORMAT, STATE_VERSION, MAX_BACKUP_JSON_BYTES, MAX_EDITABLE_FILE_BYTES };
