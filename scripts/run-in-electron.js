// Runs a script under Electron's bundled Node.
//
// better-sqlite3 is compiled against Electron's ABI (see electron-builder
// install-app-deps), so plain `node` cannot require it. Setting
// ELECTRON_RUN_AS_NODE inline in an npm script is not portable to Windows cmd,
// hence this wrapper.
//
//   node scripts/run-in-electron.js scripts/test-migrations.js

const { spawn } = require('node:child_process');
const path = require('node:path');

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/run-in-electron.js <script> [args...]');
  process.exit(2);
}

const electron = require('electron'); // resolves to the binary path string

const child = spawn(electron, [path.resolve(target), ...process.argv.slice(3)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

child.on('exit', code => process.exit(code == null ? 1 : code));
child.on('error', err => { console.error(err.message); process.exit(1); });
