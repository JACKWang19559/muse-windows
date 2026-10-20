'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertLiveTestProfile } = require('../backend/live-test-profile.cjs');

test('real provider test rejects default/foreign profiles before credentials can be read', t => {
  const parent = path.resolve(__dirname, '.tmp'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'live-profile-'));
  const profile = path.join(root, '.test-tmp', 'live-provider-user');
  fs.mkdirSync(profile, { recursive: true });
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  assert.throws(() => assertLiveTestProfile(root, root, true), /独立/);
  assert.throws(() => assertLiveTestProfile(root, profile, false), /显式/);
  assert.throws(() => assertLiveTestProfile(root, path.join(root, 'other-user-data'), true), /独立/);
  assert.equal(assertLiveTestProfile(root, profile, true).fixtureOnly, true);
});

test('real provider test refuses a redirected profile', t => {
  const parent = path.resolve(__dirname, '.tmp'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'live-link-'));
  const target = path.join(root, 'other-data'), profile = path.join(root, '.test-tmp', 'live-provider-user');
  fs.mkdirSync(target); fs.mkdirSync(path.dirname(profile));
  fs.symlinkSync(target, profile, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  assert.throws(() => assertLiveTestProfile(root, profile, true), /链接|重定向|超出/);
});
