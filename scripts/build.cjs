const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
(async () => {
  const out = path.join(root, 'build');
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(root, 'renderer', 'App.jsx')], bundle: true, outfile: path.join(out, 'app.js'), platform: 'browser', target: 'chrome130', jsx: 'automatic', sourcemap: true, minify: true, define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.svg': 'dataurl', '.png': 'file', '.woff2': 'file', '.ttf': 'file' } });
  fs.copyFileSync(path.join(root, 'renderer', 'index.html'), path.join(out, 'index.html'));
  if (fs.existsSync(path.join(root, 'renderer', 'assets'))) fs.cpSync(path.join(root, 'renderer', 'assets'), path.join(out, 'assets'), { recursive: true });
  console.log('Desktop UI built.');
})().catch(error => { console.error(error.message); process.exit(1); });
