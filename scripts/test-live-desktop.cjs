'use strict';

// Enter real credentials in the app; only Electron safeStorage decrypts them.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const configure = process.argv.includes('--configure');
const dataDirectory = path.join(root, '.test-tmp', 'live-provider-user');
const folder = path.join(root, 'test-results', 'live-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(folder, { recursive: true });
const env = { ...process.env, MUSE_LIVE_REPORT_DIR: folder };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MUSE_LIVE_API_KEY;
const args = [root, '--data-dir=' + dataDirectory, configure ? '--settings' : '--live-provider-test'];
const child = spawn(require('electron'), args, { cwd: root, env, windowsHide: !configure, stdio: 'ignore' });
const timeout = configure ? null : setTimeout(() => { child.kill(); }, 210000);
child.on('error', error => { if (timeout) clearTimeout(timeout); console.error(error.message); process.exitCode = 1; });
child.on('exit', code => {
  if (timeout) clearTimeout(timeout);
  console.log(JSON.stringify({ exitCode: code, configure, folder }, null, 2));
  if (code !== 0) { console.error('验收未通过；如尚未设置，请先运行 npm run test:live -- --configure。详细结果见测试目录中的 report.json。'); process.exitCode = 1; }
});
