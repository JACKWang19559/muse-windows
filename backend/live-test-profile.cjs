'use strict';

const fs = require('node:fs');
const path = require('node:path');
const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

function assertLiveTestProfile(root, dataDirectory, explicitlySelected) {
  const expected = path.resolve(root, '.test-tmp', 'live-provider-user');
  if (!explicitlySelected || !same(path.resolve(dataDirectory), expected)) throw new Error('真实模型验收仅允许显式选择独立的 .test-tmp/live-provider-user 目录，请使用 npm run test:live。');
  const parent = path.dirname(expected);
  for (const directory of [parent, expected]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('真实模型验收目录不能是链接或重定向目录。');
  }
  const canonicalExpected = path.join(fs.realpathSync(root), '.test-tmp', 'live-provider-user');
  if (!same(fs.realpathSync(expected), canonicalExpected)) throw new Error('真实模型验收目录超出了项目的独立测试目录。');
  return { directory: expected, fixtureOnly: true };
}
module.exports = { assertLiveTestProfile };
