'use strict';

// Independent Windows artifact format. Source paths are logical JSON keys and
// are never converted into host filesystem paths by Store.
const crypto = require('node:crypto');
const { types } = require('node:util');
const MAX_ARTIFACT_FILES = 200;
const MAX_ARTIFACT_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_ARTIFACT_TEXT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BINARY_BYTES = 3 * 1024 * 1024;
const MAX_ARTIFACT_BUILD_BYTES = 10 * 1024 * 1024;
const MAX_ARTIFACT_DATA_VALUE_BYTES = 256 * 1024;
const MAX_ARTIFACT_DATA_BYTES = 5 * 1024 * 1024;
const MAX_ARTIFACT_DATA_KEYS = 4096;
const MAX_ARTIFACTS = 500;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bad = message => { throw new Error(message || 'Space 数据格式无效。'); };
const blockedKey = key => ['__proto__', 'prototype', 'constructor'].includes(key);
function strictRecord(value, allowed, label = 'Space') {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) bad(`${label}格式无效。`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || blockedKey(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || allowed && !allowed.includes(key)) bad(`${label}包含不支持的字段。`);
  }
  return value;
}
function validArray(value, maximum, label) {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) bad(`${label}格式或数量无效。`);
  for (let i = 0; i < value.length; i++) { const descriptor = Object.getOwnPropertyDescriptor(value, String(i)); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) bad(`${label}格式无效。`); }
  return value;
}
function text(value, maximum, label, empty = true) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (!empty && !value.trim()) || Buffer.from(value, 'utf8').toString('utf8') !== value) bad(`${label}格式或长度无效。`);
  return value;
}
function artifactId(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) bad('Space 标识符无效。'); return value; }
function revision(value, allowZero = false) { if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) bad('Space 版本无效。'); return value; }
function timestamp(value) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) bad('Space 日期无效。'); return value; }
function digest(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) bad('Space 校验值无效。'); return value; }
function artifactPath(value) {
  text(value, 512, '源码路径', false);
  if (value.startsWith('/') || /[\\:%<>"|?*\p{Cc}\p{Cf}]/u.test(value) || value !== value.normalize('NFC')) bad('源码必须使用安全的 POSIX 相对路径。');
  for (const part of value.split('/')) {
    const stem = part.split('.')[0].replace(/[. ]+$/, '');
    if (!part || part === '.' || part === '..' || part.length > 240 || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(stem)) bad('源码路径包含不安全的目录或 Windows 保留名称。');
  }
  return value;
}
function assertPaths(paths) {
  const seen = new Set();
  for (const item of paths) { const key = artifactPath(item).toLowerCase(); if (seen.has(key)) bad('源码路径重复或存在大小写冲突。'); seen.add(key); }
  // A file cannot also stand in for a directory in the virtual filesystem.
  for (const key of seen) { const parts = key.split('/'); while (parts.length > 1) { parts.pop(); if (seen.has(parts.join('/'))) bad('源码文件与目录路径冲突。'); } }
}
function fileBytes(file) { return Object.hasOwn(file, 'text') ? Buffer.from(file.text, 'utf8') : Buffer.from(file.dataBase64, 'base64'); }
function validateArtifactFiles(value) {
  validArray(value, MAX_ARTIFACT_FILES, '源码文件列表');
  let total = 0;
  const files = value.map(item => {
    strictRecord(item, ['path', 'text', 'dataBase64'], '源码文件'); const path = artifactPath(item.path);
    if (Object.hasOwn(item, 'text') === Object.hasOwn(item, 'dataBase64')) bad('源码文件必须且只能包含文本或二进制数据。');
    let result;
    if (Object.hasOwn(item, 'text')) { text(item.text, MAX_ARTIFACT_TEXT_BYTES, '源码文本'); if (Buffer.byteLength(item.text) > MAX_ARTIFACT_TEXT_BYTES) bad('单个源码文本不能超过 1 MiB。'); result = { path, text: item.text }; }
    else {
      if (typeof item.dataBase64 !== 'string' || item.dataBase64.length > 4 * Math.ceil(MAX_ARTIFACT_BINARY_BYTES / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.dataBase64)) bad('源码二进制数据无效或超过 3 MiB。');
      const bytes = Buffer.from(item.dataBase64, 'base64'); if (bytes.length > MAX_ARTIFACT_BINARY_BYTES || bytes.toString('base64') !== item.dataBase64) bad('源码二进制数据不是规范 Base64。'); result = { path, dataBase64: item.dataBase64 };
    }
    total += fileBytes(result).length; return result;
  });
  if (total > MAX_ARTIFACT_SOURCE_BYTES) bad('Space 源码总量不能超过 5 MiB。');
  assertPaths(files.map(file => file.path)); return files;
}
function sourceDigest(snapshot) { return hash(JSON.stringify({ runtime: snapshot.runtime, entryPath: snapshot.entryPath, files: [...snapshot.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => Object.hasOwn(file, 'text') ? { path: file.path, text: file.text } : { path: file.path, dataBase64: file.dataBase64 }) })); }
function pagesDigest(pages) { return hash(JSON.stringify(pages.map(({ path, html }) => ({ path, html })))); }
function validateArtifactBuild(value) {
  strictRecord(value, ['id', 'sourceRevision', 'createdAt', 'pages', 'sha256', 'sourceDigest', 'builderVersion'], 'Space 构建');
  const pages = validArray(value.pages, 20, '构建页面').map(page => { strictRecord(page, ['path', 'html'], '构建页面'); const path = artifactPath(page.path); if (!/\.html?$/i.test(path)) bad('构建页面必须是 HTML。'); text(page.html, MAX_ARTIFACT_BUILD_BYTES, '构建页面'); return { path, html: page.html }; });
  if (!pages.length || pages.reduce((total, page) => total + Buffer.byteLength(page.html), 0) > MAX_ARTIFACT_BUILD_BYTES) bad('构建页面总量不能超过 10 MiB，且至少需要一页。');
  assertPaths(pages.map(page => page.path));
  if (pagesDigest(pages) !== digest(value.sha256)) bad('构建页面校验失败。');
  return { id: artifactId(value.id), sourceRevision: revision(value.sourceRevision), createdAt: timestamp(value.createdAt), pages, sha256: value.sha256, sourceDigest: digest(value.sourceDigest), builderVersion: text(value.builderVersion, 100, '构建器版本', false) };
}
function dataKey(value, allowEmpty = false) { text(value, 256, 'Space 数据键', allowEmpty); if (/\p{Cc}|\p{Cf}/u.test(value) || blockedKey(value)) bad('Space 数据键无效。'); return value; }
function jsonValue(value) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 30000 || depth > 40) bad('Space 数据结构过深或过大。');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') return text(item, MAX_ARTIFACT_DATA_VALUE_BYTES, 'Space 数据文本');
    if (typeof item === 'number') { if (!Number.isFinite(item)) bad('Space 数据只能包含有限数字。'); return item; }
    if (Array.isArray(item)) { validArray(item, 30000, 'Space 数据数组'); return item.map(next => visit(next, depth + 1)); }
    strictRecord(item, null, 'Space 数据对象'); const output = {}; for (const key of Object.keys(item)) output[text(key, 1024, 'Space 数据字段')] = visit(item[key], depth + 1); return output;
  };
  const result = visit(value, 0); if (Buffer.byteLength(JSON.stringify(result)) > MAX_ARTIFACT_DATA_VALUE_BYTES) bad('单个 Space 数据值不能超过 256 KiB。'); return result;
}
function validateArtifactData(value) {
  strictRecord(value, ['version', 'values'], 'Space 数据'); strictRecord(value.values, null, 'Space 数据值');
  if (Object.keys(value.values).length > MAX_ARTIFACT_DATA_KEYS) bad('Space 数据键不能超过 4096 个。');
  const values = {}; for (const key of Object.keys(value.values)) values[dataKey(key)] = jsonValue(value.values[key]);
  if (Buffer.byteLength(JSON.stringify(values)) > MAX_ARTIFACT_DATA_BYTES) bad('Space 数据总量不能超过 5 MiB。');
  return { version: revision(value.version, true), values };
}
function validateArtifact(value) {
  strictRecord(value, ['id', 'name', 'workspaceId', 'createdAt', 'updatedAt', 'runtime', 'entryPath', 'sourceRevision', 'files', 'builds', 'data'], 'Space');
  if (!['html', 'react'].includes(value.runtime)) bad('Space 运行类型无效。');
  const files = validateArtifactFiles(value.files), entryPath = artifactPath(value.entryPath), entry = files.find(file => file.path === entryPath);
  if (!entry || !Object.hasOwn(entry, 'text') || (value.runtime === 'html' ? !/\.html?$/i.test(entryPath) : !/\.(?:[cm]?[jt]sx?)$/i.test(entryPath))) bad('Space 入口必须指向现有、类型匹配的文本源码。');
  const sourceRevision = revision(value.sourceRevision), builds = validArray(value.builds, 3, 'Space 构建历史').map(validateArtifactBuild);
  if (new Set(builds.map(build => build.id)).size !== builds.length || builds.some(build => build.sourceRevision > sourceRevision)) bad('Space 构建历史版本或标识符无效。');
  if (builds.some(build => build.sourceRevision === sourceRevision && build.sourceDigest !== sourceDigest({ runtime: value.runtime, entryPath, files }))) bad('Space 当前构建与源码校验值不一致。');
  if (typeof value.name === 'string' && /[\p{Cc}\p{Cf}]/u.test(value.name)) bad('Space 名称不能包含控制字符。');
  return { id: artifactId(value.id), name: text(value.name, 160, 'Space 名称', false), workspaceId: value.workspaceId === null ? null : artifactId(value.workspaceId), createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt), runtime: value.runtime, entryPath, sourceRevision, files, builds, data: validateArtifactData(value.data) };
}
function publicArtifact(value) {
  const files = value.files.map(file => { const bytes = fileBytes(file); return { path: file.path, size: bytes.length, sha256: hash(bytes), editable: Object.hasOwn(file, 'text') }; });
  return { id: value.id, name: value.name, workspaceId: value.workspaceId, createdAt: value.createdAt, updatedAt: value.updatedAt, runtime: value.runtime, entryPath: value.entryPath, sourceRevision: value.sourceRevision, sourceBytes: files.reduce((sum, file) => sum + file.size, 0), dataVersion: value.data.version, files, builds: value.builds.map(build => ({ id: build.id, sourceRevision: build.sourceRevision, createdAt: build.createdAt, sha256: build.sha256, sourceDigest: build.sourceDigest, builderVersion: build.builderVersion, pages: build.pages.map(page => ({ path: page.path, size: Buffer.byteLength(page.html), sha256: hash(page.html) })) })) };
}
function starterFiles(runtime) {
  if (runtime === 'html') return [{ path: 'index.html', text: '<!doctype html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的 Space</title><style>body{font:16px system-ui;background:#f8f7fc;color:#282439;display:grid;place-items:center;min-height:90vh}main{text-align:center;padding:48px;border-radius:24px;background:white;box-shadow:0 12px 60px #30204012}button{border:0;border-radius:12px;padding:12px 24px;background:#7560d8;color:white;font:inherit;cursor:pointer}output{display:block;font-size:56px;margin:24px}</style></head><body><main><h1>我的第一个 Space</h1><p>编辑源码，构建并预览你的应用。</p><output id="count">0</output><button id="increment">加一</button></main><script>let count=0;document.getElementById("increment").addEventListener("click",()=>{document.getElementById("count").textContent=String(++count)});</script></body></html>\n' }];
  if (runtime === 'react') return [{ path: 'src/main.tsx', text: 'import React, { useState } from "react";\nimport { createRoot } from "react-dom/client";\nimport "./style.css";\nfunction App(){const [count,setCount]=useState(0);return <main><h1>我的 React Space</h1><p>修改源码，构建并预览。</p><output>{count}</output><button onClick={()=>setCount(count+1)}>加一</button></main>;}\ncreateRoot(document.getElementById("root")!).render(<App/>);\n' }, { path: 'src/style.css', text: 'body{font:16px system-ui;background:#f8f7fc;color:#282439;display:grid;place-items:center;min-height:90vh}main{text-align:center;padding:48px;border-radius:24px;background:white;box-shadow:0 12px 60px #30204012}output{display:block;font-size:56px;margin:24px}button{border:0;border-radius:12px;padding:12px 24px;background:#7560d8;color:white;font:inherit;cursor:pointer}\n' }];
  bad('Space 运行类型无效。');
}
module.exports = { MAX_ARTIFACTS, MAX_ARTIFACT_FILES, MAX_ARTIFACT_SOURCE_BYTES, MAX_ARTIFACT_TEXT_BYTES, MAX_ARTIFACT_BINARY_BYTES, MAX_ARTIFACT_BUILD_BYTES, MAX_ARTIFACT_DATA_VALUE_BYTES, MAX_ARTIFACT_DATA_BYTES, MAX_ARTIFACT_DATA_KEYS, strictRecord, validArray, artifactId, artifactPath, assertPaths, revision, dataKey, jsonValue, fileBytes, sourceDigest, pagesDigest, validateArtifactFiles, validateArtifactBuild, validateArtifactData, validateArtifact, publicArtifact, starterFiles };
