'use strict';

// Independent local knowledge records. Guidance is data, never an executable
// skill package or a grant of host tool permissions.
const crypto = require('node:crypto');
const { types } = require('node:util');
const MAX_MEMORIES = 5000, MAX_SKILLS = 500, MAX_PROFILES = 500;
const MAX_MEMORY_CODEPOINTS = 200000, MAX_MEMORY_BYTES = 1024 * 1024;
const MAX_GUIDANCE_CODEPOINTS = 100000, MAX_GUIDANCE_BYTES = 100 * 1024;
const MAX_SNAPSHOT_CODEPOINTS = 8192, POLICY_REVISION = 1;
const SOURCE_KINDS = ['memory_document', 'memory', 'file', 'chat', 'artifact'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message || '知识数据格式无效。'); };
function input(value, keys, label = '知识记录') {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label}格式无效。`);
  for (const key of Reflect.ownKeys(value)) { const d = Object.getOwnPropertyDescriptor(value, key); if (typeof key !== 'string' || ['__proto__','constructor','prototype'].includes(key) || !keys.includes(key) || !d.enumerable || !Object.hasOwn(d, 'value')) fail(`${label}包含不支持的字段。`); }
  return value;
}
function array(value, max, label = '知识列表') {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail(`${label}数量或格式无效。`);
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail(`${label}格式无效。`); }
  return value;
}
function text(value, max, label = '知识文本', maxBytes = Infinity, empty = true) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max * 2 || [...value].length > max || Buffer.byteLength(value) > maxBytes || Buffer.from(value).toString('utf8') !== value || !empty && !value.trim()) fail(`${label}无效或超出长度限制。`);
  return value;
}
function name(value) { const result = text(value, 160, '名称', Infinity, false); if (/[\p{Cc}\p{Cf}]/u.test(result)) fail('名称不能包含控制字符。'); return result; }
function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail('知识引用标识符无效。'); return value; }
function scope(value) { return value === null ? null : id(value); }
function revision(value, zero = false) { if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) fail('知识版本无效。'); return value; }
function bump(value) { revision(value); if (value === Number.MAX_SAFE_INTEGER) fail('知识版本已达到上限。'); return value + 1; }
function iso(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('知识日期无效。'); return value; }
function digest(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('知识校验值无效。'); return value; }
function ids(value, max = 50) { const result = array(value, max).map(id); if (new Set(result).size !== result.length) fail('知识引用不能重复。'); return result; }
function memoryText(value) { return text(value, MAX_MEMORY_CODEPOINTS, '记忆正文', MAX_MEMORY_BYTES); }
function provenance(value) {
  input(value, ['kind','sourceId','sourceRevision','sourceDigest','capturedAt'], '知识来源');
  if (!['manual', ...SOURCE_KINDS].includes(value.kind)) fail('知识来源类型无效。');
  const result = { kind: value.kind, capturedAt: iso(value.capturedAt) };
  if (value.kind === 'manual') { if (['sourceId','sourceRevision','sourceDigest'].some(key => Object.hasOwn(value, key))) fail('手动知识不能带有来源引用。'); }
  else { result.sourceId = id(value.sourceId); if (value.sourceRevision !== undefined) result.sourceRevision = revision(value.sourceRevision); if (value.sourceDigest !== undefined) result.sourceDigest = digest(value.sourceDigest); }
  return result;
}
function memoryDocument(value) {
  input(value, ['id','workspaceId','path','contentMarkdown','revision','digest','createdAt','updatedAt'], '记忆文档');
  if (value.path !== 'MEMORY.md') fail('记忆文档路径无效。');
  const contentMarkdown = memoryText(value.contentMarkdown); if (hash(contentMarkdown) !== digest(value.digest)) fail('记忆文档校验失败。');
  return { id: id(value.id), workspaceId: scope(value.workspaceId), path: 'MEMORY.md', contentMarkdown, revision: revision(value.revision), digest: value.digest, createdAt: iso(value.createdAt), updatedAt: iso(value.updatedAt) };
}
function memory(value) {
  input(value, ['id','name','contentMarkdown','workspaceId','revision','digest','provenance','createdAt','updatedAt'], '记忆条目');
  const contentMarkdown = memoryText(value.contentMarkdown); if (hash(contentMarkdown) !== digest(value.digest)) fail('记忆条目校验失败。');
  return { id: id(value.id), name: name(value.name), contentMarkdown, workspaceId: scope(value.workspaceId), revision: revision(value.revision), digest: value.digest, provenance: provenance(value.provenance), createdAt: iso(value.createdAt), updatedAt: iso(value.updatedAt) };
}
function requirements(value) {
  const result = array(value, 50, '工具需求').map(item => { text(item, 100, '工具需求', Infinity, false); if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(item)) fail('工具需求名称无效。'); return item; });
  if (new Set(result).size !== result.length) fail('工具需求不能重复。'); return result.sort();
}
function eligibility(toolRequirements) {
  return require('./skill-package.cjs').skillEligibility(toolRequirements);
}
function skillDigest(value) { const { name, description, version, manifestVersion, guidanceMarkdown, toolRequirements } = value; return require('./skill-package.cjs').skillContentDigest({ name, description, version, manifestVersion, guidanceMarkdown, toolRequirements }); }
function consent(value) {
  input(value, ['id','workspaceId','digest','version','toolRequirements','policyRevision','approvedAt'], '技能授权');
  if (value.policyRevision !== POLICY_REVISION) fail('技能授权策略版本无效。');
  return { id: id(value.id), workspaceId: scope(value.workspaceId), digest: digest(value.digest), version: text(value.version, 64, '技能版本', Infinity, false), toolRequirements: requirements(value.toolRequirements), policyRevision: POLICY_REVISION, approvedAt: iso(value.approvedAt) };
}
function skill(value) {
  input(value, ['id','name','description','version','manifestVersion','guidanceMarkdown','toolRequirements','workspaceId','revision','digest','enabled','eligible','ineligibleReasons','consents','createdAt','updatedAt'], '技能指导');
  if (value.manifestVersion !== 1 || typeof value.enabled !== 'boolean' || typeof value.eligible !== 'boolean') fail('技能指导版本或状态无效。');
  const result = { id: id(value.id), name: name(value.name), description: text(value.description, 4000, '技能描述', Infinity, false), version: text(value.version, 64, '技能版本', Infinity, false), manifestVersion: 1, guidanceMarkdown: text(value.guidanceMarkdown, MAX_GUIDANCE_CODEPOINTS, '技能指导正文', MAX_GUIDANCE_BYTES), toolRequirements: requirements(value.toolRequirements), workspaceId: scope(value.workspaceId), revision: revision(value.revision), digest: digest(value.digest), enabled: value.enabled, ...eligibility(value.toolRequirements), consents: array(value.consents, 1000, '技能授权').map(consent), createdAt: iso(value.createdAt), updatedAt: iso(value.updatedAt) };
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(result.version) || skillDigest(result) !== result.digest) fail('技能内容校验失败。');
  const reportedReasons = array(value.ineligibleReasons, 50, '技能不可用原因').map(item => text(item, 200, '技能不可用原因'));
  if (value.eligible !== result.eligible || JSON.stringify(reportedReasons) !== JSON.stringify(result.ineligibleReasons)) fail('技能可用状态校验失败。');
  if (result.enabled && (!result.eligible || !result.consents.length)) fail('启用的技能需要匹配当前内容的明确授权。');
  ids(result.consents.map(item => item.id), 1000);
  for (const item of result.consents) if (item.workspaceId !== result.workspaceId || item.digest !== result.digest || item.version !== result.version || JSON.stringify(item.toolRequirements) !== JSON.stringify(result.toolRequirements) || !result.eligible) fail('技能授权与当前内容不匹配。');
  return result;
}
function knowledgeSnapshot(value) {
  input(value, ['id','kind','sourceId','sourceRevision','sourceDigest','contentDigest','name','contentMarkdown','capturedAt','truncated'], '知识快照');
  if (!SOURCE_KINDS.includes(value.kind) || typeof value.truncated !== 'boolean') fail('知识快照类型或截取状态无效。');
  const contentMarkdown = text(value.contentMarkdown, MAX_SNAPSHOT_CODEPOINTS, '知识快照'); if (hash(contentMarkdown) !== digest(value.contentDigest)) fail('知识快照校验失败。');
  const result = { id: id(value.id), kind: value.kind, sourceId: id(value.sourceId), sourceDigest: digest(value.sourceDigest), contentDigest: value.contentDigest, name: name(value.name), contentMarkdown, capturedAt: iso(value.capturedAt), truncated: value.truncated };
  if (value.sourceRevision !== undefined) result.sourceRevision = revision(value.sourceRevision); return result;
}
function truncateSnapshot(value) {
  text(value, 3000000, '知识来源正文'); const chars = [...value], suffix = '\n[truncated]';
  return chars.length > MAX_SNAPSHOT_CODEPOINTS ? { contentMarkdown: chars.slice(0, MAX_SNAPSHOT_CODEPOINTS - [...suffix].length).join('') + suffix, truncated: true } : { contentMarkdown: value, truncated: false };
}
function skillRef(value) { input(value, ['skillId','digest','consentId'], '技能引用'); return { skillId: id(value.skillId), digest: digest(value.digest), consentId: value.consentId === null ? null : id(value.consentId) }; }
function profile(value) {
  input(value, ['id','name','workspaceId','instructions','revision','needsReview','knowledgeSnapshots','skillRefs','memoryDocumentIds','toolPolicy','createdAt','updatedAt'], '助手配置');
  if (typeof value.needsReview !== 'boolean' || !['read','workspace'].includes(value.toolPolicy)) fail('助手确认或工具策略无效。');
  const result = { id: id(value.id), name: name(value.name), workspaceId: scope(value.workspaceId), instructions: text(value.instructions, 50000, '助手指导'), revision: revision(value.revision), needsReview: value.needsReview, knowledgeSnapshots: array(value.knowledgeSnapshots, 50, '知识快照').map(knowledgeSnapshot), skillRefs: array(value.skillRefs, 50, '技能引用').map(skillRef), memoryDocumentIds: ids(value.memoryDocumentIds, 1), toolPolicy: value.toolPolicy, createdAt: iso(value.createdAt), updatedAt: iso(value.updatedAt) };
  ids(result.knowledgeSnapshots.map(item => item.id)); ids(result.skillRefs.map(item => item.skillId));
  const sources = result.knowledgeSnapshots.map(item => `${item.kind}:${item.sourceId}`); if (new Set(sources).size !== sources.length) fail('助手不能重复引用相同知识来源。'); return result;
}
function publicMemory(value) { const { contentMarkdown, ...meta } = value; return { ...meta, size: Buffer.byteLength(contentMarkdown) }; }
function publicSkill(value) { const { guidanceMarkdown, ...meta } = value; return { ...meta, size: Buffer.byteLength(guidanceMarkdown) }; }
function publicProfile(value) { const { instructions, knowledgeSnapshots, ...meta } = value; return { ...meta, instructionLength: [...instructions].length, knowledgeSnapshots: knowledgeSnapshots.map(({ contentMarkdown, ...item }) => ({ ...item, size: Buffer.byteLength(contentMarkdown) })) }; }
function checkRevision(item, expected) { revision(expected); if (item.revision !== expected) fail('内容已被其他窗口修改，请重新载入后再保存。'); }
module.exports = { MAX_MEMORIES, MAX_SKILLS, MAX_PROFILES, MAX_MEMORY_CODEPOINTS, MAX_MEMORY_BYTES, MAX_GUIDANCE_CODEPOINTS, MAX_GUIDANCE_BYTES, MAX_SNAPSHOT_CODEPOINTS, POLICY_REVISION, SOURCE_KINDS, hash, input, array, text, name, id, scope, revision, bump, iso, digest, ids, memoryText, provenance, memoryDocument, memory, requirements, eligibility, skillDigest, consent, skill, knowledgeSnapshot, truncateSnapshot, skillRef, profile, publicMemory, publicSkill, publicProfile, checkRevision };
