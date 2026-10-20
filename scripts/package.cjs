const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const runtime = path.dirname(require('electron'));
const releaseRoot = path.join(root, 'release');
const destination = path.join(releaseRoot, `Muse-Windows-${pkg.version}-win32-x64`);
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This package recipe targets Windows x64.');
if (!fs.existsSync(path.join(runtime, 'electron.exe'))) throw new Error('Electron Windows binary is not installed.');
if (!fs.existsSync(path.join(root, 'build', 'app.js'))) throw new Error('Run npm run build first.');
if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite an existing release: ${destination}. Move it aside or bump the version.`);
fs.mkdirSync(releaseRoot, { recursive: true });
fs.cpSync(runtime, destination, { recursive: true });
fs.renameSync(path.join(destination, 'electron.exe'), path.join(destination, 'Muse.exe'));
const application = path.join(destination, 'resources', 'app');
fs.mkdirSync(application, { recursive: true });
for (const item of ['main.cjs','preload.cjs','backend','build','assets','scripts/desktop-scenario.cjs','scripts/json-file-scenario.cjs','scripts/file-export-scenario.cjs','scripts/csv-file-scenario.cjs','scripts/file-rename-scenario.cjs','scripts/image-preview-scenario.cjs','scripts/video-preview-scenario.cjs','scripts/video-fixtures.cjs','scripts/pdf-preview-scenario.cjs','scripts/pdf-fixtures.cjs','scripts/docx-fixtures.cjs','scripts/docx-zip.cjs','scripts/docx-preview-scenario.cjs','scripts/chat-lifecycle-scenario.cjs','scripts/queue-scenario.cjs','scripts/cancel-admission-scenario.cjs','scripts/artifact-scenario.cjs','scripts/artifact-editing-scenario.cjs','scripts/artifact-annotation-scenario.cjs','scripts/active-panel-scenario.cjs','scripts/scheduler-scenario.cjs','scripts/knowledge-scenario.cjs','scripts/dictation-scenario.cjs','scripts/audio-scenario.cjs','scripts/quit-cancel-scenario.cjs','scripts/live-provider-scenario.cjs']) {
  const source = path.join(root, item);
  if (fs.existsSync(source)) { fs.mkdirSync(path.dirname(path.join(application,item)),{recursive:true}); fs.cpSync(source, path.join(application, item), { recursive: true }); }
}
fs.writeFileSync(path.join(application, 'package.json'), JSON.stringify({ name:pkg.name, version:pkg.version, description:pkg.description, license:pkg.license, repository:pkg.repository, main:pkg.main, dependencies:pkg.dependencies }, null, 2));
const copied = new Set();
function findPackage(name, from) {
  let directory = from;
  while (true) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
function copyDependency(name, from, optional = false) {
  const source = findPackage(name, from);
  if (!source) { if (optional) return; throw new Error(`Missing runtime dependency ${name}`); }
  if (copied.has(source)) return;
  const relative = path.relative(root, source);
  if (!relative.startsWith('node_modules' + path.sep) || relative.includes('..')) throw new Error(`Dependency escaped project: ${source}`);
  copied.add(source);
  fs.cpSync(source, path.join(application, relative), { recursive: true, filter: value => !path.relative(source, value).startsWith('node_modules' + path.sep) });
  const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(metadata.dependencies || {})) copyDependency(dependency, source, false);
  for (const dependency of Object.keys(metadata.optionalDependencies || {})) copyDependency(dependency, source, true);
}
for (const name of Object.keys(pkg.dependencies)) copyDependency(name, root);
const instructions = `Muse Windows ${pkg.version}\r\n\r\n双击 Muse.exe 启动，无须安装 Node.js。\r\n首次打开设置，填写自己的兼容模型 API 地址、模型名称和可选 API Key。\r\n支持流式聊天、本地工作区、参考文档、对话导出和数据备份。\r\nAPI Key 在 Windows 上使用系统加密保存，不包含在备份中。\r\n此版本是独立重建的 Windows 客户端，尚未覆盖原产品全部服务和系统集成。\r\n请保留整个文件夹；不要只移动 Muse.exe。\r\n`;
// Windows tar writes legacy-codepage ZIP names for non-ASCII filenames.
// Keep the portable package's instruction filename independent of that locale.
fs.writeFileSync(path.join(destination, 'README-Windows.txt'), instructions, 'utf8');
for (const name of ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
  const source = path.join(root, name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(destination, name));
}
const executable = path.join(destination, 'Muse.exe');
const receipt = { version:pkg.version, platform:'win32-x64', executable, sha256:crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), runtime:require('electron/package.json').version, runtime_dependency_directories:copied.size };
fs.writeFileSync(path.join(releaseRoot, 'release-manifest.json'), JSON.stringify(receipt, null, 2));
const zip = path.join(releaseRoot, path.basename(destination) + '.zip');
const result = spawnSync('tar.exe', ['-a','-c','-f',zip,path.basename(destination)], { cwd:releaseRoot, stdio:'pipe', windowsHide:true });
if (result.error || result.status !== 0) throw new Error(`ZIP packaging failed; the unpacked application is at ${destination}. ${result.error?.message || result.stderr}`);
receipt.archive = zip;
fs.writeFileSync(path.join(releaseRoot, 'release-manifest.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
