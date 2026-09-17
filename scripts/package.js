const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { version } = require('../package.json');

const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'releases'), { recursive: true });
const cli = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
const result = spawnSync(process.execPath, [cli, 'package', '--no-dependencies', '-o', `releases/typeecho-${version}.vsix`], {
  cwd: root, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
