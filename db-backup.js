// Database backups.
//
// The database is a single file holding every matter and person. It lives in
// AppData, which — unlike Documents — OneDrive does not sync, so without this
// there is no copy anywhere.
//
// Uses better-sqlite3's .backup() rather than fs.copyFile: the online backup API
// produces a consistent snapshot even while the database is open and mid-write,
// which a raw file copy cannot guarantee.

const path = require('path');
const fs = require('fs');

const KEEP = 10;

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupDir(userDataPath) {
  const dir = path.join(userDataPath, 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Snapshot to `destPath`. Returns a promise resolving to destPath.
async function backupTo(db, destPath) {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await db.backup(destPath);
  return destPath;
}

// Rolling snapshot into AppData\backups, pruning to the newest KEEP files.
// Never throws: a failed backup must not stop the app from opening.
async function rollingBackup(db, userDataPath, label = 'data') {
  try {
    const dir = backupDir(userDataPath);
    const dest = path.join(dir, `${label}-${stamp()}.db`);
    await backupTo(db, dest);
    prune(dir);
    return dest;
  } catch (e) {
    console.error('Backup failed (continuing):', e.message);
    return null;
  }
}

function prune(dir, keep = KEEP) {
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.db'))
    .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* best effort */ }
  }
}

// Restore from a backup file. Used to move a prepared database onto another
// machine (build it here, carry it over, restore there).
//
// The current database is snapshotted first, so a restore is itself undoable.
// The caller must close and reopen the database afterwards — the file changes
// underneath any open handle.
function restoreFrom(sourcePath, dbPath, userDataPath) {
  if (!fs.existsSync(sourcePath)) throw new Error('Backup file not found: ' + sourcePath);

  // Verify it is actually a SQLite database with our tables before clobbering
  // anything. A truncated or wrong file must not become the live database.
  const Database = require('better-sqlite3');
  const probe = new Database(sourcePath, { readonly: true });
  try {
    const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    for (const required of ['matters', 'settings', 'attorneys']) {
      if (!tables.includes(required)) throw new Error(`Not a TrueCaption backup (missing "${required}" table)`);
    }
  } finally {
    probe.close();
  }

  if (fs.existsSync(dbPath)) {
    const safety = path.join(backupDir(userDataPath), `pre-restore-${stamp()}.db`);
    fs.copyFileSync(dbPath, safety);
  }

  fs.copyFileSync(sourcePath, dbPath);
  // SQLite side files would otherwise still describe the replaced database.
  for (const ext of ['-wal', '-shm']) {
    const side = dbPath + ext;
    if (fs.existsSync(side)) { try { fs.unlinkSync(side); } catch { /* best effort */ } }
  }
  return dbPath;
}

module.exports = { rollingBackup, backupTo, backupDir, stamp, restoreFrom };
