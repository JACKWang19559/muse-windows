'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../backend/store.cjs');
const model = require('../backend/knowledge-model.cjs');
const { parseSkillPackage } = require('../backend/skill-package.cjs');
const { rebuildMemoryIndex, memorySourceDigest, searchMemories, indexHash } = require('../backend/knowledge-search.cjs');
const NOW = '2026-10-20T00:00:00.000Z';
function fixture(t) {
  const parent = path.resolve(__dirname, '.tmp'); fs.mkdirSync(parent, { recursive: true }); const root = fs.mkdtempSync(path.join(parent, 'knowledge-store-')), dataDir = path.join(root, 'data');
  t.after(() => { assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^knowledge-store-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, store: new Store(dataDir) };
}
const memory = (store, input = {}) => store.createMemory({ name: '测试知识', contentMarkdown: '离线合成资料：晨星代号', ...input });
const doc = (store, input = {}) => store.saveMemoryDocument({ expectedRevision: 0, contentMarkdown: '独立的 MEMORY 正文', ...input });
const skill = (store, input = {}) => store.createSkill({ ...parseSkillPackage('---\nname: 合成技能\ndescription: 只提供指导\nversion: 1.0\ntoolRequirements: ["workspace_read_file"]\n---\n先核对事实，再回答。'), ...input });
const approve = (store, item) => store.setSkillConsent({ id: item.id, expectedRevision: item.revision, approved: true, policyRevision: 1 });
const profile = (store, input = {}) => store.createAgentProfile({ name: '测试助手', instructions: '请引用资料来源。', ...input });
const capture = (store, item, kind, sourceId) => store.captureProfileKnowledge({ id: item.id, expectedRevision: item.revision, kind, sourceId });
const review = (store, item) => store.reviewAgentProfile({ id: item.id, expectedRevision: item.revision });
function rebuild(store, workspaceId = null) {
  const records = store.snapshot().memories.map(item => store.getMemory(item.id)), old = store.getMemoryIndex({ workspaceId }), index = rebuildMemoryIndex(records, { workspaceId, revision: (old?.revision || 0) + 1, builtAt: NOW });
  return store.commitMemoryIndex({ workspaceId, expectedRevision: old?.revision || 0, sourceDigest: memorySourceDigest(records, workspaceId), index });
}
function recoveryCopies(store) { return [store.statePath, store.backupPath].map(filename => fs.readFileSync(filename, 'utf8')); }

test('old schema-v1 state and backups remain compatible without knowledge fields', async t => {
  const { store, dataDir } = fixture(t); store.createChat({ title: '旧对话' }); const state = JSON.parse(fs.readFileSync(store.statePath, 'utf8'));
  const keys = ['memoryDocuments','memories','skills','agentProfiles','memoryIndexes']; for (const key of keys) delete state[key]; fs.writeFileSync(store.statePath, JSON.stringify(state));
  const restored = new Store(dataDir); for (const key of keys) assert.deepEqual(restored.snapshot()[key], []);
  const backup = restored.exportData(); for (const key of keys) delete backup[key]; await restored.importData(backup); assert.equal(restored.snapshot().chats.length, 2);
});

test('MEMORY.md is unique per exact scope and uses revision CAS without populating the memory index', t => {
  const { store, dataDir } = fixture(t), workspace = store.createWorkspace({ name: '文档范围' }), global = doc(store), scoped = doc(store, { workspaceId: workspace.id, contentMarkdown: '范围文档' });
  assert.notEqual(global.id, scoped.id); assert.equal(store.getMemoryDocument().id, global.id); assert.equal(store.getMemoryDocument({ workspaceId: workspace.id }).id, scoped.id);
  assert.equal(store.getMemoryIndex(), null); assert.deepEqual(store.snapshot().memories, []); assert.throws(() => doc(store), /变化/);
  const next = store.saveMemoryDocument({ expectedRevision: 1, contentMarkdown: '明确修改' }); assert.equal(next.id, global.id); assert.equal(next.revision, 2); assert.equal(next.digest, model.hash('明确修改'));
  assert.throws(() => store.saveMemoryDocument({ expectedRevision: 1, contentMarkdown: '旧窗口' }), /变化/); assert.equal(new Store(dataDir).getMemoryDocument().contentMarkdown, '明确修改');
});

test('memory records bound Unicode and bytes, reject unsafe JSON and expose detached metadata only', t => {
  const { store } = fixture(t), item = memory(store, { contentMarkdown: '😀'.repeat(200000) }); assert.equal([...item.contentMarkdown].length, 200000);
  const before = store.snapshot(); for (const contentMarkdown of ['😀'.repeat(200001), '\uD800', 'bad\0text']) assert.throws(() => memory(store, { contentMarkdown }));
  for (const input of [{ name: 'bad\nname' }, { workspaceId: 'missing' }, { apiKey: 'synthetic-undeclared' }]) assert.throws(() => memory(store, input));
  assert.deepEqual(store.snapshot(), before); const meta = before.memories[0]; assert.equal(Object.hasOwn(meta, 'contentMarkdown'), false); assert.equal(meta.size, 800000);
  item.contentMarkdown = 'observer mutation'; assert.notEqual(store.getMemory(item.id).contentMarkdown, item.contentMarkdown);
  const next = store.updateMemory({ id: item.id, expectedRevision: 1, name: '改名', contentMarkdown: '新的正文' }); assert.equal(next.revision, 2); assert.equal(next.digest, model.hash('新的正文')); assert.throws(() => store.updateMemory({ id: item.id, expectedRevision: 1, contentMarkdown: 'stale' }), /重新载入/);
  const getter = {}; Object.defineProperty(getter, 'name', { enumerable: true, get() { throw new Error('must not execute'); } }); assert.throws(() => store.createMemory(getter), /不支持/);
});

test('index commits compare both index revision and the real source digest; source updates only make indexes stale', t => {
  const { store } = fixture(t), first = memory(store), second = memory(store, { name: '第二条', contentMarkdown: '星云知识' }); const index = rebuild(store);
  assert.equal(index.status, 'ready'); assert.equal(searchMemories([first, second], index, { query: '晨星' }).hits[0].id, first.id); assert.equal(Object.hasOwn(store.snapshot().memoryIndexes[0], 'postings'), false);
  const staleBuild = rebuildMemoryIndex([first, second], { revision: 2, builtAt: NOW }); store.updateMemory({ id: first.id, expectedRevision: 1, contentMarkdown: '源已变化' });
  assert.equal(store.snapshot().memoryIndexes[0].status, 'stale'); assert.throws(() => store.commitMemoryIndex({ expectedRevision: 1, sourceDigest: index.sourceDigest, index: staleBuild }), /来源已变化/);
  const fresh = rebuild(store); assert.equal(fresh.revision, 2); assert.throws(() => store.commitMemoryIndex({ expectedRevision: 1, sourceDigest: fresh.sourceDigest, index: fresh }), /索引已变化/);
  store.deleteMemory({ id: second.id, expectedRevision: 1 }); assert.equal(store.getMemoryIndex(), null); for (const value of recoveryCopies(store)) assert.equal(value.includes('星云知识'), false);
});

test('index validation rejects forged relations even when the supplied index hash is internally consistent', t => {
  const { store } = fixture(t), item = memory(store), other = store.createWorkspace({ name: '其他范围' }), foreign = memory(store, { workspaceId: other.id });
  const records = [item, foreign], index = rebuildMemoryIndex(records, { revision: 1, builtAt: NOW }); index.documents[0].id = foreign.id; for (const term of index.postings) for (const posting of term.documents) posting.id = foreign.id; index.indexDigest = indexHash(index);
  assert.throws(() => store.commitMemoryIndex({ expectedRevision: 0, sourceDigest: memorySourceDigest(records), index }), /索引引用/); assert.equal(store.getMemoryIndex(), null);
});

test('a failed index can be explicitly replaced by a ready build without retaining its error marker', t => {
  const { store } = fixture(t), item = memory(store), sourceDigest = memorySourceDigest([item]), failed = { schemaVersion: 1, workspaceId: null, revision: 1, status: 'failed', sourceDigest, builtAt: NOW, documents: [], postings: [], errorCode: 'build_failed' }; failed.indexDigest = indexHash(failed);
  store.commitMemoryIndex({ expectedRevision: 0, sourceDigest, index: failed }); assert.equal(store.getMemoryIndex().status, 'failed');
  const ready = rebuild(store); assert.equal(ready.revision, 2); assert.equal(ready.status, 'ready'); assert.equal(Object.hasOwn(ready, 'errorCode'), false); assert.equal(store.snapshot().memoryIndexes[0].status, 'ready');
});

test('skills use the package digest and consent is bound to content, version, requirements and exact scope', t => {
  const { store } = fixture(t), original = skill(store); assert.equal(original.enabled, false); assert.equal(original.eligible, true); assert.equal(original.consents.length, 0);
  const approved = approve(store, original); assert.equal(approved.enabled, true); assert.equal(approved.consents[0].digest, approved.digest); assert.equal(approved.consents[0].policyRevision, 1);
  const publicSkill = store.snapshot().skills[0]; assert.equal(Object.hasOwn(publicSkill, 'guidanceMarkdown'), false); publicSkill.consents[0].digest = 'observer'; assert.notEqual(store.getSkill(original.id).consents[0].digest, 'observer');
  const changed = store.updateSkill({ id: original.id, expectedRevision: approved.revision, guidanceMarkdown: '新版指导' }); assert.notEqual(changed.digest, approved.digest); assert.equal(changed.enabled, false); assert.deepEqual(changed.consents, []);
  assert.throws(() => store.updateSkill({ id: original.id, expectedRevision: changed.revision, enabled: true }), /明确批准/);
  const unknown = skill(store, { name: '未知能力', toolRequirements: ['unknown_local_command'], digest: undefined, eligible: undefined, ineligibleReasons: undefined }); assert.equal(unknown.eligible, false); assert.throws(() => approve(store, unknown), /不支持/);
  assert.throws(() => skill(store, { guidanceMarkdown: 'x'.repeat(102401), digest: undefined }), /100 KiB|校验|过长/);
});

test('profiles require explicit review, same-scope live memory and consent; selecting a profile does not grant tools', t => {
  const { store } = fixture(t), workspace = store.createWorkspace({ name: '助手范围' }), globalDoc = doc(store), scopedDoc = doc(store, { workspaceId: workspace.id }), approved = approve(store, skill(store, { workspaceId: workspace.id }));
  assert.throws(() => profile(store, { workspaceId: workspace.id, memoryDocumentIds: [globalDoc.id] }), /同范围/);
  let selected = profile(store, { workspaceId: workspace.id, memoryDocumentIds: [scopedDoc.id], toolPolicy: 'workspace', skillRefs: [{ skillId: approved.id, digest: approved.digest, consentId: approved.consents[0].id }] });
  assert.equal(selected.needsReview, true); assert.throws(() => store.createChat({ workspaceId: workspace.id, profileId: selected.id }), /先确认/); selected = review(store, selected);
  const chat = store.createChat({ workspaceId: workspace.id, profileId: selected.id }); assert.equal(chat.profileId, selected.id); assert.equal(chat.messages.length, 0); assert.equal(selected.toolPolicy, 'workspace');
  assert.throws(() => store.createChat({ profileId: selected.id }), /同一范围/); const moved = store.updateChat({ id: chat.id, workspaceId: null }); assert.equal(Object.hasOwn(moved, 'profileId'), false);
  const meta = store.snapshot().agentProfiles[0]; assert.equal(Object.hasOwn(meta, 'instructions'), false); assert.equal(meta.memoryDocumentIds[0], scopedDoc.id);
  selected = store.updateAgentProfile({ id: selected.id, expectedRevision: selected.revision, instructions: '用户新指导' }); assert.equal(selected.needsReview, true); assert.throws(() => store.updateAgentProfile({ id: selected.id, expectedRevision: selected.revision, instructions: '😀'.repeat(50001) }));
});

test('captured knowledge is immutable until explicit refresh, with exact Unicode truncation and two independent hashes', t => {
  const { store } = fixture(t), item = memory(store, { contentMarkdown: '😀'.repeat(9000) }); let selected = capture(store, profile(store), 'memory', item.id); const snapshot = structuredClone(selected.knowledgeSnapshots[0]);
  assert.equal([...snapshot.contentMarkdown].length, 8192); assert.match(snapshot.contentMarkdown, /\[truncated\]$/); assert.equal(snapshot.truncated, true); assert.equal(snapshot.contentDigest, model.hash(snapshot.contentMarkdown)); assert.equal(snapshot.sourceDigest, item.digest); assert.notEqual(snapshot.contentDigest, snapshot.sourceDigest);
  store.updateMemory({ id: item.id, expectedRevision: 1, contentMarkdown: '更改来源不刷新已存快照' }); assert.deepEqual(store.getAgentProfile(selected.id).knowledgeSnapshots[0], snapshot);
  assert.equal(Object.hasOwn(store.snapshot().agentProfiles[0].knowledgeSnapshots[0], 'contentMarkdown'), false); selected = store.refreshProfileKnowledge({ id: selected.id, expectedRevision: selected.revision, snapshotId: snapshot.id }); assert.equal(selected.knowledgeSnapshots[0].contentMarkdown, '更改来源不刷新已存快照'); assert.equal(selected.knowledgeSnapshots[0].id, snapshot.id);
  assert.throws(() => capture(store, selected, 'memory', item.id), /已存在/); const foreign = store.createWorkspace({ name: '别处' }), other = memory(store, { workspaceId: foreign.id }); assert.throws(() => capture(store, selected, 'memory', other.id), /同一范围/);
});

test('file, chat and application capture reads managed source without accepting forged snapshot bodies', async t => {
  const { store } = fixture(t), { file } = await store.createTextFile({ name: 'source.md', content: '管理副本内容' }), chat = store.createChat({ title: '源对话' }), artifact = store.createArtifact({ name: '源应用', runtime: 'html' });
  store.appendMessage(chat.id, { role: 'user', content: '保留的合成用户正文' }); store.appendMessage(chat.id, { role: 'assistant', content: '确定的答复' }); let selected = profile(store);
  for (const [kind, id] of [['file',file.id],['chat',chat.id],['artifact',artifact.id]]) selected = capture(store, selected, kind, id);
  assert.equal(selected.knowledgeSnapshots.length, 3); assert.equal(selected.knowledgeSnapshots[0].sourceDigest, store.readFile(file.id).sha256); assert.match(selected.knowledgeSnapshots[1].contentMarkdown, /确定的答复/); assert.match(selected.knowledgeSnapshots[2].contentMarkdown, /index.html/);
  assert.throws(() => store.captureProfileKnowledge({ id: selected.id, expectedRevision: selected.revision, kind: 'file', sourceId: file.id, contentMarkdown: 'forged' }), /不支持/);
  const streaming = store.createChat(); store.appendMessage(streaming.id, { role: 'assistant', content: '尚未稳定', status: 'streaming' }); assert.throws(() => capture(store, selected, 'chat', streaming.id), /生成结束/);
});

test('source deletion removes dependent knowledge, snapshots and index terms from current and recovery state', t => {
  const { store } = fixture(t), base = memory(store, { contentMarkdown: 'PRIVATE-SYNTHETIC-SOURCE-COPY' }), derived = memory(store, { contentMarkdown: 'PRIVATE-SYNTHETIC-DERIVED-COPY', provenance: { kind: 'memory', sourceId: base.id, capturedAt: NOW } }); let selected = profile(store); selected = capture(store, selected, 'memory', base.id); selected = capture(store, selected, 'memory', derived.id); selected = review(store, selected); rebuild(store);
  store.deleteMemory({ id: base.id, expectedRevision: 1 }); assert.equal(store.snapshot().memories.length, 0); assert.equal(store.getMemoryIndex(), null); const after = store.getAgentProfile(selected.id); assert.equal(after.knowledgeSnapshots.length, 0); assert.equal(after.needsReview, true); assert.ok(after.revision > selected.revision);
  for (const value of recoveryCopies(store)) { assert.equal(value.includes('PRIVATE-SYNTHETIC-SOURCE-COPY'), false); assert.equal(value.includes('PRIVATE-SYNTHETIC-DERIVED-COPY'), false); }
});

test('provenance captures real source identity, rejects cycles, and profiles bound snapshot counts and clean chat bindings', t => {
  const { store } = fixture(t), base = memory(store), derived = memory(store, { provenance: { kind: 'memory', sourceId: base.id, sourceDigest: '0'.repeat(64), sourceRevision: 999, capturedAt: NOW } });
  assert.equal(derived.provenance.sourceDigest, base.digest); assert.equal(derived.provenance.sourceRevision, base.revision); assert.throws(() => store.updateMemory({ id: base.id, expectedRevision: 1, provenance: { kind: 'memory', sourceId: derived.id, capturedAt: NOW } }), /循环/);
  let selected = profile(store); for (let index = 0; index < 50; index++) selected = capture(store, selected, 'memory', memory(store, { name: `项目 ${index}` }).id);
  const overflow = memory(store); assert.throws(() => capture(store, selected, 'memory', overflow.id), /50/); selected = review(store, selected); const chat = store.createChat({ profileId: selected.id });
  store.deleteAgentProfile({ id: selected.id, expectedRevision: selected.revision }); assert.equal(Object.hasOwn(store.getChat(chat.id), 'profileId'), false); assert.equal(store.snapshot().agentProfiles.length, 0);
});

test('document, file, message and application deletions clean their captured copies and preserve unrelated records', async t => {
  const { store } = fixture(t), root = doc(store), { file } = await store.createTextFile({ name: 'delete.md', content: 'DELETE-FILE-FIXTURE' }), chat = store.createChat(), message = store.appendMessage(chat.id, { role: 'user', content: 'DELETE-MESSAGE-FIXTURE' }), app = store.createArtifact({ name: 'delete app', runtime: 'html' }); let selected = profile(store, { memoryDocumentIds: [root.id] });
  for (const [kind, id] of [['memory_document',root.id],['file',file.id],['chat',chat.id],['artifact',app.id]]) selected = capture(store, selected, kind, id);
  const survivor = memory(store); store.deleteTurn({ chatId: chat.id, messageId: message.id }); assert.equal(store.getAgentProfile(selected.id).knowledgeSnapshots.some(item => item.kind === 'chat'), false);
  store.removeFile(file.id); store.deleteArtifact(app.id); store.deleteMemoryDocument({ id: root.id, expectedRevision: root.revision }); const after = store.getAgentProfile(selected.id); assert.deepEqual(after.knowledgeSnapshots, []); assert.deepEqual(after.memoryDocumentIds, []); assert.equal(store.getMemory(survivor.id).id, survivor.id);
  for (const value of recoveryCopies(store)) assert.equal(value.includes('DELETE-MESSAGE-FIXTURE') || value.includes('DELETE-FILE-FIXTURE'), false);
});

test('skill revocation and deletion invalidate profile review and scrub guidance from automatic backups', t => {
  const { store } = fixture(t); let guide = approve(store, skill(store, { guidanceMarkdown: 'SYNTHETIC-GUIDANCE-TO-DELETE', digest: undefined })), selected = profile(store, { skillRefs: [{ skillId: guide.id, digest: guide.digest, consentId: guide.consents[0].id }] }); selected = review(store, selected);
  guide = store.setSkillConsent({ id: guide.id, expectedRevision: guide.revision, approved: false, policyRevision: 1 }); assert.equal(store.getAgentProfile(selected.id).needsReview, true); assert.throws(() => review(store, store.getAgentProfile(selected.id)), /重新批准/);
  store.deleteSkill({ id: guide.id, expectedRevision: guide.revision }); assert.deepEqual(store.getAgentProfile(selected.id).skillRefs, []); for (const value of recoveryCopies(store)) assert.equal(value.includes('SYNTHETIC-GUIDANCE-TO-DELETE'), false);
});

test('workspace deletion deletes scoped knowledge instead of promoting it into global memory', t => {
  const { store } = fixture(t), global = memory(store), workspace = store.createWorkspace({ name: '删除范围' }), scoped = memory(store, { workspaceId: workspace.id, contentMarkdown: 'PRIVATE-WORKSPACE-KNOWLEDGE' }), root = doc(store, { workspaceId: workspace.id }), guide = skill(store, { workspaceId: workspace.id }); let selected = capture(store, profile(store, { workspaceId: workspace.id, memoryDocumentIds: [root.id] }), 'memory', scoped.id); selected = review(store, selected); const chat = store.createChat({ workspaceId: workspace.id, profileId: selected.id }); rebuild(store, workspace.id);
  store.deleteWorkspace(workspace.id); assert.deepEqual(store.snapshot().memories.map(item => item.id), [global.id]); assert.deepEqual(store.snapshot().memoryDocuments, []); assert.deepEqual(store.snapshot().skills, []); assert.deepEqual(store.snapshot().agentProfiles, []); assert.deepEqual(store.snapshot().memoryIndexes, []); assert.equal(Object.hasOwn(store.getChat(chat.id), 'profileId'), false); assert.throws(() => store.getSkill(guide.id)); for (const value of recoveryCopies(store)) assert.equal(value.includes('PRIVATE-WORKSPACE-KNOWLEDGE'), false);
});

test('backup roundtrip remaps knowledge/source/profile/index relations and revokes all imported skill consents', async t => {
  const { store } = fixture(t), destination = fixture(t).store, workspace = store.createWorkspace({ name: '备份范围' }), root = doc(store, { workspaceId: workspace.id }), item = memory(store, { workspaceId: workspace.id, provenance: { kind: 'memory_document', sourceId: root.id, capturedAt: NOW } }), guide = approve(store, skill(store, { workspaceId: workspace.id })); let selected = capture(store, profile(store, { workspaceId: workspace.id, memoryDocumentIds: [root.id], skillRefs: [{ skillId: guide.id, digest: guide.digest, consentId: guide.consents[0].id }] }), 'memory', item.id); selected = review(store, selected); store.createChat({ workspaceId: workspace.id, profileId: selected.id }); rebuild(store, workspace.id);
  const backup = store.exportData(); await destination.importData(backup); const imported = destination.snapshot(), next = destination.getAgentProfile(imported.agentProfiles[0].id), copied = destination.getMemory(imported.memories[0].id), newDoc = destination.getMemoryDocument({ workspaceId: imported.workspaces[0].id });
  assert.notEqual(next.id, selected.id); assert.notEqual(copied.id, item.id); assert.notEqual(next.knowledgeSnapshots[0].id, selected.knowledgeSnapshots[0].id); assert.equal(next.knowledgeSnapshots[0].sourceId, copied.id); assert.equal(next.knowledgeSnapshots[0].contentDigest, selected.knowledgeSnapshots[0].contentDigest); assert.equal(copied.provenance.sourceId, newDoc.id); assert.deepEqual(next.memoryDocumentIds, [newDoc.id]); assert.equal(next.needsReview, true); assert.equal(next.skillRefs[0].consentId, null);
  assert.equal(imported.chats[0].profileId, next.id); assert.equal(imported.skills[0].enabled, false); assert.deepEqual(imported.skills[0].consents, []); assert.throws(() => destination.updateChat({ id: imported.chats[0].id, profileId: next.id }), /先确认/); assert.throws(() => review(destination, next), /重新批准/);
  const index = destination.getMemoryIndex({ workspaceId: imported.workspaces[0].id }); assert.equal(index.status, 'ready'); assert.equal(index.documents[0].id, copied.id); assert.equal(searchMemories([copied], index, { workspaceId: copied.workspaceId, query: '晨星' }).hits[0].id, copied.id); assert.equal(store.getSkill(guide.id).enabled, true);
});

test('global MEMORY conflicts fail atomically, while identical content reuses the local document identity', async t => {
  const source = fixture(t).store, target = fixture(t).store, original = doc(source), existing = doc(target); let selected = capture(source, profile(source, { memoryDocumentIds: [original.id] }), 'memory_document', original.id); selected = review(source, selected); memory(source);
  await target.importData(source.exportData()); assert.equal(target.snapshot().memoryDocuments.length, 1); const importedProfile = target.getAgentProfile(target.snapshot().agentProfiles[0].id); assert.deepEqual(importedProfile.memoryDocumentIds, [existing.id]); assert.equal(importedProfile.knowledgeSnapshots[0].sourceId, existing.id); assert.equal(importedProfile.needsReview, true);
  source.saveMemoryDocument({ expectedRevision: original.revision, contentMarkdown: '不同的全局长期记忆' }); await source.createTextFile({ name: 'source.txt', content: 'atomic attachment' }); const before = target.exportData(), files = fs.readdirSync(target.attachmentsDir);
  await assert.rejects(() => target.importData(source.exportData()), /全局长期记忆.*冲突/); assert.deepEqual(target.exportData().memories, before.memories); assert.deepEqual(fs.readdirSync(target.attachmentsDir), files); assert.equal(target.getMemoryDocument().id, existing.id);
});

test('reusing an identical global document maps historical source revisions to its local identity without discarding the snapshot body', async t => {
  const source = fixture(t).store, target = fixture(t).store; let original = doc(source, { contentMarkdown: 'same global content' }); original = source.saveMemoryDocument({ expectedRevision: original.revision, contentMarkdown: original.contentMarkdown }); const local = doc(target, { contentMarkdown: original.contentMarkdown });
  const item = memory(source, { provenance: { kind: 'memory_document', sourceId: original.id, capturedAt: NOW } }); let selected = capture(source, profile(source, { memoryDocumentIds: [original.id] }), 'memory_document', original.id); selected = review(source, selected);
  await target.importData(source.exportData()); const next = target.getAgentProfile(target.snapshot().agentProfiles[0].id), imported = target.getMemory(target.snapshot().memories[0].id);
  assert.equal(next.knowledgeSnapshots[0].sourceId, local.id); assert.equal(next.knowledgeSnapshots[0].sourceRevision, local.revision); assert.equal(next.knowledgeSnapshots[0].contentMarkdown, original.contentMarkdown); assert.equal(imported.provenance.sourceRevision, local.revision); assert.notEqual(imported.id, item.id);
});

test('backup validation rejects body/hash corruption, dangling/cross-scope refs and injected fields before writes', async t => {
  const { store } = fixture(t), target = fixture(t).store, workspace = store.createWorkspace({ name: 'valid source' }), root = doc(store, { workspaceId: workspace.id }), item = memory(store, { workspaceId: workspace.id }), guide = approve(store, skill(store, { workspaceId: workspace.id })); let selected = capture(store, profile(store, { workspaceId: workspace.id, memoryDocumentIds: [root.id], skillRefs: [{ skillId: guide.id, digest: guide.digest, consentId: guide.consents[0].id }] }), 'memory', item.id); selected = review(store, selected); rebuild(store, workspace.id); const valid = store.exportData(), before = target.snapshot();
  for (const mutate of [data => { data.memories[0].contentMarkdown = 'forged'; }, data => { data.memories[0].apiKey = 'synthetic'; }, data => { data.memoryDocuments[0].path = '../MEMORY.md'; }, data => { data.agentProfiles[0].memoryDocumentIds = ['missing']; }, data => { data.agentProfiles[0].knowledgeSnapshots[0].sourceRevision = 999; }, data => { data.agentProfiles[0].knowledgeSnapshots[0].contentMarkdown = 'forged'; }, data => { data.agentProfiles[0].workspaceId = null; }, data => { data.skills[0].consents[0].digest = '0'.repeat(64); }, data => { data.skills[0].guidanceMarkdown = 'tampered'; }, data => { data.memoryIndexes[0].indexDigest = '0'.repeat(64); }, data => { data.agentProfiles[0].toolPolicy = 'all'; }]) { const bad = structuredClone(valid); mutate(bad); await assert.rejects(() => target.importData(bad)); assert.deepEqual(target.snapshot(), before); assert.deepEqual(fs.readdirSync(target.attachmentsDir), []); }
});

test('knowledge CAS and persistence failure do not commit partial records or leave imported attachments behind', async t => {
  const { store } = fixture(t), item = memory(store), before = store.snapshot(), persist = store._persistState; store._persistState = () => { throw new Error('synthetic storage failure'); };
  try { assert.throws(() => store.updateMemory({ id: item.id, expectedRevision: 1, contentMarkdown: 'not committed' })); assert.throws(() => store.deleteMemory({ id: item.id, expectedRevision: 1 })); assert.throws(() => doc(store)); assert.deepEqual(store.snapshot(), before); } finally { store._persistState = persist; }
  const source = fixture(t).store; memory(source); await source.createTextFile({ name: 'import.txt', content: 'synthetic attachment' }); store._persistState = () => { throw new Error('synthetic import commit failure'); };
  try { await assert.rejects(() => store.importData(source.exportData())); assert.deepEqual(store.snapshot(), before); assert.deepEqual(fs.readdirSync(store.attachmentsDir), []); } finally { store._persistState = persist; }
});

test('automatic recovery-copy failure honestly rejects knowledge deletion without changing memory or primary data', t => {
  const { store } = fixture(t), item = memory(store), original = store._writeSynced, before = fs.readFileSync(store.statePath, 'utf8');
  store._writeSynced = function(filename, ...args) { if (path.basename(filename).startsWith('.backup-')) throw Object.assign(new Error('synthetic backup failure'), { code: 'EACCES' }); return original.call(this, filename, ...args); };
  try { assert.throws(() => store.deleteMemory({ id: item.id, expectedRevision: item.revision }), /无法保存/); assert.equal(store.getMemory(item.id).contentMarkdown, item.contentMarkdown); assert.equal(fs.readFileSync(store.statePath, 'utf8'), before); } finally { store._writeSynced = original; }
});
