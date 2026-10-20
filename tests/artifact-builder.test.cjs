'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildArtifact } = require('../backend/artifact-builder.cjs');
const { sourceDigest, pagesDigest, validateArtifactBuild, starterFiles } = require('../backend/artifact-model.cjs');
const text = (path, value) => ({ path, text: value });
const binary = (path, value) => ({ path, dataBase64: Buffer.from(value).toString('base64') });
const snapshot = (files, changes = {}) => ({ id: 'artifact_fixture', runtime: 'html', entryPath: 'index.html', sourceRevision: 1, files, ...changes });
const parse = async html => (await import('parse5')).parse(html);
function nodes(document, tagName) {
  const result = [];
  const walk = node => { if (node.tagName === tagName) result.push(node); for (const child of node.childNodes || []) walk(child); if (node.content) walk(node.content); };
  walk(document); return result;
}
const content = node => node.childNodes.map(child => child.value || '').join('');
const attribute = (node, name) => node.attrs.find(item => item.name === name)?.value;

test('HTML is parsed, normalized and self contained while classic scripts retain shared globals', async () => {
  const input = snapshot([
    text('index.html', '<!doctype html><TITLE>离线</TITLE><script src="./first.js"></script><main data-label="a>b"><img src="./picture.png"><script>globalThis.answer=first+1;</script>'),
    text('first.js', 'var first=41;'), binary('picture.png', [137, 80, 78, 71])
  ]);
  const build = await buildArtifact(input), document = await parse(build.pages[0].html);
  assert.equal(build.pages[0].path, 'index.html');
  assert.equal(attribute(nodes(document, 'main')[0], 'data-label'), 'a>b');
  assert.equal(attribute(nodes(document, 'img')[0], 'src'), 'data:image/png;base64,iVBORw==');
  const context = vm.createContext({});
  for (const script of nodes(document, 'script')) { assert.equal(attribute(script, 'src'), undefined); new vm.Script(content(script)).runInContext(context); }
  assert.equal(context.first, 41); assert.equal(context.answer, 42);
  assert.equal(build.sourceDigest, sourceDigest(input)); assert.equal(build.sha256, pagesDigest(build.pages));
  assert.equal(build.builderVersion, '1'); assert.equal(build.sourceRevision, 1);
  assert.deepEqual(validateArtifactBuild(build), build);
});

test('CSS imports, CSS url assets, style attributes and srcset use virtual relative paths', async () => {
  const build = await buildArtifact(snapshot([
    text('pages/index.html', '<link rel="stylesheet" href="../styles/site.css"><style>.logo{background:url(../images/p.png)}</style><div style="background:url(../images/p.png)"></div><img srcset="../images/p.png 1x, ../images/p2.png 2x">'),
    text('styles/site.css', '@import "base.css"; @font-face{font-family:Fixture;src:url(../fonts/f.woff2)}'),
    text('styles/base.css', '.base{color:rebeccapurple}'), binary('images/p.png', 'one'), binary('images/p2.png', 'two'), binary('fonts/f.woff2', 'font')
  ], { entryPath: 'pages/index.html' }));
  const document = await parse(build.pages[0].html), styles = nodes(document, 'style').map(content).join('');
  assert.equal(nodes(document, 'link').length, 0); assert.match(styles, /\.base/); assert.doesNotMatch(styles, /@import|\.\.\/|base\.css/);
  assert.match(styles, /data:/); assert.match(attribute(nodes(document, 'div')[0], 'style'), /data:/);
  assert.match(attribute(nodes(document, 'img')[0], 'srcset'), /data:image\/png;base64,b25l 1x, data:image\/png;base64,dHdv 2x/);
});

test('module graphs bundle extensionless imports, assets and CSS into an IIFE after the document body', async () => {
  const build = await buildArtifact(snapshot([
    text('index.html', '<head><script type="module" src="/src/main.ts"></script></head><body><div id="ready"></div></body>'),
    text('src/main.ts', 'import {value} from "./value";import icon from "./icon.svg";import "./style.css";globalThis.moduleResult=value+icon;'),
    text('src/value.ts', 'export const value:number=42;'), text('src/style.css', 'body{color:navy}'), text('src/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
  ]));
  const document = await parse(build.pages[0].html), script = nodes(document, 'script')[0];
  assert.equal(script.parentNode.tagName, 'body'); assert.equal(attribute(script, 'type'), undefined);
  assert.equal(nodes(document, 'style').length, 1); assert.doesNotMatch(content(script), /\bimport\s|\bexport\s/);
  const context = vm.createContext({}); new vm.Script(content(script)).runInContext(context);
  assert.match(context.moduleResult, /^42data:image\/svg\+xml/);
});

test('inline modules resolve from their HTML directory and deferred classic scripts run after inline body scripts', async () => {
  const build = await buildArtifact(snapshot([
    text('pages/index.html', '<head><script src="../deferred.js" defer></script><script type="module">import {word} from "../word.js";globalThis.word=word;</script></head><body><script>var order=["body"];</script></body>'),
    text('deferred.js', 'order.push("deferred");'), text('word.js', 'export const word="local";')
  ], { entryPath: 'pages/index.html' }));
  const scripts = nodes(await parse(build.pages[0].html), 'script');
  const context = vm.createContext({}); for (const script of scripts) new vm.Script(content(script)).runInContext(context);
  assert.deepEqual(Array.from(context.order), ['body', 'deferred']); assert.equal(context.word, 'local');
});

test('React TSX uses only curated browser dependencies and emits standalone HTML with bundled styles', async () => {
  const files = [...starterFiles('react'), text('vite.config.js', 'throw new Error("DO_NOT_EXECUTE_CONFIG");'), text('package.json', '{"scripts":{"postinstall":"DO_NOT_EXECUTE_SCRIPT"}}')];
  files[0] = text('src/main.tsx', 'import React from "react";import {createRoot} from "react-dom/client";import {Sun} from "lucide-react";import {marked} from "marked";import DOMPurify from "dompurify";import "./style.css";createRoot(document.getElementById("root")!).render(<main><Sun/><span dangerouslySetInnerHTML={{__html:DOMPurify.sanitize(marked.parse("**offline**") as string)}}/></main>);');
  const input = snapshot(files, { runtime: 'react', entryPath: 'src/main.tsx', sourceRevision: 7 });
  const build = await buildArtifact(input), document = await parse(build.pages[0].html);
  assert.deepEqual(build.pages.map(page => page.path), ['index.html']); assert.equal(build.sourceRevision, 7);
  assert.equal(attribute(nodes(document, 'div')[0], 'id'), 'root'); assert.equal(nodes(document, 'style').length, 1);
  assert.equal(nodes(document, 'script').length, 1); new vm.Script(content(nodes(document, 'script')[0]));
  assert.doesNotMatch(build.pages[0].html, /DO_NOT_EXECUTE|C:\\Users\\|file:\/\/|<script[^>]+src=/i);
  assert.equal(build.sourceDigest, sourceDigest(input));
});

test('multi-page output starts at the entry and preserves known local navigation without fetching', async () => {
  const build = await buildArtifact(snapshot([text('z.html', '<a href="a.html#target">local</a>'), text('a.html', '<h1 id="target">A</h1>'), text('b.htm', '<h1>B</h1>')], { entryPath: 'z.html' }));
  assert.deepEqual(build.pages.map(page => page.path), ['z.html', 'a.html', 'b.htm']);
  assert.equal(attribute(nodes(await parse(build.pages[0].html), 'a')[0], 'href'), 'a.html#target');
});

test('build source and page digests are deterministic and exclude artifact identity and revision', async () => {
  const files = [text('index.html', '<style>body{color:red}</style><script type="module">globalThis.n=3;</script>')];
  const first = await buildArtifact(snapshot(files));
  const second = await buildArtifact(snapshot(files, { id: 'artifact_other', sourceRevision: 2 }));
  assert.equal(first.sourceDigest, second.sourceDigest); assert.equal(first.sha256, second.sha256); assert.notEqual(first.id, second.id);
});

test('missing static references fail instead of silently shipping network or broken dependencies', async () => {
  for (const html of ['<img src="missing.png">', '<script src="missing.js"></script>', '<link rel="stylesheet" href="missing.css">', '<style>@import "missing.css";</style>', '<style>body{background:url(missing.png)}</style>', '<a href="other.html">missing</a>']) {
    await assert.rejects(buildArtifact(snapshot([text('index.html', html)])), /找不到|无法解析/);
  }
});

test('network, Node, host paths and unsupported package imports cannot leave the virtual filesystem', async () => {
  const imports = ['https://example.invalid/module.js', '//example.invalid/module.js', 'node:fs', 'fs', 'electron', 'C:/Windows/win.ini', 'file:///C:/Windows/win.ini', '../../outside.js'];
  for (const specifier of imports) await assert.rejects(buildArtifact(snapshot([text('src/main.tsx', `import ${JSON.stringify(specifier)};`)], { runtime: 'react', entryPath: 'src/main.tsx' })), /构建失败|路径/);
  for (const html of ['<img src="https://example.invalid/p.png">', '<a href="https://example.invalid/">remote</a>', '<style>@import "https://example.invalid/style.css";</style>', '<style>body{background:url(//example.invalid/a.png)}</style>', '<script src="file:///C:/outside.js"></script>']) await assert.rejects(buildArtifact(snapshot([text('index.html', html)])), /构建失败/);
});

test('HTML templates are traversed and parser-recognized active attributes receive the same dependency checks', async () => {
  for (const html of ['<template><img src="https://example.invalid/image.png"></template>', '<svg><image href="https://example.invalid/image.png"/></svg>', '<img srcset="https://example.invalid/image.png 1x">', '<form action="https://example.invalid/submit"></form>', '<meta http-equiv="refresh" content="0;url=https://example.invalid">', '<base href="https://example.invalid/">', '<iframe src="index.html"></iframe>', '<script type="importmap">{}</script>']) await assert.rejects(buildArtifact(snapshot([text('index.html', html)])), /构建失败/);
});

test('direct callers cannot bypass source path, file, binary and aggregate size limits', async () => {
  const minimal = [text('index.html', '<h1>ok</h1>')];
  const invalid = [
    snapshot(minimal, { sourceRevision: 0 }), snapshot(minimal, { runtime: 'node' }), snapshot(minimal, { entryPath: '../index.html' }),
    snapshot([text('index.html', ''), text('INDEX.HTML', '')]), snapshot([text('index.html', ''), text('CON.txt', '')]),
    snapshot([text('index.html', ''), text('a', ''), text('a/file.txt', '')]),
    snapshot([text('index.html', 'x'.repeat(1024 * 1024 + 1))]),
    snapshot([text('index.html', ''), binary('large.bin', Buffer.alloc(3 * 1024 * 1024 + 1))]),
    snapshot([text('index.html', ''), { path: 'bad.bin', dataBase64: 'A===' }]),
    snapshot([text('index.html', ''), { path: 'both.txt', text: '', dataBase64: '' }]),
    snapshot([text('index.html', ''), ...Array.from({ length: 200 }, (_, i) => text(`file${i}.txt`, ''))]),
    snapshot([text('index.html', ''), ...Array.from({ length: 6 }, (_, i) => text(`file${i}.txt`, 'x'.repeat(900 * 1024)))])
  ];
  for (const input of invalid) await assert.rejects(buildArtifact(input));
  let accessed = false; const malicious = { path: 'evil.txt' }; Object.defineProperty(malicious, 'text', { enumerable: true, get() { accessed = true; return ''; } });
  await assert.rejects(buildArtifact(snapshot([...minimal, malicious]))); assert.equal(accessed, false);
});

test('page count and expanded inline HTML size remain bounded', async () => {
  await assert.rejects(buildArtifact(snapshot(Array.from({ length: 21 }, (_, i) => text(i ? `p${i}.html` : 'index.html', '<p>page</p>')))), /20/);
  const html = '<img src="large.png">'.repeat(5);
  await assert.rejects(buildArtifact(snapshot([text('index.html', html), binary('large.png', Buffer.alloc(2 * 1024 * 1024))])), /10 MiB/);
});
