'use strict';

// This is an independent, offline compiler for the Windows artifact contract.
// Authored sources are parsed and bundled, never imported or executed by Node.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const model = require('./artifact-model.cjs');
const posix = path.posix;
const BUILDER_VERSION = '1';
const MAX_HTML_BYTES = 10 * 1024 * 1024;
const PACKAGE_NAMES = ['react', 'react-dom', 'lucide-react', 'marked', 'dompurify'];
const PACKAGE_DEPENDENCIES = [...PACKAGE_NAMES, 'scheduler'];
const projectRoot = path.resolve(__dirname, '..');
const fail = message => { throw new Error(`应用构建失败：${message}`); };

function artifactPath(value) {
  return model.artifactPath(value);
}

function validateSnapshot(snapshot) {
  model.strictRecord(snapshot, null, '应用快照');
  model.artifactId(snapshot.id); model.revision(snapshot.sourceRevision);
  if (!['html', 'react'].includes(snapshot.runtime)) fail('应用快照格式无效');
  const entryPath = artifactPath(snapshot.entryPath);
  if (!Array.isArray(snapshot.files) || !snapshot.files.length || snapshot.files.length > 200) fail('应用文件数量必须为 1 至 200');
  const files = new Map();
  const sourceFiles = model.validateArtifactFiles(snapshot.files);
  for (const file of sourceFiles) files.set(file.path, { ...file, data: model.fileBytes(file) });
  if (!files.has(entryPath) || typeof files.get(entryPath).text !== 'string') fail('入口文本文件不存在');
  if (snapshot.runtime === 'html' && !/\.html?$/i.test(entryPath)) fail('HTML 入口必须为 .html 或 .htm');
  if (snapshot.runtime === 'react' && !/\.(?:[cm]?[jt]sx?)$/i.test(entryPath)) fail('React 入口必须是 JavaScript 或 TypeScript 文本');
  return { files, entryPath, runtime: snapshot.runtime, sourceRevision: snapshot.sourceRevision, sourceDigest: model.sourceDigest({ runtime: snapshot.runtime, entryPath, files: sourceFiles }) };
}

function resolveReference(value, importer, files, extensions = false) {
  if (typeof value !== 'string' || !value.trim()) fail('资源引用为空');
  const reference = value.trim();
  if (reference.startsWith('#')) return { fragment: reference };
  if (/^data:/i.test(reference)) return { dataUrl: reference };
  if (/[\\\x00-\x20\x7f]/.test(reference) || /^[A-Za-z][\w+.-]*:/.test(reference) || reference.startsWith('//')) fail('资源只能引用应用内文件，不能使用网络或宿主路径');
  const match = /^([^?#]*)(?:\?[^#]*)?(#.*)?$/.exec(reference);
  let decoded;
  try { decoded = decodeURIComponent(match[1]); } catch { fail('资源路径编码无效'); }
  if (/[\\\x00-\x1f\x7f:]/.test(decoded)) fail('资源路径无效');
  const candidate = decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(importer), decoded);
  let name = artifactPath(posix.normalize(candidate));
  if (extensions && !files.has(name)) name = [name, ...['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json'].map(extension => name + extension), ...['index.tsx', 'index.ts', 'index.jsx', 'index.js'].map(index => posix.join(name, index))].find(candidate => files.has(candidate)) || name;
  if (!files.has(name)) fail(`找不到应用资源 ${name}`);
  return { path: name, suffix: match[2] || '' };
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt', '.txt': 'text/plain', '.json': 'application/json', '.pdf': 'application/pdf', '.html': 'text/html', '.htm': 'text/html' };
const mime = name => MIME[posix.extname(name).toLowerCase()] || 'application/octet-stream';
function resourceUrl(value, importer, files) {
  const reference = resolveReference(value, importer, files);
  if (reference.fragment || reference.dataUrl) return reference.fragment || reference.dataUrl;
  return `data:${mime(reference.path)};base64,${files.get(reference.path).data.toString('base64')}${reference.suffix}`;
}

function packageName(specifier) { return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]; }
function fileLoader(name) {
  const extension = posix.extname(name).toLowerCase();
  return ({ '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.tsx': 'tsx', '.css': 'css', '.json': 'json', '.txt': 'text' })[extension] || 'dataurl';
}

function bundler(files) {
  const packageRoots = PACKAGE_DEPENDENCIES.map(name => path.join(projectRoot, 'node_modules', name)).filter(root => fs.existsSync(root)).map(root => fs.realpathSync(root));
  const verifiedPackagePaths = new Map();
  const allowedPackagePath = filename => {
    if (verifiedPackagePaths.has(filename)) return verifiedPackagePaths.get(filename);
    let resolved;
    try { resolved = fs.realpathSync(filename); } catch { fail('内置浏览器依赖不存在'); }
    if (!packageRoots.some(root => resolved.startsWith(root + path.sep))) fail('依赖超出内置浏览器包范围');
    verifiedPackagePaths.set(filename, resolved);
    return resolved;
  };
  return async function bundle(entry, contents, kind = 'js') {
    const virtual = new Map(files);
    if (contents !== undefined) virtual.set(entry, { path: entry, text: contents, data: Buffer.from(contents) });
    const plugin = {
      name: 'artifact-offline-files',
      setup(build) {
        build.onResolve({ filter: /.*/ }, async args => {
          if (args.pluginData?.trustedResolution) return;
          if (args.kind === 'entry-point') return { path: entry, namespace: 'artifact' };
          if (args.path.startsWith('#') || /^data:/i.test(args.path)) {
            if (args.kind === 'url-token') return { path: args.path, external: true };
            fail('脚本不能导入 data URL 或 fragment');
          }
          if (/^[A-Za-z][\w+.-]*:/.test(args.path) || args.path.startsWith('//') || /[\\\x00-\x1f]/.test(args.path)) fail('不能导入网络、Node 或宿主文件');
          if (args.namespace === 'artifact' && (args.path.startsWith('.') || args.path.startsWith('/') || ['import-rule', 'url-token', 'composes-from'].includes(args.kind))) {
            const reference = resolveReference(args.path, args.importer, virtual, !['import-rule', 'url-token'].includes(args.kind));
            return { path: reference.path, namespace: 'artifact' };
          }
          if (args.namespace === 'artifact' && !PACKAGE_NAMES.includes(packageName(args.path))) fail('只允许内置浏览器依赖');
          if (args.namespace !== 'artifact') {
            allowedPackagePath(args.importer);
            if (!args.path.startsWith('.') && !PACKAGE_DEPENDENCIES.includes(packageName(args.path))) fail('内置依赖引用了不受支持的包');
            // Let esbuild resolve trusted package-internal files natively. The
            // file loader below still checks every final real path before read.
            return;
          }
          const resolved = await build.resolve(args.path, { resolveDir: args.namespace === 'artifact' ? projectRoot : path.dirname(args.importer), kind: args.kind, pluginData: { trustedResolution: true } });
          if (resolved.errors.length || !resolved.path || resolved.external) fail('无法解析内置浏览器依赖');
          return { path: allowedPackagePath(resolved.path), namespace: 'file' };
        });
        build.onLoad({ filter: /.*/, namespace: 'artifact' }, args => {
          const file = virtual.get(args.path);
          if (!file) fail('虚拟文件不存在');
          const loader = fileLoader(args.path);
          if (['js', 'jsx', 'ts', 'tsx', 'css', 'json'].includes(loader) && typeof file.text !== 'string') fail('代码文件必须使用文本编码');
          return { contents: file.data, loader };
        });
        build.onLoad({ filter: /.*/, namespace: 'file' }, args => ({ contents: fs.readFileSync(allowedPackagePath(args.path)), loader: fileLoader(args.path), resolveDir: path.dirname(args.path) }));
      }
    };
    let result;
    try {
      result = await esbuild.build({ entryPoints: [entry], absWorkingDir: projectRoot, bundle: true, write: false, outfile: kind === 'css' ? 'artifact.css' : 'artifact.js', platform: 'browser', format: 'iife', target: 'chrome130', jsx: 'automatic', charset: 'utf8', minify: true, legalComments: 'none', logLevel: 'silent', tsconfigRaw: {}, define: { 'process.env.NODE_ENV': '"production"' }, plugins: [plugin] });
    } catch (error) {
      const detail = error.errors?.[0]?.text || error.message;
      fail(String(detail).replaceAll(projectRoot, '[应用构建器]').slice(0, 600));
    }
    const javascript = result.outputFiles.find(file => /\.js$/.test(file.path))?.text || '';
    const css = result.outputFiles.find(file => /\.css$/.test(file.path))?.text || '';
    if (result.outputFiles.some(file => !/\.(?:css|js)$/.test(file.path))) fail('构建产生了未内联资源');
    return { javascript, css };
  };
}

const getAttr = (node, name) => node.attrs?.find(attr => (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name) === name)?.value;
function setAttr(node, name, value) {
  const attr = node.attrs.find(item => (item.prefix ? `${item.prefix}:${item.name}` : item.name) === name);
  if (attr) attr.value = value; else node.attrs.push({ name, value });
}
function removeAttr(node, name) { node.attrs = node.attrs.filter(attr => attr.name !== name); }
function setText(node, value) { node.childNodes = [{ nodeName: '#text', value, parentNode: node }]; }
const textContent = node => (node.childNodes || []).map(child => child.value || '').join('');
const escapeScript = value => value.replace(/<\/script/gi, '<\\/script');
const escapeStyle = value => value.replace(/<\/style/gi, '<\\/style');

function srcsetCandidates(value) {
  const candidates = []; let index = 0;
  while (index < value.length) {
    while (/[\s,]/.test(value[index] || '') && index < value.length) index++;
    const start = index;
    while (index < value.length && !/\s/.test(value[index])) index++;
    let url = value.slice(start, index);
    if (!url) break;
    if (url.endsWith(',')) { candidates.push({ url: url.replace(/,+$/, ''), descriptor: '' }); continue; }
    const descriptorStart = index;
    while (index < value.length && value[index] !== ',') index++;
    const descriptor = value.slice(descriptorStart, index).trim(); index++;
    if (descriptor && !/^(?:\d+w|\d+h|\d+(?:\.\d+)?x)$/.test(descriptor)) fail('srcset 描述格式无效');
    candidates.push({ url, descriptor });
  }
  return candidates;
}

async function buildArtifact(snapshot) {
  const { files, entryPath, runtime, sourceRevision, sourceDigest } = validateSnapshot(snapshot);
  const parse5 = await import('parse5');
  const bundle = bundler(files);
  let inlineIndex = 0;
  const synthetic = (importer, suffix) => { let name; do { name = posix.join(posix.dirname(importer), `.artifact-inline-${inlineIndex++}.${suffix}`); } while (files.has(name)); return name; };
  const compileCss = async (value, importer) => (await bundle(synthetic(importer, 'css'), value, 'css')).css;
  const styleNode = (css, parentNode) => {
    const node = { nodeName: 'style', tagName: 'style', attrs: [], namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [], parentNode };
    setText(node, escapeStyle(css)); return node;
  };
  async function processDocument(document, importer) {
    const deferredScripts = [];
    async function visit(node) {
      if (node.tagName === 'base') fail('离线页面不支持 base 路径覆盖');
      if (node.tagName === 'meta' && getAttr(node, 'http-equiv')?.toLowerCase() === 'refresh') fail('离线页面不支持自动跳转');
      if (node.tagName === 'script') {
        const type = (getAttr(node, 'type') || '').trim().toLowerCase();
        const source = getAttr(node, 'src');
        const deferToBody = type === 'module' || source !== undefined && getAttr(node, 'defer') !== undefined;
        if (type === 'importmap') fail('请直接使用应用内模块或内置浏览器依赖，不支持 importmap');
        if (!type || /^(?:text|application)\/(?:javascript|ecmascript)$/.test(type) || type === 'module') {
          let code = textContent(node); let filename = importer;
          if (source !== undefined) {
            const reference = resolveReference(source, importer, files);
            if (!reference.path || typeof files.get(reference.path).text !== 'string') fail('脚本必须引用应用内文本文件');
            filename = reference.path; code = files.get(filename).text;
          }
          if (type === 'module') {
            const built = await bundle(source !== undefined ? filename : synthetic(importer, 'mjs'), code);
            code = built.javascript;
            if (built.css) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 0, styleNode(built.css, node.parentNode));
            removeAttr(node, 'type');
          }
          for (const name of ['src', 'integrity', 'crossorigin', 'async', 'defer']) removeAttr(node, name);
          setText(node, escapeScript(code));
          if (deferToBody) {
            node.parentNode.childNodes = node.parentNode.childNodes.filter(child => child !== node);
            deferredScripts.push(node);
          }
        } else if (source !== undefined) fail('不支持外部非 JavaScript 脚本');
      } else if (node.tagName === 'style') {
        setText(node, escapeStyle(await compileCss(textContent(node), importer)));
      } else if (node.tagName === 'link') {
        const href = getAttr(node, 'href');
        const rel = (getAttr(node, 'rel') || '').toLowerCase().split(/\s+/);
        if (rel.includes('stylesheet')) {
          const reference = resolveReference(href, importer, files);
          if (!reference.path || typeof files.get(reference.path).text !== 'string') fail('样式必须引用应用内文本文件');
          const css = (await bundle(reference.path, undefined, 'css')).css;
          node.nodeName = node.tagName = 'style';
          node.attrs = node.attrs.filter(attr => ['media', 'title', 'disabled'].includes(attr.name));
          setText(node, escapeStyle(css));
        } else if (rel.includes('modulepreload')) {
          if (href) resolveReference(href, importer, files);
          node.parentNode.childNodes = node.parentNode.childNodes.filter(child => child !== node); return;
        } else if (href !== undefined) setAttr(node, 'href', resourceUrl(href, importer, files));
      }
      if (node.attrs) {
        const inlineStyle = getAttr(node, 'style');
        if (inlineStyle !== undefined) {
          const compiled = await compileCss(`.artifact-inline{${inlineStyle}}`, importer);
          setAttr(node, 'style', compiled.slice(compiled.indexOf('{') + 1, compiled.lastIndexOf('}')).trim());
        }
        for (const attr of [...node.attrs]) {
          const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
          if (name === 'srcdoc') fail('请把嵌套文档保存为独立 HTML 页面');
          if (['srcset', 'imagesrcset'].includes(name)) setAttr(node, name, srcsetCandidates(attr.value).map(candidate => resourceUrl(candidate.url, importer, files) + (candidate.descriptor ? ' ' + candidate.descriptor : '')).join(', '));
          if (['src', 'poster', 'background', 'data'].includes(name) && node.tagName !== 'script') {
            if (['iframe', 'object', 'embed'].includes(node.tagName)) fail('离线页面不支持嵌套外部文档');
            setAttr(node, name, resourceUrl(attr.value, importer, files));
          }
          if (['href', 'xlink:href'].includes(name) && node.tagName !== 'link') {
            const reference = resolveReference(attr.value, importer, files);
            if (['a', 'area'].includes(node.tagName) && reference.path && /\.html?$/i.test(reference.path)) setAttr(node, name, reference.path + (reference.suffix || ''));
            else setAttr(node, name, resourceUrl(attr.value, importer, files));
          }
          if (['action', 'formaction', 'ping', 'manifest', 'codebase', 'archive'].includes(name)) fail('离线页面不支持网络或外部文档动作');
        }
      }
      // Template content is a distinct parse5 DocumentFragment, not childNodes.
      for (const child of [...(node.childNodes || [])]) await visit(child);
      if (node.content) await visit(node.content);
    }
    await visit(document);
    if (deferredScripts.length) {
      const html = document.childNodes.find(node => node.tagName === 'html');
      const body = html?.childNodes.find(node => node.tagName === 'body');
      if (!body) fail('页面缺少正文');
      for (const node of deferredScripts) { node.parentNode = body; body.childNodes.push(node); }
    }
  }
  let pages;
  if (runtime === 'react') {
    const built = await bundle(entryPath);
    const document = parse5.parse('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>');
    const html = document.childNodes.find(node => node.tagName === 'html');
    const head = html.childNodes.find(node => node.tagName === 'head');
    const body = html.childNodes.find(node => node.tagName === 'body');
    if (built.css) head.childNodes.push(styleNode(built.css, head));
    const script = { nodeName: 'script', tagName: 'script', attrs: [], namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [], parentNode: body };
    setText(script, escapeScript(built.javascript)); body.childNodes.push(script);
    pages = [{ path: 'index.html', html: parse5.serialize(document) }];
  } else {
    const names = [...files.keys()].filter(name => /\.html?$/i.test(name));
    if (names.length > 20) fail('最多构建 20 个 HTML 页面');
    names.sort((a, b) => a === entryPath ? -1 : b === entryPath ? 1 : a < b ? -1 : a > b ? 1 : 0);
    pages = [];
    for (const name of names) {
      if (typeof files.get(name).text !== 'string') fail('HTML 页面必须使用文本编码');
      const document = parse5.parse(files.get(name).text);
      await processDocument(document, name);
      pages.push({ path: name, html: parse5.serialize(document) });
      if (pages.reduce((sum, page) => sum + Buffer.byteLength(page.html), 0) > MAX_HTML_BYTES) fail('构建页面总量超过 10 MiB');
    }
  }
  if (pages.reduce((sum, page) => sum + Buffer.byteLength(page.html), 0) > MAX_HTML_BYTES) fail('构建页面总量超过 10 MiB');
  return model.validateArtifactBuild({ id: crypto.randomUUID(), sourceRevision, createdAt: new Date().toISOString(), pages, sha256: model.pagesDigest(pages), sourceDigest, builderVersion: BUILDER_VERSION });
}

module.exports = { buildArtifact };
