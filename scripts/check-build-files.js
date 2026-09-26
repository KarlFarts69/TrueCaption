// Every local file the app require()s must be in package.json build.files.
// electron-builder packages ONLY what that list names, and `npm start` and
// the smoke suite both run from the source folder, where everything exists.
// So a file missing from the list passes every test and crashes the
// installed app at launch. This happened: 7.3.0 shipped without
// db-migrations.js and db-backup.js.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const listed = new Set(require(path.join(root, 'package.json')).build.files);
const missing = new Set();
const seen = new Set();

function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  for (const m of src.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) {
    const dep = m[1].endsWith('.js') ? m[1] : `${m[1]}.js`;
    if (!listed.has(dep)) missing.add(`${dep} (required by ${file})`);
    walk(dep);
  }
}
walk(require(path.join(root, 'package.json')).main);
walk('preload.js');

if (missing.size) {
  console.log('FAIL  not in package.json build.files, so the installed app cannot load:\n  ' +
    [...missing].join('\n  '));
  process.exit(1);
}
console.log(`PASS  every required local file is packaged (${seen.size} checked)`);
