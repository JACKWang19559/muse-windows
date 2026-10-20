'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('../backend/store.cjs');

function fixture(t) {
  const parent = path.resolve(__dirname, '..', '.test-tmp', 'speech-store'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'synthetic-speech-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent); assert.ok(path.basename(root).startsWith('synthetic-speech-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const key = crypto.randomBytes(32);
  const options = {
    encrypt(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decrypt(bytes) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    }
  };
  const dataDir = path.join(root, 'data'), store = new Store(dataDir, options);
  return { store, dataDir, root, options };
}

const initial = {
  baseUrl: 'https://chat.example/v1', model: 'chat-model', apiKey: 'synthetic-independent-chat-secret',
  speechBaseUrl: 'https://speech.example/v1', transcriptionModel: 'speech-model', speechApiKey: 'synthetic-independent-speech-secret', dictationAutoSend: true
};

test('speech credentials are encrypted independently and never included in public settings, snapshots or backups', t => {
  const { store, dataDir, options } = fixture(t); store.saveSettings(initial);
  assert.equal(store.secret(), initial.apiKey); assert.equal(store.speechSecret(), initial.speechApiKey);
  assert.equal(store.settings().hasApiKey, true); assert.equal(store.settings().hasSpeechApiKey, true);
  const disk = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'), state = JSON.parse(disk);
  assert.equal(disk.includes(initial.apiKey), false); assert.equal(disk.includes(initial.speechApiKey), false);
  assert.equal(typeof state.encryptedApiKey, 'string'); assert.equal(typeof state.encryptedSpeechApiKey, 'string');
  assert.notEqual(state.encryptedApiKey, state.encryptedSpeechApiKey);
  for (const value of [store.settings(), store.snapshot(), store.exportData()]) {
    const serialized = JSON.stringify(value);
    for (const secret of [initial.apiKey, initial.speechApiKey, state.encryptedApiKey, state.encryptedSpeechApiKey, 'encryptedApiKey', 'encryptedSpeechApiKey']) assert.equal(serialized.includes(secret), false);
  }
  const restarted = new Store(dataDir, options);
  assert.equal(restarted.secret(), initial.apiKey); assert.equal(restarted.speechSecret(), initial.speechApiKey);
  assert.equal(restarted.settings().speechBaseUrl, initial.speechBaseUrl); assert.equal(restarted.settings().transcriptionModel, initial.transcriptionModel);
});

test('saving, retaining and clearing speech credentials cannot overwrite or borrow the chat credential', t => {
  const { store } = fixture(t); store.saveSettings(initial);
  store.saveSettings({ speechApiKey: '', theme: 'dark' });
  assert.equal(store.speechSecret(), initial.speechApiKey); assert.equal(store.secret(), initial.apiKey);
  store.saveSettings({ clearSpeechApiKey: true });
  assert.equal(store.speechSecret(), ''); assert.equal(store.settings().hasSpeechApiKey, false); assert.equal(store.secret(), initial.apiKey);
  store.saveSettings({ speechApiKey: 'synthetic-replaced-speech-secret' }); store.saveSettings({ clearApiKey: true });
  assert.equal(store.secret(), ''); assert.equal(store.speechSecret(), 'synthetic-replaced-speech-secret');
  const baseline = structuredClone(store.state);
  for (const input of [{ speechApiKey: 'new-value', clearSpeechApiKey: true }, { speechApiKey: 123 }, { clearSpeechApiKey: 'true' }, { speechApiKey: 'bad\r\nkey' }]) {
    assert.throws(() => store.saveSettings(input)); assert.deepEqual(store.state, baseline);
  }
});

test('failed speech encryption rolls back settings and both credentials even if new chat encryption succeeded first', t => {
  for (const invalid of [undefined, () => { throw Error('ENCRYPTION_SYNTHETIC_SECRET'); }, () => Buffer.alloc(0), () => 'not encrypted bytes']) {
    const { store, dataDir, options } = fixture(t); store.saveSettings(initial);
    const baseline = structuredClone(store.state), disk = fs.readFileSync(path.join(dataDir, 'state.json'));
    let calls = 0;
    store.encrypt = invalid === undefined ? undefined : value => ++calls === 1 ? options.encrypt(value) : invalid(value);
    assert.throws(() => store.saveSettings({ model: 'must-not-save', transcriptionModel: 'must-not-save-asr', apiKey: 'synthetic-new-chat-key', speechApiKey: 'synthetic-new-speech-key' }), error => /加密/.test(error.message) && !error.message.includes('ENCRYPTION_SYNTHETIC_SECRET'));
    assert.deepEqual(store.state, baseline); assert.deepEqual(fs.readFileSync(path.join(dataDir, 'state.json')), disk);
    assert.equal(store.secret(), initial.apiKey); assert.equal(store.speechSecret(), initial.speechApiKey);
    assert.equal(fs.readdirSync(dataDir).some(name => name.endsWith('.tmp')), false);
  }
});

test('a failed speech decryption never returns the chat key, clears saved state or exposes the decryptor error', t => {
  const { store } = fixture(t); store.saveSettings(initial);
  const baseline = structuredClone(store.state);
  store.decrypt = () => { throw Error('DECRYPTOR_SYNTHETIC_KEY_DO_NOT_RETURN'); };
  assert.throws(() => store.speechSecret(), error => /解密/.test(error.message) && !error.message.includes('DECRYPTOR_SYNTHETIC_KEY_DO_NOT_RETURN'));
  assert.deepEqual(store.state, baseline); assert.equal(store.settings().hasSpeechApiKey, true);
  store.decrypt = undefined;
  assert.throws(() => store.speechSecret(), /解密服务不可用/); assert.deepEqual(store.state, baseline);
});

test('backup import preserves destination speech address, model and independent keys and disables auto-send', async t => {
  const { store, root, options } = fixture(t); store.saveSettings(initial); store.createChat({ title: 'source speech backup' });
  const backup = store.exportData(), destination = new Store(path.join(root, 'destination'), options);
  destination.saveSettings({ apiKey: 'synthetic-destination-chat-key', speechBaseUrl: 'http://127.0.0.1:9900/custom/v1', transcriptionModel: 'destination-asr', speechApiKey: 'synthetic-destination-speech-key', dictationAutoSend: true });
  const result = await destination.importData(backup);
  assert.equal(result.chats.length, 1); assert.equal(destination.settings().speechBaseUrl, 'http://127.0.0.1:9900/custom/v1');
  assert.equal(destination.settings().transcriptionModel, 'destination-asr'); assert.equal(destination.settings().dictationAutoSend, false);
  assert.equal(destination.secret(), 'synthetic-destination-chat-key'); assert.equal(destination.speechSecret(), 'synthetic-destination-speech-key');
  const blankDestination = new Store(path.join(root, 'blank-destination'), options);
  await blankDestination.importData(backup);
  assert.equal(blankDestination.settings().speechBaseUrl, ''); assert.equal(blankDestination.settings().transcriptionModel, '');
  assert.equal(blankDestination.settings().dictationAutoSend, false); assert.equal(blankDestination.speechSecret(), '');
});

test('old state without speech fields migrates with explicit ASR disabled and no credential or endpoint inference', t => {
  const { store, dataDir, options } = fixture(t); store.saveSettings({ baseUrl: initial.baseUrl, model: initial.model, apiKey: initial.apiKey });
  const chat = store.createChat({ title: 'legacy chat' }), oldState = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  delete oldState.settings.speechBaseUrl; delete oldState.settings.dictationAutoSend; delete oldState.encryptedSpeechApiKey;
  oldState.settings.transcriptionModel = 'legacy-transcription-hint';
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(oldState));
  const migrated = new Store(dataDir, options);
  assert.equal(migrated.settings().speechBaseUrl, ''); assert.equal(migrated.settings().transcriptionModel, 'legacy-transcription-hint');
  assert.equal(migrated.settings().dictationAutoSend, false); assert.equal(migrated.settings().hasSpeechApiKey, false); assert.equal(migrated.speechSecret(), '');
  assert.equal(migrated.secret(), initial.apiKey); assert.equal(migrated.getChat(chat.id).title, 'legacy chat');
  assert.equal(migrated.recoveryNotice, null);
  const disk = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(disk.encryptedSpeechApiKey, null); assert.equal(disk.settings.speechBaseUrl, '');
});

test('untrusted backups cannot import raw/encrypted speech secrets or invalid speech settings and remain atomic', async t => {
  const { store, dataDir } = fixture(t); store.saveSettings(initial); store.createChat({ title: 'baseline' });
  const backup = store.exportData(), baseline = structuredClone(store.state), disk = fs.readFileSync(path.join(dataDir, 'state.json'));
  for (const mutate of [
    value => { value.speechApiKey = 'synthetic-injected-secret'; },
    value => { value.encryptedSpeechApiKey = 'c3ludGhldGlj'; },
    value => { value.settings.speechApiKey = 'synthetic-injected-secret'; },
    value => { value.settings.encryptedSpeechApiKey = 'c3ludGhldGlj'; },
    value => { value.settings.speechBaseUrl = 'https://shortwave.meta.ai'; },
    value => { value.settings.dictationAutoSend = 'true'; }
  ]) {
    const changed = structuredClone(backup); mutate(changed);
    await assert.rejects(store.importData(changed));
    assert.deepEqual(store.state, baseline); assert.deepEqual(fs.readFileSync(path.join(dataDir, 'state.json')), disk);
  }
});
