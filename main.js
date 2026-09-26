const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
// Path rules (folder names, length caps) live in folders.js so they can be
// tested without Electron; see scripts/test-folders.js.
const F = require('./folders');
const { sanitizeSegment } = F;

app.setName('TrueCaption');

let mainWindow;
let db;

// Bumped whenever generatePdf/generateDocx's actual rendering logic changes.
// resolveOutputPath()'s "unchanged, reuse the file" check hashes only the
// INPUT (matter/block data) — a rendering bug fix with no data change would
// otherwise never take effect for an existing matter, because the old,
// pre-fix file on disk would keep matching the hash forever. This happened
// for real: the caption-table columnWidths fix (see git history) shipped in
// code, but every matter whose data hadn't changed kept silently reusing its
// broken pre-fix .docx on every later "regenerate" until this constant
// existed. Bump it in the same commit as any change to output content.
// v2 (2026-08-19): caption note lines moved from matters.charges to the
// ordered matter_caption_notes table, and now also print in the appellate
// caption's identifier stack. Same bump also covers the .docx caption losing
// the table borders it should never have had (see NO_BORDERS).
// v3 (2026-08-19): legacy caption/signature audit — role words now follow the
// matter's labels, "v." -> "vs.", caption notes reach the legacy caption, bare
// bar number in the legacy signature, empty counsel lines dropped instead of
// printing "()" / "undefined", and four document titles underlined per spec §05.
// Also: caption tables now declare a fixed layout, so the column widths are
// actually honoured instead of being auto-fitted to the party name's length.
// v4 (2026-08-19): the Appearance's date moves into the signature block above
// the rule and is labeled "Date:", not flush-left "Dated:" (decision 7).
// v5 (2026-08-19): the appellate brief's signature carries its own Date:
// line — the cover-page date is a separate fact (confirmed against the source filings).
// v6 (2026-08-19): Phase 3 — packet/letter blocks, and the caption and counsel
// block are now closed by a RULE ending in a slash (spec §04) rather than a
// bare floating slash, in both renderers.
// v7 (2026-08-19): the driver-license hearing request packet — daad_caption
// and salutation blocks, a personal-letterhead layout (letterheads.kind), the
// re_block `plain` flag, and a letter_close fix (office line now read from
// the letterhead, matching the PDF, not from the attorney's firm_name).
// v8 (2026-08-20): Phase 4 — the stipulation & order. stipulation_clause,
// dual_signature, order_session, order_clause and judge_signature blocks;
// courts.city.
// v11 (2026-08-22): et al. logic consolidated into one shared function
// (partyCaptionText/partyCaptionNames) across both engines, replacing
// several call sites that previously ignored caption_style entirely: the
// district caption's plaintiff authority line, and the appellate caption's
// authority and defendant lines. A new caption_style value, 'et_al_force',
// always prints "FirstName, et al." even with exactly one named party.
// v12 (2026-08-22): the City Attorney letter — cc_block, printed after
// ref_initials in both the PDF path and the .docx export.
// v13 (2026-08-22): the appellate caption's "ours" counsel block now prints
// every matter.co_counsel row (signing attorney first, then additional
// counsel of record), the same way the district caption's counsel_block
// already did — previously every attorney but the signer was silently
// dropped from the appellate caption.
// v15: A5 — centered page-number footer, both engines.
// v16 (2026-09-24): our side's role words ("attorney of record for …",
// "Attorney for …" in the appearance signature and the counsel block) follow
// matters.client_role — a prosecuting client prints the plaintiff label, not
// the defendant's. And a whitespace-only per-case caption authority now falls
// through to the case type's in Word, as it already did in the PDF.
// v17 (2026-09-24): the district caption's role word under the plaintiff
// follows matters.plaintiff_label (it was hard-coded "Plaintiff"; the
// appellate caption already used the label). And with no caption authority
// and no plaintiff parties, the district and appellate captions print the
// "[PLAINTIFF]" blank in both engines instead of a bare "PLAINTIFF".
// v18 (2026-09-24): a packet's RE: case name ("PLAINTIFF v Defendant", the
// C&D transmittal letter and memorandum) prints "[PLAINTIFF]" / "[DEFENDANT]"
// for a side with no parties (and no recipient), in both engines, instead of
// a bare "PLAINTIFF" / "Defendant" that read as filled in.
// v19 (2026-09-24): the C&D Answer to Complaint's opening line ("NOW COMES
// Defendant, …") prints "[DEFENDANT]" with no defendant parties, instead of a
// bare "DEFENDANT". The text is built once in document-engine.js and shared by
// both engines, so there is no separate Word path to change.
const RENDER_VERSION = 19;

let dbInitError = null;

async function initDb() {
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'data.db');

  try {
    const Database = require('better-sqlite3');
    const { migrate } = require('./db-migrations');
    const { rollingBackup, backupTo, backupDir, stamp } = require('./db-backup');

    db = new Database(dbPath);

    // Take a snapshot before touching the schema, so a failed upgrade is
    // recoverable rather than terminal.
    const result = migrate(db, {
      onBeforeMigrate: (fromVersion) => {
        const dest = path.join(backupDir(userDataPath), `pre-migration-v${fromVersion}-${stamp()}.db`);
        try {
          // Synchronous fallback: migration must not proceed until this lands.
          fs.copyFileSync(dbPath, dest);
          console.log('Pre-migration backup written to', dest);
        } catch (e) {
          console.error('Pre-migration backup failed:', e.message);
          throw new Error('Refusing to migrate without a backup: ' + e.message);
        }
      }
    });
    if (result.ran > 0) console.log(`Schema migrated v${result.from} -> v${result.to}`);

    seedDefaults(userDataPath);

    // Routine rolling backup, after the schema is known good.
    rollingBackup(db, userDataPath);
  } catch (e) {
    dbInitError = e;
    console.error('Database initialization failed', e);
  }
}

// The output root is where every stored location is anchored (they are kept
// RELATIVE to it — see storePath below). So the app NEVER switches roots by
// itself. An earlier version pointed a missing root at this computer's default
// and saved that: when an unplugged or network drive came back, every stored
// location then resolved under the wrong folder, and the next save quietly
// started a brand-new empty tree beside the real one (the "it made a new
// folder" mistake). Now:
//   - root missing AND something has been saved: the setting is left alone,
//     a persistent banner says so, and every save / upload / Open Folder
//     refuses with the same words and creates NOTHING (rootRefusal). Each of
//     those re-checks the disk, so reconnecting the drive just works.
//   - root missing and nothing saved yet (fresh install, or a custom root not
//     used yet): created on first use, as it always was, no notice.
//   - moving it is the user's call, in Settings (choose-output-root).
function hasSavedLocations() {
  const { PATH_COLUMNS } = require('./db-migrations');
  return PATH_COLUMNS.some(([table, column]) => {
    try {
      return !!db.prepare(
        `SELECT 1 FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> '' LIMIT 1`).get();
    } catch { return false; }
  });
}

function rootMissingMessage(root) {
  return `Your documents folder (${root}) isn't available. ` +
    'Reconnect the drive it\'s on, or choose its new location in Settings.';
}

// The plain refusal for a missing documents folder, or null when it is fine to
// go ahead. Reads only; called afresh on every action.
function rootRefusal() {
  const root = outputRoot();
  if (root && fs.existsSync(root)) return null;
  if (!hasSavedLocations()) return null;
  return rootMissingMessage(root);
}

function rootMissingError(message) {
  return Object.assign(new Error(message), { code: 'ROOT_MISSING' });
}

// Thrown by every folder helper before it would mkdir anything, so no path
// into a missing root can create a stray tree — even one added later.
function assertRootAvailable() {
  const refusal = rootRefusal();
  if (refusal) throw rootMissingError(refusal);
}

function seedDefaults(userDataPath) {
  const hasOutputRoot = db.prepare("SELECT COUNT(*) as c FROM settings WHERE key = 'output_root'").get();
  if (hasOutputRoot.c === 0) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('output_root', path.join(app.getPath('documents'), 'Legal Documents'));
  }
}

// ---- App zoom ---------------------------------------------------------------
// Bigger text for weaker eyes. The whole window scales (webContents zoom, not
// CSS), so layout, text and click targets grow together. The steps stop one
// below today's size: smaller than that helps nobody here.
//
// The setting belongs to THIS computer (a big office screen, a small laptop),
// so it lives in a small file beside the database, not in the settings table,
// which travels with Back Up / Restore to whatever computer restores it.
const ZOOM_STEPS = [0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const uiPrefsPath = () => path.join(app.getPath('userData'), 'ui-prefs.json');

function readUiPrefs() {
  try {
    const prefs = JSON.parse(fs.readFileSync(uiPrefsPath(), 'utf8'));
    return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
  } catch {
    return {}; // missing or unreadable: every preference at its default
  }
}

// A saved value that is not one of the steps (hand-edited, from an older
// build) means 100%, not "the nearest step": it is not something anyone chose.
function savedZoom() {
  const z = readUiPrefs().zoom;
  return ZOOM_STEPS.includes(z) ? z : 1;
}

// The nearest step. Chromium hands a factor back through a log/pow round trip
// (1.1 can come back as 1.0999...), so every comparison goes through this.
function snapZoom(factor) {
  if (typeof factor !== 'number' || !Number.isFinite(factor)) return 1;
  return ZOOM_STEPS.reduce((best, s) => (Math.abs(s - factor) < Math.abs(best - factor) ? s : best));
}

function setAppZoom(wc, factor) {
  const f = snapZoom(factor);
  wc.setZoomFactor(f);
  try {
    // Write-then-rename, so a crash mid-write leaves the old file, not half a one.
    const file = uiPrefsPath();
    fs.writeFileSync(file + '.tmp', JSON.stringify({ ...readUiPrefs(), zoom: f }, null, 2));
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    console.error('Could not save the zoom setting:', e.message); // the zoom itself still applied
  }
  wc.send('zoom-changed', f);
  return f;
}

// dir: +1 / -1 one step, clamped at the ends; 0 back to 100%.
function stepAppZoom(wc, dir) {
  if (dir === 0) return setAppZoom(wc, 1);
  const i = ZOOM_STEPS.indexOf(snapZoom(wc.getZoomFactor()));
  return setAppZoom(wc, ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + dir))]);
}

// Ctrl on Windows, Cmd on macOS: + (or =), -, 0, and the keypad's. Handled
// here, before the page and before the default menu's own Zoom In / Out /
// Actual Size accelerators, which would change the zoom off the steps and
// without saving it.
function zoomKey(input) {
  if (input.type !== 'keyDown' || input.alt) return null;
  const mod = process.platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  if (!mod) return null;
  if (input.key === '+' || input.key === '=' || input.code === 'NumpadAdd') return 1;
  if (input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract') return -1;
  if ((input.key === '0' && !input.shift) || input.code === 'Numpad0') return 0;
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'assets/icons/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The saved zoom from the start, so the first paint is already at it
      // (no flash of 100% and then a jump).
      zoomFactor: savedZoom()
    }
  });
  // Chromium keeps a zoom level of its own per page (in the profile's
  // Preferences) and reapplies it when the page commits, over the
  // webPreferences value above. ui-prefs.json is the one source of truth, so
  // set it again the moment the page commits, before it has painted.
  mainWindow.webContents.on('did-navigate', () => mainWindow.webContents.setZoomFactor(savedZoom()));
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const dir = zoomKey(input);
    if (dir === null) return;
    event.preventDefault();
    stepAppZoom(mainWindow.webContents, dir);
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, 'assets/icons/icon.png'));
  }

  // Awaited: migrations and the pre-migration backup must finish before the
  // renderer can issue its first query.
  await initDb();

  // A failed database must never present as a working-but-empty app: that looks
  // like "all my matters are gone" and invites re-entering data over the top of
  // a database that is actually fine but locked or mid-upgrade.
  if (dbInitError) {
    const userDataPath = app.getPath('userData');
    await dialog.showMessageBox({
      type: 'error',
      title: 'Cannot open your data',
      message: 'TrueCaption could not open its database.',
      detail:
        `${dbInitError.message}\n\n` +
        `Your data has NOT been changed. Backups are in:\n${path.join(userDataPath, 'backups')}\n\n` +
        'Close the app and try again. If this keeps happening, restore the most recent backup.',
      buttons: ['Quit']
    });
    app.exit(1);
    return;
  }

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('db-all', (e, sql, params = []) => {
  if (!db) return [];
  return db.prepare(sql).all(...params);
});

ipcMain.handle('db-get', (e, sql, params = []) => {
  if (!db) return null;
  return db.prepare(sql).get(...params);
});

ipcMain.handle('db-run', (e, sql, params = []) => {
  if (!db) return { lastInsertRowid: 0, changes: 0 };
  const info = db.prepare(sql).run(...params);
  return { lastInsertRowid: info.lastInsertRowid, changes: info.changes };
});

// Several statements that must all land or none of them. The renderer cannot
// hold a transaction open across IPC calls — each invoke is its own round trip,
// and the UI stays live between them — so the whole batch is handed over at
// once and run inside better-sqlite3's synchronous transaction wrapper.
//
// This exists for replace-wholesale saves: DELETE everything for a parent row,
// then re-INSERT the current list. Done as separate db-run calls, an error
// partway leaves the record half deleted with nothing to roll it back.
ipcMain.handle('db-transaction', (e, statements = []) => {
  if (!db) return { changes: 0 };
  // ids[i] is statement i's lastInsertRowid, so a caller that inserts a row
  // and a second row pointing at it (INSERT ... last_insert_rowid()) can learn
  // both ids without leaving the transaction.
  const run = db.transaction((stmts) => {
    let changes = 0;
    const ids = [];
    for (const st of stmts) {
      const info = db.prepare(st.sql).run(...(st.params || []));
      changes += info.changes;
      ids.push(Number(info.lastInsertRowid));
    }
    return { changes, ids };
  });
  return run(statements);
});

// Make one path segment safe on Windows: strip the illegal characters and
// control codes, drop trailing dots/spaces (Explorer silently rejects them),
// and sidestep the reserved device names.
// ---- Blank-form text ------------------------------------------------------
// The one line of a paper form: a label, a colon, and somewhere to write.
// Mirrored by formFieldText()/BLANK_RULE in document-engine.js — the .docx and
// the HTML preview must ask the same question in the same words.
//
// The blank is drawn with underscores rather than an underlined tab: an
// underlined empty run is invisible in some readers, and a form whose answer
// lines vanish is worse than no form. 78 underscores exactly fill a 6.5"
// Times 12pt line (78 * 6pt = 468pt = 6.5in) with zero margin — but Times New
// Roman is proportional, so a label with wide capitals ("CDL Number", all
// caps) measures wider per character than the underscore-heavy average and
// overflows that budget, wrapping the line. Found 2026-08-25: "CDL Number"
// measured exactly 468pt, the page's usable width, and wrapped in every
// renderer tested. 76 leaves ~12pt of margin for the worst label in the
// current field list — re-measure if a much wider/all-caps label is added.
const BLANK_RULE = '_'.repeat(76);
function formFieldText(b) {
  const label = String(b.label || '');
  const kind = b.kind || 'text';
  if (kind === 'checkbox') return `${label}:   Yes [   ]    No [   ]`;
  if (kind === 'select') {
    const opts = (b.options || []).map(o => `${o} [   ]`).join('    ');
    return `${label}:   ${opts}`;
  }
  const room = Math.max(20, 76 - (label.length + 2));
  return `${label}: ${'_'.repeat(room)}`;
}

function outputRoot() {
  const rootSetting = db.prepare("SELECT value FROM settings WHERE key = 'output_root'").get();
  return rootSetting ? rootSetting.value : path.join(app.getPath('documents'), 'Legal Documents');
}

// Every folder / file location the database keeps is stored RELATIVE to the
// output root ("/"-separated), so a backup restored on another computer still
// finds its files once the Legal Documents folder is copied across (migration
// 36; folders.js toStored/fromStored). The ONLY way in and out of those
// columns: every write goes through storePath, every read through loadPath,
// and equality checks between frozen folders compare stored forms. A value
// outside the root stays absolute in both directions.
const storePath = (abs) => F.toStored(outputRoot(), abs);
const loadPath = (stored) => F.fromStored(outputRoot(), stored);

// Which client's folder a case lives in. Returns a person id, 0 for the
// explicit "No Client" choice, or null when the user has to be asked (several
// clients, or none, and no choice stored yet). A stored choice always wins, so
// adding a second client to a case later never moves it.
function matterFolderOwner(matterId) {
  const m = db.prepare('SELECT folder_person_id FROM matters WHERE id = ?').get(matterId);
  if (m && m.folder_person_id != null) return m.folder_person_id;
  const clients = db.prepare(
    `SELECT DISTINCT person_id FROM parties
      WHERE matter_id = ? AND role = 'client' AND person_id IS NOT NULL`).all(matterId);
  return clients.length === 1 ? clients[0].person_id : null;
}

// Thrown when a case has several clients (or none) and nobody has said which
// folder it belongs in yet. generate-pdf / generate-docx / save-attached-file
// turn it into { needsFolderOwner: true } so the renderer can ask, rather than
// guessing and freezing the guess forever.
function needsFolderOwnerError() {
  return Object.assign(new Error('Choose which client this case is filed under.'),
    { code: 'NEEDS_FOLDER_OWNER' });
}

// Where a case's documents live:
//   <output root>/Clients/<Client>/<Case Name (Case No.)>/
//   <output root>/No Client/<Case Name (Case No.)>/   (explicit "No Client")
//   <output root>/Blank Forms/                        (id-less: blank questionnaire)
//
// The client is matterFolderOwner()'s answer; the case number in the folder
// name stops two cases for the same client from colliding into one folder.
// Names are sanitized and length-capped by folders.js.
//
// This is decided ONCE, the first time something is generated for a matter,
// and then stored on matters.output_dir. Every later call reuses that exact
// path rather than recomputing it — otherwise renaming the case or the client,
// or editing the case number, would silently send the next document to a
// different folder while everything already generated stayed behind in the
// old one. (matter_types.folder_name is no longer read: the case-type layer
// was removed from the layout.)
function getMatterDir(matter) {
  assertRootAvailable();
  // A standalone letter has no matters row (matter.id is null) — without
  // this branch it would fall into the Blank Forms bucket below. It is filed
  // under the client chosen on New Letter (packets.client_person_id, read
  // from the row, not from the renderer's copy): Clients/<Client>/Letters/,
  // or General Letters/ when it has none. getPacketDir freezes the letter's
  // own folder inside this one, so a client changed later moves nothing.
  if (matter && matter.packet && matter.packet.kind === 'standalone_letter') {
    const row = matter.packet.id
      ? db.prepare('SELECT client_person_id FROM packets WHERE id = ?').get(matter.packet.id)
      : null;
    const clientId = row && row.client_person_id;
    // A client deleted since the letter was written: no folder to put it in,
    // so General Letters rather than a crash.
    const clientExists = clientId
      && db.prepare('SELECT 1 FROM people WHERE id = ?').get(clientId);
    const dir = clientExists
      ? F.clientLettersDir(getClientDir(clientId))
      : F.generalLettersDir(outputRoot());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  if (matter && matter.id) {
    const row = db.prepare('SELECT output_dir FROM matters WHERE id = ?').get(matter.id);
    if (row && row.output_dir) {
      const frozen = loadPath(row.output_dir);
      if (!fs.existsSync(frozen)) fs.mkdirSync(frozen, { recursive: true });
      return frozen;
    }
  }

  const rootDir = outputRoot();
  // The printable blank questionnaire is the only id-less caller: it belongs
  // to no case and no client.
  if (!matter || !matter.id) {
    const dir = F.blankFormsDir(rootDir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  const owner = matterFolderOwner(matter.id);
  if (owner == null) throw needsFolderOwnerError();
  const parent = owner === 0 ? F.noClientDir(rootDir) : getClientDir(owner);
  const dir = F.caseDir(parent, matter.short_name, matter.case_number);
  fs.mkdirSync(dir, { recursive: true });
  db.prepare('UPDATE matters SET output_dir = ? WHERE id = ?').run(storePath(dir), matter.id);
  return dir;
}

// A packet's own folder, inside its matter's folder. One filing, one envelope,
// one folder. Frozen on packets.output_dir the first time anything in the
// packet is generated, for the same reason matters.output_dir is frozen: the
// date or label it was built from stays editable, and recomputing would
// silently strand the documents already written (ground rule 0.5).
function getPacketDir(matter) {
  const p = matter && matter.packet;
  if (!p || !p.id) return null;
  assertRootAvailable();

  const row = db.prepare('SELECT output_dir FROM packets WHERE id = ?').get(p.id);
  if (row && row.output_dir) {
    const frozen = loadPath(row.output_dir);
    if (!fs.existsSync(frozen)) fs.mkdirSync(frozen, { recursive: true });
    return frozen;
  }

  const datePart = String(p.packet_date || '').slice(0, 10);
  let dir;
  if (p.kind === 'standalone_letter') {
    // Letters share a folder (General Letters/, or a client's Letters/), so
    // each one's folder names its recipient, and a second letter to the same
    // person on the same day is numbered rather than merged into the first.
    const parent = getMatterDir(matter);
    // Compared in STORED form: that is what the column holds.
    const taken = db.prepare('SELECT 1 FROM packets WHERE output_dir = ? AND id <> ?');
    let n = 1;
    do { dir = F.letterPacketDir(parent, datePart, p.recipient_name, n++); }
    while (taken.get(storePath(dir), p.id));
  } else {
    dir = F.packetDir(getMatterDir(matter), datePart, p.label || p.kind || 'Packet');
  }
  fs.mkdirSync(dir, { recursive: true });
  db.prepare('UPDATE packets SET output_dir = ? WHERE id = ?').run(storePath(dir), p.id);
  return dir;
}

// Where a client's scanned paperwork lives: <output root>/Clients/<Client Name>/
//
// Decided ONCE, on the first attachment, and stored on people.client_docs_dir.
// Every later call reuses that exact path rather than recomputing it —
// otherwise correcting a typo in a client's name would silently send the next
// scan to a new folder while everything already filed stayed behind.
//
// The name goes through sanitizeSegment for the same reason a matter's does:
// this app's real home is Windows, where `Smith/Jones` is not a folder name and
// a client surnamed `Nul` collides with a reserved device name. Two clients
// whose names sanitise to the same string would otherwise land in ONE folder
// and file each other's scans, so the loser of that race is disambiguated by
// person id — which is unique and, unlike the name, never edited.
function getClientDir(personId) {
  const row = db.prepare('SELECT display_name, client_docs_dir FROM people WHERE id = ?').get(personId);
  if (!row) throw new Error('No such person');
  assertRootAvailable();
  if (row.client_docs_dir) {
    const frozen = loadPath(row.client_docs_dir);
    if (!fs.existsSync(frozen)) fs.mkdirSync(frozen, { recursive: true });
    return frozen;
  }
  const rootDir = outputRoot();
  const name = sanitizeSegment(row.display_name, `Client ${personId}`);
  let dir = F.clientDir(rootDir, name);
  // Claimed by a DIFFERENT person? Then this name sanitised into someone
  // else's folder. Checked against the frozen column rather than against the
  // disk, so restoring a backup onto a machine that already has the folders
  // does not scatter everyone into new ones. Compared in STORED form.
  const claimed = db.prepare(
    'SELECT id FROM people WHERE client_docs_dir = ? AND id <> ?').get(storePath(dir), personId);
  if (claimed) {
    // Shorten the name, not the "(#id)" — the id is what tells them apart.
    const tag = ` (#${personId})`;
    dir = path.join(rootDir, 'Clients', `${F.capSegment(name, F.LIMITS.client - tag.length)}${tag}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  db.prepare('UPDATE people SET client_docs_dir = ? WHERE id = ?').run(storePath(dir), personId);
  return dir;
}

// Never overwrite. The file about to be clobbered is somebody's only copy of
// that scan, and a silent overwrite looks exactly like a successful save.
function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name, n = 2;
  while (fs.existsSync(path.join(dir, candidate))) candidate = `${base} (${n++})${ext}`;
  return candidate;
}

// Where an upload goes. With a case: that case's own Uploads/ folder, inside
// whichever client folder the case lives in (getMatterDir decides that, once).
// Without: the client's Client Papers/ folder. Either way the folder is
// recorded on the row (client_documents.stored_dir), so a later rename or
// re-homing never loses track of where this one file actually went.
//
// A case can only take uploads for one of its CLIENTS. A scan for the opposing
// party filed "under" the case would land inside another client's folder.
// Throws NEEDS_FOLDER_OWNER (nothing created) when the case's folder owner is
// still undecided.
function clientUploadDir(personId, matterId) {
  const refusal = uploadRefusal(personId, matterId);
  if (refusal) throw new Error(refusal);
  if (!matterId) return F.clientPapersDir(getClientDir(personId));
  const m = db.prepare('SELECT id, short_name, case_number FROM matters WHERE id = ?').get(matterId);
  return F.caseUploadsDir(getMatterDir(m));
}

// Why an upload cannot go where it was pointed, or null. Reads only — nothing
// is created — so it can run before the file dialog opens, and the user is not
// made to pick files for an add that was never going to happen.
function uploadRefusal(personId, matterId) {
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(personId)) return 'That client no longer exists.';
  if (!matterId) return null;
  if (!db.prepare('SELECT 1 FROM matters WHERE id = ?').get(matterId)) return 'That case no longer exists.';
  const isClient = db.prepare(
    "SELECT 1 FROM parties WHERE matter_id = ? AND person_id = ? AND role = 'client'").get(matterId, personId);
  if (!isClient) return 'This person is not a client on that case, so the file cannot be filed under it.';
  return null;
}

// The whole of the copy: resolve the folder, pick a non-colliding name,
// copy the bytes, record the row. Deliberately separate from the file dialog
// that usually feeds it — a dialog cannot be driven from the smoke harness, and
// Task 18's drag-and-drop hands over real paths with no dialog at all.
//
// A case whose folder owner is undecided comes back as { needsFolderOwner: true }
// with nothing copied, exactly like generating a document into it, so the
// renderer can ask which client's folder the case belongs in and try again.
// An add that cannot happen at all (deleted case, not a client on it) comes
// back as { error } — also with nothing copied, so the renderer can hand the
// files back. A THROW means a copy failed partway, and some may have landed.
function addClientDocumentFiles(personId, filePaths, opts = {}) {
  const refusal = uploadRefusal(personId, opts.matterId || null) || rootRefusal();
  if (refusal) return { error: refusal };
  let dir;
  try {
    dir = clientUploadDir(personId, opts.matterId || null);
  } catch (err) {
    if (err && err.code === 'NEEDS_FOLDER_OWNER') return { needsFolderOwner: true };
    if (err && err.code === 'ROOT_MISSING') return { error: err.message };
    throw err;
  }
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  const now = new Date().toISOString();
  for (const src of filePaths || []) {
    if (!src || !fs.existsSync(src)) continue;
    const original = path.basename(src);
    const filename = uniqueName(dir, sanitizeSegment(original, 'Document'));
    fs.copyFileSync(src, path.join(dir, filename));
    const info = db.prepare(
      `INSERT INTO client_documents
         (person_id, matter_id, filename, original_name, label, doc_date, added_at, stored_dir)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(personId, opts.matterId || null, filename, original,
      opts.label || null, opts.docDate || null, now, storePath(dir));
    files.push({ id: info.lastInsertRowid, filename, original_name: original });
    logActivity({
      matterId: opts.matterId || null, personId,
      eventType: 'document_attached', description: `Attached: ${original}`
    });
  }
  return { canceled: false, dir, files };
}

// Versioned output. Regenerating identical content reuses the existing file
// instead of littering the folder with copies; genuinely changed content becomes
// "... v2", never overwriting what came before.
//
// `source` is the input the document was built from (HTML string or block JSON),
// not the output bytes — PDFs embed a creation timestamp, so output bytes differ
// on every run even when nothing actually changed.
function resolveOutputPath(matter, docType, docTypeLabel, extension, source) {
  // A packet is one filing: its documents go in their own folder, frozen the
  // same way a matter's is (ground rule 0.5).
  const dir = getPacketDir(matter) || getMatterDir(matter);
  // RENDER_VERSION is folded in so a rendering code change invalidates every
  // previously "unchanged" file, not just ones whose input data changed.
  const hash = crypto.createHash('sha256').update(`v${RENDER_VERSION}:${String(source)}`).digest('hex');

  // generated_files is keyed on (matter_id, doc_type, format). Two packets on
  // the same matter contain the SAME doc types, so without qualifying the key
  // the second packet's transmittal letter would match the first packet's row
  // and, if the content happened to be identical, be handed back a path
  // pointing into the wrong packet's folder.
  const key = (matter && matter.packet && matter.packet.id)
    ? `${docType}@packet${matter.packet.id}`
    : docType;

  const prior = db.prepare(
    `SELECT path, content_hash FROM generated_files
     WHERE matter_id = ? AND doc_type = ? AND format = ?
     ORDER BY id DESC LIMIT 1`
  ).get(matter.id, key, extension);

  const priorPath = prior && loadPath(prior.path);
  if (prior && prior.content_hash === hash && fs.existsSync(priorPath)) {
    return { outputPath: priorPath, unchanged: true, hash };
  }

  // Lead with the matter name: once a file is emailed, e-filed or otherwise
  // out of its folder, the filename is all that identifies which case it's
  // for — "2026-08-18 Notice of Hearing.pdf" tells the user nothing on its own.
  const dateStr = new Date().toISOString().split('T')[0];
  const matterPart = sanitizeSegment(matter && matter.short_name ? matter.short_name : '', '');
  // Inside a packet the documents are numbered, so the folder lists itself in
  // filing order — the order they go in the envelope.
  const seq = (matter && matter.packet && matter.packet.sort_order != null)
    ? `${String(matter.packet.sort_order + 1).padStart(2, '0')} - `
    : '';
  const base = matterPart
    ? `${seq}${matterPart} - ${sanitizeSegment(docTypeLabel, 'Document')} - ${dateStr}`
    : `${seq}${sanitizeSegment(docTypeLabel, 'Document')} - ${dateStr}`;

  // fitPath trims the file-name stem if the whole path would pass Windows'
  // limit — in both the first try and every "v2..." retry, so a long name
  // cannot sneak past it on the second version.
  let outputPath = F.fitPath(dir, base, '', extension);
  let version = 2;
  while (fs.existsSync(outputPath)) {
    outputPath = F.fitPath(dir, base, ` v${version}`, extension);
    version++;
  }
  return { outputPath, unchanged: false, hash };
}

// The three handlers that write into a case folder call this instead of
// resolveOutputPath directly: a case whose folder owner is still undecided
// comes back as { needsFolderOwner: true } (nothing written, nothing frozen)
// so the renderer can ask which client it belongs to, then try again. A
// documents folder that is not available comes back as { error } — checked
// FIRST, so nobody is asked a folder question for a save that cannot happen.
function resolveOutputPathOrAsk(...args) {
  const refusal = rootRefusal();
  if (refusal) return { error: refusal };
  try {
    return resolveOutputPath(...args);
  } catch (err) {
    if (err && err.code === 'NEEDS_FOLDER_OWNER') return { needsFolderOwner: true };
    if (err && err.code === 'ROOT_MISSING') return { error: err.message };
    throw err;
  }
}

// A6's activity log. Real events only — see migration 31.
function logActivity({ matterId = null, personId = null, eventType, description }) {
  db.prepare(
    `INSERT INTO activity_log (matter_id, person_id, event_type, description, created_at)
     VALUES (?,?,?,?,?)`
  ).run(matterId, personId, eventType, description, new Date().toISOString());
}

function recordGenerated(matter, docType, extension, hash, outputPath) {
  // Must use the same qualified key resolveOutputPath() looked up with, or the
  // reuse check can never match its own row again.
  const key = (matter && matter.packet && matter.packet.id)
    ? `${docType}@packet${matter.packet.id}`
    : docType;
  db.prepare(
    `INSERT INTO generated_files (matter_id, doc_type, format, content_hash, path, created_at)
     VALUES (?,?,?,?,?,?)`
  ).run(matter.id, key, extension, hash, storePath(outputPath), new Date().toISOString());
  // A document generated as part of a packet is logged once for the whole
  // packet by the renderer (generatePacket()), not once per document here.
  if (!(matter && matter.packet)) {
    logActivity({
      matterId: matter.id, eventType: 'document_generated',
      description: `Generated ${docType} (${extension.toUpperCase()})`
    });
  }
}

ipcMain.handle('generate-pdf', async (e, htmlContent, matter, docTypeLabel, docType) => {
  const resolved =
    resolveOutputPathOrAsk(matter, docType || docTypeLabel, docTypeLabel, 'pdf', htmlContent);
  if (resolved.needsFolderOwner) return { needsFolderOwner: true };
  if (resolved.error) return { error: resolved.error };
  const { outputPath, unchanged, hash } = resolved;
  if (unchanged) return { path: outputPath, stored: storePath(outputPath), unchanged: true };

  // Rendering to PDF needs no scripting, so turn it off: even if some field
  // slipped through unescaped, there is nothing left to execute it.
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, contextIsolation: true, nodeIntegration: false }
  });
  const cssPath = path.join(__dirname, 'print.css');
  let cssContent = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';

  const fullHtml = `<!DOCTYPE html><html><head><style>${cssContent}</style></head><body><div id="print-container">${htmlContent}</div></body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);

  // Page numbers use Chromium's native footer, which needs real margins to
  // render into — margins moved here from print.css's @page rule (now just
  // `size: letter`), at the same 1in on every side, so the printed content
  // sits exactly where it did before. The footer then draws inside that
  // existing 1in band; nothing about the content area changes.
  const data = await win.webContents.printToPDF({
    printBackground: true, pageSize: 'Letter', margins: { top: 1, bottom: 1, left: 1, right: 1 },
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate:
      `<div style="width:100%; text-align:center; font-family:'Times New Roman', Times, serif; font-size:10pt; color:#000;">` +
      `<span class="pageNumber"></span></div>`
  });
  fs.writeFileSync(outputPath, data);
  win.close();
  recordGenerated(matter, docType || docTypeLabel, 'pdf', hash, outputPath);
  return { path: outputPath, stored: storePath(outputPath), unchanged: false };
});

// Word export. This mirrors DocumentEngine.renderHtml block-for-block — every
// block type the templates emit must be handled here, or it silently vanishes
// from the .docx while still showing up in the PDF.
ipcMain.handle('generate-docx', async (e, blocks, matter, attorney, docTypeLabel, docType) => {
  // The hash source must be everything the .docx is built FROM, which is not
  // just the blocks. A block like { type: 'district_caption' } carries no
  // content at all — the court header, case number, judge, party names,
  // caption notes and signature are all resolved from `matter` / `attorney`
  // down in this handler. Hashing the blocks alone therefore made every one of
  // those invisible to the "unchanged, reuse the file" check: editing a
  // matter's caption notes and regenerating Word handed back the OLD .docx and
  // reported "No changes — reusing", while the PDF (whose hash is the fully
  // rendered HTML) updated correctly. Found by the caption-note smoke check on
  // 2026-08-19. Same failure mode as RENDER_VERSION above, one level down: the
  // hash has to see everything that can change the output.
  // matter.output_dir is left out: it is folder bookkeeping, not content, and
  // its stored form differs between machines (and flipped from null to a
  // value on a matter's first save), which would defeat the reuse check.
  const { output_dir: _folder, ...matterContent } = matter || {};
  const source = JSON.stringify({ blocks, matter: matterContent, attorney });
  const resolved =
    resolveOutputPathOrAsk(matter, docType || docTypeLabel, docTypeLabel, 'docx', source);
  if (resolved.needsFolderOwner) return { needsFolderOwner: true };
  if (resolved.error) return { error: resolved.error };
  const { outputPath, unchanged, hash } = resolved;
  if (unchanged) return { path: outputPath, stored: storePath(outputPath), unchanged: true };
  const {
    Document, Packer, Paragraph, TextRun, AlignmentType,
    PageBreak, Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun,
    TableLayoutType, Footer, PageNumber
  } = require('docx');

  const FONT = 'Times New Roman';
  const SIZE = 24; // half-points => 12pt
  const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  // insideHorizontal / insideVertical are NOT optional here. Omitting them
  // does not mean "no inside borders": docx emits a <w:tblBorders> element
  // with only the four outer edges set, and Word's default for the inside
  // edges of a bordered table is a single black rule. So every caption
  // printed with a visible vertical line between the party column and the
  // case-number column, and a box around the whole thing — in the .docx
  // only, since the PDF is rendered from CSS that has no such borders. The
  // filed documents have a hairline rule under the caption ending in "/",
  // never a box (caption rule, not a border). Found 2026-08-19 by rendering the
  // .docx rather than trusting the PDF.
  // A cell has only four edges; the inside pair belongs to the table.
  const NO_CELL_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE };
  const NO_BORDERS = { ...NO_CELL_BORDERS, insideHorizontal: NONE, insideVertical: NONE };
  // Letter page (12240 twips) minus 1440-twip margins on each side = 9360
  // twips of content width. docx's Table falls back to a ~100-twip tblGrid
  // when columnWidths is omitted, which some readers (Pages, LibreOffice)
  // honor over the percentage widths, squeezing every cell to one
  // character per line. Always pass explicit widths.
  //
  // The widths are only binding with TableLayoutType.FIXED. Without it Word
  // auto-fits columns to their content, so the identical caption rendered
  // 55/45 for a long party name ("PEOPLE OF THE STATE OF MICHIGAN") and
  // collapsed to roughly 25/75 for a short one ("Ann Applicant") — the case
  // number column sliding left across the page from one matter to the next.
  // Found 2026-08-19 by rendering the .docx for a short-named party.
  // A visible hairline, for the one thing in this app that is a form rather
  // than a filing: the blank intake questionnaire's prior-record grid.
  const THIN_RULE = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
  const CAPTION_COLUMN_WIDTHS = [5148, 4212]; // 55% / 45%
  const COUNSEL_COLUMN_WIDTHS = [4680, 4680]; // 50% / 50%

  const att = attorney || {};
  const parties = Array.isArray(matter.parties) ? matter.parties : [];
  const bySide = (side) => parties
    .filter(p => p.side === side)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  // Mirrors document-engine.js's partyCaptionNames()/partyCaptionText()
  // (ground rule 0.2) — same three-state caption_style handling: 'full'
  // (every party) | 'et_al' (collapse to "FirstName, et al." once count > 1)
  // | 'et_al_force' (always "FirstName, et al.", even with one named party).
  const partyCaptionNames = (side, style) => {
    const p = bySide(side);
    if (p.length === 0) return [];
    if (style === 'et_al_force') return [`${p[0].name}, et al.`];
    if (style === 'full') return p.map(x => x.name);
    return p.length > 1 ? [`${p[0].name}, et al.`] : [p[0].name];
  };
  const partyCaptionText = (side, style) => {
    const names = partyCaptionNames(side, style);
    if (names.length === 0) return side === 'plaintiff' ? 'Plaintiff' : 'Defendant';
    return names.join(', ');
  };

  const run = (text, opts = {}) => new TextRun({ text, font: FONT, size: SIZE, ...opts });

  // Scanned signature, stored on the attorney record as a data: URI. Returns []
  // when there is none, so callers can spread it unconditionally.
  const signatureImageParagraphs = (indentTwips) => {
    const uri = att.signature_image;
    if (!uri || typeof uri !== 'string') return [];
    const m = /^data:(image\/(png|jpeg));base64,(.*)$/.exec(uri);
    if (!m) return [];
    try {
      return [new Paragraph({
        children: [new ImageRun({
          data: Buffer.from(m[3], 'base64'),
          type: m[2] === 'png' ? 'png' : 'jpg',
          transformation: { width: 180, height: 50 }
        })],
        indent: indentTwips ? { left: indentTwips } : undefined
      })];
    } catch (e) {
      console.error('Signature image could not be embedded:', e.message);
      return [];
    }
  };

  // One paragraph per line, so embedded newlines survive as real line breaks.
  const lines = (text, opts = {}) => String(text == null ? '' : text)
    .split('\n')
    .map(line => new Paragraph({ children: [run(line, opts.runOpts)], spacing: { line: 240 }, ...opts.paraOpts }));

  const children = [];

  // Role word under a party name in the legacy caption. Mirrors
  // legacyRoleWord() in document-engine.js: the matter's own label wins, so
  // this caption can no longer say "Defendant" while the signature block on
  // the same page says "Attorney for Respondent". Plurals are kept for the
  // untouched defaults only.
  // OUR side's role word ("Attorney for …"): follows matters.client_role, so
  // a prosecuting client signs for the plaintiff. Anything but 'plaintiff' is
  // the defense side, as before. Mirrors ourRoleWords() in document-engine.js.
  // The caption's label under the defendant stays matter.party_label.
  const ourRoleLabel = matter.client_role === 'plaintiff'
    ? (matter.plaintiff_label || 'Plaintiff')
    : (matter.party_label || 'Defendant');

  const legacyRoleWord = (side) => {
    const label = side === 'plaintiff'
      ? (matter.plaintiff_label || 'Plaintiff')
      : (matter.party_label || 'Defendant');
    const count = bySide(side).length;
    if (count > 1 && (label === 'Plaintiff' || label === 'Defendant')) return `${label}s`;
    return label;
  };

  // Counsel block lines with the empty ones dropped. Mirrors counselLines()
  // in document-engine.js. This used to interpolate the fields directly, so a
  // missing bar number printed "(undefined)" and a missing email printed
  // "undefined | undefined" into a filed document.
  // The stacked name lines at the top of a counsel block: the signing attorney
  // first, then the matter's additional counsel of record. The role/office/
  // address/contact lines below are shared — the filed example stacks two
  // names over ONE office line rather than repeating the firm. De-duplicated
  // against the signing attorney by id and by name, because the signer is
  // chosen per document while the list lives on the matter, so the same person
  // is easily in both. Mirrors counselNameLines() in document-engine.js.
  const counselNameLines = (a, coCounsel) => {
    const at = a || {};
    const nameOf = (x) => [x.name, x.bar_number ? `(${x.bar_number})` : ''].filter(Boolean).join(' ');
    const primary = nameOf(at);
    const seenNames = new Set([String(at.name || '').trim().toLowerCase()].filter(Boolean));
    const extras = [];
    (Array.isArray(coCounsel) ? coCounsel : []).forEach((c) => {
      if (!c) return;
      if (at.id != null && c.id != null && c.id === at.id) return;
      const key = String(c.name || '').trim().toLowerCase();
      if (!key || seenNames.has(key)) return;
      seenNames.add(key);
      extras.push(nameOf(c));
    });
    return [primary, ...extras].filter(Boolean);
  };

  const counselLines = (a, roleLabel, coCounsel) => {
    const at = a || {};
    const contact = [at.firm_phone, at.firm_email].filter(Boolean).join(' | ');
    return [
      ...counselNameLines(at, coCounsel),
      roleLabel ? `Attorney for ${roleLabel}` : '',
      at.firm_name || '',
      ...String(at.firm_address || '').split('\n'),
      contact
    ].map(l => String(l == null ? '' : l).trim()).filter(Boolean);
  };

  const pushCaption = () => {
    const plRole = legacyRoleWord('plaintiff');
    const defRole = legacyRoleWord('defendant');
    const partyLines = (side) => partyCaptionNames(side, matter.caption_style)
      .map(name => `${name},`);

    children.push(new Paragraph({
      children: [run('STATE OF MICHIGAN', { bold: true })],
      alignment: AlignmentType.CENTER, spacing: { after: 60 }
    }));
    children.push(new Paragraph({
      children: [run(courtHeaderLine(), { bold: true })],
      alignment: AlignmentType.CENTER, spacing: { after: 240 }
    }));

    const left = [
      ...partyLines('plaintiff').map(t => new Paragraph({ children: [run(t)] })),
      new Paragraph({ children: [run(`${plRole},`)], spacing: { after: 120 } }),
      new Paragraph({ children: [run('vs.')], indent: { left: 720 }, spacing: { after: 120 } }),
      ...partyLines('defendant').map(t => new Paragraph({ children: [run(t)] })),
      new Paragraph({ children: [run(`${defRole}.`)] }),
    ];
    const right = [
      new Paragraph({ children: [run(`Case No. ${matter.case_number && !matter.case_number_pending ? matter.case_number : '____________'}`)], spacing: { after: 240 } }),
      new Paragraph({ children: [run(`Hon. ${matter.judge_name || '____________'}`)] }),
      ...captionNoteLines().map(t => new Paragraph({ children: [run(t)] })),
    ];

    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: CAPTION_COLUMN_WIDTHS,
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      rows: [new TableRow({
        children: [
          new TableCell({ width: { size: 55, type: WidthType.PERCENTAGE }, borders: { ...NO_CELL_BORDERS, right: { style: BorderStyle.SINGLE, size: 6, color: '000000' } }, children: left }),
          new TableCell({ width: { size: 45, type: WidthType.PERCENTAGE }, borders: NO_CELL_BORDERS, children: right }),
        ]
      })]
    }));

    // The rule under the caption block.
    children.push(new Paragraph({
      text: '', spacing: { before: 120, after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' } }
    }));

    children.push(...lines(
      counselLines(att, matter.client_role === 'plaintiff' ? plRole : defRole, matter.co_counsel).join('\n')
    ));
    children.push(new Paragraph({ text: '', spacing: { after: 240 } }));
  };

  const pushSignature = () => {
    children.push(new Paragraph({ children: [run('Date: _______________')], spacing: { before: 360, after: 240 } }));
    // Bare bar number in a signature block — brackets belong to the counsel
    // block at the top of the page (decision 6, 2026-08-18). This printed
    // "(P12345)" while the PDF engine printed "P12345" for the same document.
    // Mirrors signatureLines() in document-engine.js.
    children.push(...lines(
      [`/s/ ${att.name || ''}`.trim(),
       [att.name, att.bar_number].filter(Boolean).join(' '),
       att.firm_name || '',
       ...String(att.firm_address || '').split('\n'),
       att.firm_phone || '',
       att.firm_email || ''
      ].map(l => String(l == null ? '' : l).trim()).filter(Boolean).join('\n'),
      { paraOpts: { indent: { left: 4320 } } }
    ));
  };

  const pushFreeText = (text) => {
    String(text == null ? '' : text)
      .split('\n\n')
      .map(p => p.trim())
      .filter(p => p.length > 0)
      .forEach(para => {
        children.push(new Paragraph({
          children: para.split('\n').flatMap((line, i) => i === 0 ? [run(line)] : [run('', { break: 1 }), run(line)]),
          spacing: { line: 480 }, indent: { firstLine: 720 }
        }));
      });
  };

  // District court caption, matching the filed appearances: authority over
  // "Plaintiff" at left, case number / judge / notes stacked right, vs. between the
  // parties, then the "/" closer.
  // Mirrors courtHeaderLine() in document-engine.js. The two renderers are fed
  // from the same blocks but are separate engines; if this drifts, Word and PDF
  // print different court names.
  const courtHeaderLine = () => {
    const stored = (matter.court_header_line || '').trim();
    if (stored) return stored;
    return matter.court_name ? `IN THE ${matter.court_name}` : 'IN THE [COURT]';
  };

  // The caption's free note lines, in order. Mirrors captionNoteLines() in
  // document-engine.js — same drift warning as courtHeaderLine above.
  // matter.charges is the retired pre-migration-12 column, read only so that
  // a document whose matter_snapshot predates the caption-note table still
  // regenerates with its notes.
  const captionNoteLines = () => {
    if (Array.isArray(matter.caption_notes)) {
      return matter.caption_notes
        .map(n => String(n && n.note_text != null ? n.note_text : n).trim())
        .filter(Boolean);
    }
    return String(matter.charges || '').split('\n').map(s => s.trim()).filter(Boolean);
  };

  // The authority above "Plaintiff": per-case override, then the case type's.
  // Each is trimmed BEFORE falling through, so a whitespace-only override
  // yields to the type's authority. Mirrors captionAuthority() in
  // document-engine.js (it used to trim after the ||, skipping the type).
  const captionAuthority = () => String(matter.caption_authority || '').trim()
    || String(matter.type_caption_authority || '').trim();

  // The plaintiff line when there is no caption authority. partyCaptionText
  // never returns empty (it falls back to a bare "Plaintiff"), so the
  // "[PLAINTIFF]" blank has to be chosen on the party count, the same way
  // "[DEFENDANT]" is. Mirrors plaintiffCaptionText() in document-engine.js.
  const plaintiffCaptionText = () => bySide('plaintiff').length
    ? partyCaptionText('plaintiff', matter.caption_style)
    : '[PLAINTIFF]';

  const pushDistrictCaption = () => {
    const label = matter.party_label || 'Defendant';
    const plLabel = matter.plaintiff_label || 'Plaintiff';
    const authority = captionAuthority() || plaintiffCaptionText();
    const defendants = bySide('defendant');
    const defendantText = defendants.length
      ? partyCaptionText('defendant', matter.caption_style)
      : '[DEFENDANT]';

    children.push(new Paragraph({
      children: [run('STATE OF MICHIGAN', { bold: true })],
      alignment: AlignmentType.CENTER, spacing: { after: 60 }
    }));
    children.push(new Paragraph({
      children: [run(courtHeaderLine(), { bold: true })],
      alignment: AlignmentType.CENTER, spacing: { after: 300 }
    }));

    // Case number, judge, then the free note lines.
    // Must match renderDistrictCaption() in document-engine.js.
    const rightLines = [];
    if (matter.case_number && !matter.case_number_pending) rightLines.push(`Case No. ${matter.case_number}`);
    if (matter.judge_name) rightLines.push(`Hon. ${matter.judge_name}`);
    rightLines.push(...captionNoteLines());

    // Bold is names only: party names yes, role words and identifiers no.
    const left = [
      new Paragraph({ children: [run(authority.toUpperCase(), { bold: true })] }),
      new Paragraph({ children: [run(plLabel)], indent: { left: 1440 } }),
      new Paragraph({ children: [run('vs.')], indent: { left: 720 }, spacing: { before: 240, after: 240 } }),
      new Paragraph({ children: [run(defendantText.toUpperCase(), { bold: true })] }),
      new Paragraph({ children: [run(label)], indent: { left: 1440 } }),
    ];
    const right = rightLines.length
      ? rightLines.map(t => new Paragraph({ children: [run(t)] }))
      : [new Paragraph({ text: '' })];

    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: CAPTION_COLUMN_WIDTHS,
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      rows: [new TableRow({
        children: [
          new TableCell({ width: { size: 55, type: WidthType.PERCENTAGE }, borders: NO_CELL_BORDERS, children: left }),
          new TableCell({ width: { size: 45, type: WidthType.PERCENTAGE }, borders: NO_CELL_BORDERS, children: right }),
        ]
      })]
    }));

    pushRuleSlash(360);
  };

  const pushAppearanceSignature = (dated, noBarNumber) => {
    const label = ourRoleLabel;
    // Bare bar number in a signature block; brackets belong to the counsel
    // block at the top of the page. Name line bold, the rest plain.
    // noBarNumber drops it entirely: the filed proof of service signs with
    // the name and office line only.
    const nameLine = noBarNumber
      ? (att.name || '').toUpperCase()
      : `${(att.name || '').toUpperCase()} ${att.bar_number || ''}`.trim();
    const restText = (noBarNumber
      ? [att.firm_name || '']
      : [
          `Attorney for ${label}`,
          att.firm_address || '',
          att.firm_phone || ''
        ]).filter(Boolean).join('\n');
    children.push(new Paragraph({ text: '', spacing: { before: 720 } }));
    children.push(...signatureImageParagraphs(4320));
    // "Date:" above the rule, inside the signature block. Mirrors
    // renderAppearanceSignature() in document-engine.js — decision 7.
    if (dated) {
      children.push(new Paragraph({
        children: [run(`Date: ${dated}`)], indent: { left: 4320 }
      }));
    }
    children.push(new Paragraph({
      children: [run('_____________________________')],
      indent: { left: 4320 }
    }));
    children.push(new Paragraph({
      children: [run(nameLine, { bold: true })], indent: { left: 4320 }
    }));
    children.push(...lines(restText, { paraOpts: { indent: { left: 4320 } } }));
  };

  // Appellate caption: compound roles, one Case No./Hon. block per court, then
  // both counsel blocks side by side between two rules.
  const pushAppellateCaption = () => {
    const plLabel = matter.plaintiff_label || 'Plaintiff';
    const defLabel = matter.party_label || 'Defendant';
    const authority = captionAuthority() || plaintiffCaptionText();
    const defendants = bySide('defendant');
    const defendantText = defendants.length ? partyCaptionText('defendant', matter.caption_style) : '[DEFENDANT]';

    const caseRows = (Array.isArray(matter.cases) && matter.cases.length
      ? matter.cases
      : [{ case_number: matter.case_number, judge_name: matter.judge_name }]
    ).filter(c => c.case_number || c.judge_name);

    children.push(new Paragraph({
      children: [run('STATE OF MICHIGAN', { bold: true })],
      alignment: AlignmentType.CENTER, spacing: { after: 60 }
    }));
    children.push(new Paragraph({
      children: [run(courtHeaderLine(), { bold: true })],
      alignment: AlignmentType.CENTER, spacing: { after: 300 }
    }));

    const right = [];
    caseRows.forEach(c => {
      right.push(new Paragraph({ children: [run(`Case No. ${c.case_number && !matter.case_number_pending ? c.case_number : '____________'}`)] }));
      right.push(new Paragraph({ children: [run(`Hon. ${c.judge_name || '____________'}`)], spacing: { after: 240 } }));
    });
    // Note stack at the foot of the identifier column, as in the HTML.
    captionNoteLines().forEach(t => right.push(new Paragraph({ children: [run(t)] })));
    if (!right.length) right.push(new Paragraph({ text: '' }));

    const left = [
      new Paragraph({ children: [run(`${authority.toUpperCase()},`)] }),
      new Paragraph({ children: [run(`${plLabel},`)] }),
      new Paragraph({ children: [run('vs.')], indent: { left: 720 }, spacing: { before: 360, after: 360 } }),
      new Paragraph({ children: [run(`${defendantText.toUpperCase()},`)] }),
      new Paragraph({ children: [run(`${defLabel},`)] }),
    ];

    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: CAPTION_COLUMN_WIDTHS,
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      rows: [new TableRow({
        children: [
          new TableCell({ width: { size: 55, type: WidthType.PERCENTAGE }, borders: NO_CELL_BORDERS, children: left }),
          new TableCell({ width: { size: 45, type: WidthType.PERCENTAGE }, borders: NO_CELL_BORDERS, children: right }),
        ]
      })]
    }));

    const ourLabel = matter.client_role === 'plaintiff' ? plLabel : defLabel;
    const theirLabel = matter.client_role === 'plaintiff' ? defLabel : plLabel;
    const ours = matter.our_counsel || {};
    const theirs = matter.opposing_counsel_person || {};
    // Mirrors the HTML: never print a bare "Attorney for X" under an empty block.
    const counselCell = (c, roleLabel, fallbackText, coCounsel) => {
      const hasPerson = c && (c.name || c.firm_name);
      const nameLines = hasPerson
        ? (coCounsel ? counselNameLines(c, coCounsel) : (c.name ? [`${c.name}${c.bar_number ? ` (${c.bar_number})` : ''}`] : []))
        : [];
      const text = hasPerson
        ? [
            c.firm_name || '',
            ...nameLines,
            roleLabel ? `Attorney for ${roleLabel}` : '',
            ...(String(c.address || '').split('\n')),
            c.phone || '', c.email || ''
          ].filter(Boolean).join('\n')
        : String(fallbackText || '').trim();
      return text ? lines(text) : [new Paragraph({ text: '' })];
    };

    children.push(new Paragraph({
      text: '', border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' } },
      spacing: { before: 120, after: 120 }
    }));
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: COUNSEL_COLUMN_WIDTHS,
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      rows: [new TableRow({
        children: [
          new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, borders: NO_CELL_BORDERS, children: counselCell(ours, ourLabel, null, matter.co_counsel) }),
          new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, borders: NO_CELL_BORDERS, children: counselCell(theirs, theirLabel, matter.opposing_counsel) }),
        ]
      })]
    }));
    children.push(new Paragraph({
      text: '', border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' } },
      spacing: { before: 120, after: 240 }
    }));
  };

  // Personal letterhead (spec §09) as a two-column borderless table: name
  // and "Attorney at Law" bold at left, address/phone right-aligned. A
  // structurally different layout from the city letterhead below, not a
  // variant of it — no seal, no side names. Mirrors renderPersonalLetterhead()
  // in document-engine.js.
  const pushPersonalLetterhead = (lh) => {
    const split = (s) => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
    const left = [
      new Paragraph({ children: [run(lh.masthead || '', { bold: true, size: 32 })] }),
      ...split(lh.office_lines).map(l => new Paragraph({ children: [run(l, { bold: true })] }))
    ];
    const right = [
      ...split(lh.address).map(l => new Paragraph({ children: [run(l, { bold: true })], alignment: AlignmentType.RIGHT })),
    ];
    const contact = [lh.phone ? `Telephone: ${lh.phone}` : '', lh.fax ? `Facsimile: ${lh.fax}` : ''].filter(Boolean);
    contact.forEach(l => right.push(new Paragraph({ children: [run(l, { bold: true })], alignment: AlignmentType.RIGHT })));
    if (!right.length) right.push(new Paragraph({ text: '' }));

    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [4680, 4680],
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      rows: [new TableRow({
        children: [
          new TableCell({ borders: NO_CELL_BORDERS, children: left }),
          new TableCell({ borders: NO_CELL_BORDERS, children: right }),
        ]
      })]
    }));
    children.push(new Paragraph({ text: '', spacing: { after: 360 } }));
  };

  // City letterhead as a three-column borderless table: the office's other
  // attorneys down the left, masthead and address centered, seal at the right.
  // Every value is stored letterhead data — the app must never carry one
  // municipality's branding in its source.
  const pushLetterhead = () => {
    const lh = matter.letterhead;
    if (!lh) {
      children.push(new Paragraph({
        children: [run('[NO LETTERHEAD SELECTED]', { bold: true })],
        alignment: AlignmentType.CENTER, spacing: { after: 360 }
      }));
      return;
    }
    if (lh.kind === 'personal') { pushPersonalLetterhead(lh); return; }
    const split = (s) => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
    const sideCell = split(lh.side_names).map(l => new Paragraph({
      children: [run(l, { size: 16 })], spacing: { line: 200 }
    }));
    const center = [];
    if (lh.masthead) {
      center.push(new Paragraph({
        children: [run(lh.masthead, { bold: true, size: 40 })], alignment: AlignmentType.CENTER
      }));
    }
    split(lh.office_lines).forEach(l => center.push(new Paragraph({
      children: [run(l, { bold: true, size: 20 })], alignment: AlignmentType.CENTER
    })));
    split(lh.address).forEach(l => center.push(new Paragraph({
      children: [run(l, { size: 20 })], alignment: AlignmentType.CENTER
    })));
    const contact = [lh.phone, lh.fax ? `FAX ${lh.fax}` : ''].filter(Boolean).join('  /  ');
    if (contact) center.push(new Paragraph({
      children: [run(contact, { size: 18 })], alignment: AlignmentType.CENTER
    }));

    const sealCell = [];
    if (lh.seal_image) {
      try {
        const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(String(lh.seal_image));
        if (m) {
          sealCell.push(new Paragraph({
            children: [new ImageRun({
              data: Buffer.from(m[2], 'base64'),
              transformation: { width: 65, height: 65 }
            })],
            alignment: AlignmentType.RIGHT
          }));
        }
      } catch (e) {
        console.error('Letterhead seal could not be embedded:', e.message);
      }
    }
    if (!sealCell.length) sealCell.push(new Paragraph({ text: '' }));
    if (!sideCell.length) sideCell.push(new Paragraph({ text: '' }));

    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [2160, 5760, 1440],
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      rows: [new TableRow({
        children: [
          new TableCell({ borders: NO_CELL_BORDERS, children: sideCell }),
          new TableCell({ borders: NO_CELL_BORDERS, children: center }),
          new TableCell({ borders: NO_CELL_BORDERS, children: sealCell }),
        ]
      })]
    }));
    children.push(new Paragraph({ text: '', spacing: { after: 360 } }));
  };

  // Indented RE: block. Subject lines bold; the second line is also italic by
  // default (the C&D case-name line). `plain` (the driver-license letter's
  // name/license/DOB block) suppresses that. Mirrors renderReBlock() in
  // document-engine.js.
  const pushReBlock = (reLines, plain) => {
    const rows = (reLines || []).filter(Boolean);
    if (!rows.length) return;
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [1584, 7776],
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      rows: [new TableRow({
        children: [
          new TableCell({ borders: NO_CELL_BORDERS, children: [
            new Paragraph({ children: [run('RE:', { bold: true })], indent: { left: 1080 } })
          ] }),
          new TableCell({ borders: NO_CELL_BORDERS, children: rows.map((l, i) =>
            new Paragraph({ children: [run(l, { bold: true, italics: !plain && i === 1 })] })
          ) }),
        ]
      })]
    }));
    children.push(new Paragraph({ text: '', spacing: { after: 200 } }));
  };

  // The fixed DAAD header plus the IN RE: identity block. Hardcoded text, not
  // a per-court header_line — there is exactly one Driver Assessment and
  // Appeal Division in Michigan. Client name comes from the matter's
  // defendant-side party (same convention every other caption uses); license
  // number and DOB are packet-scoped (migration 14). Mirrors
  // renderDaadCaption() in document-engine.js.
  const pushDaadCaption = (packet) => {
    ['STATE OF MICHIGAN', 'IN THE MICHIGAN DEPARTMENT OF STATE',
     'BUREAU OF DRIVER IMPROVEMENT', 'DRIVER LICENSE APPEAL DIVISION'
    ].forEach((t, i) => children.push(new Paragraph({
      children: [run(t, { bold: true })],
      alignment: AlignmentType.CENTER, spacing: { after: i === 3 ? 300 : 60 }
    })));

    const client = bySide('defendant')[0] || {};
    const name = (client.name || '[CLIENT NAME]').toUpperCase();
    const license = packet.client_license_number || '____________';
    const dob = packet.client_dob ? new Date(packet.client_dob + 'T12:00:00Z').toLocaleDateString() : '____________';

    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [1584, 7776],
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      rows: [new TableRow({
        children: [
          new TableCell({ borders: NO_CELL_BORDERS, children: [
            new Paragraph({ children: [run('IN RE:', { bold: true })] })
          ] }),
          new TableCell({ borders: NO_CELL_BORDERS, children: [
            new Paragraph({ children: [run(name, { bold: true })] }),
            new Paragraph({ children: [run(`Driver License No. ${license}`, { bold: true })] }),
            new Paragraph({ children: [run(`Date of Birth:  ${dob}`, { bold: true })] }),
          ] }),
        ]
      })]
    }));
    children.push(new Paragraph({ text: '', spacing: { after: 300 } }));
  };

  // ---- Stipulation and order (Phase 4) -------------------------------------
  // Each mirrors a render function in document-engine.js. Wording transcribed
  // from spec §08 and the filed exhibit; where the filed working file's own
  // formatting drifted from both (a bold run landed on the wrong words), the
  // spec/PDF win — see the build-plan's Phase 4 notes.

  // Bold lead-in only; the two date slots are underlined. The second slot is
  // always this literal phrase — nobody knows the new date at filing time, so
  // it is not a user-entered field. Mirrors renderStipulationClause().
  const pushStipulationClause = (hearingType, from, reason) => {
    children.push(new Paragraph({
      children: [
        run('IT IS HEREBY STIPULATED', { bold: true }),
        run(` by the parties hereto, by and through their attorneys, that the above ${hearingType} be adjourned from `),
        run(from, { underline: {} }),
        run(' to '),
        run('(date set by the court)', { underline: {} }),
        run(` for the reason that ${reason}.`)
      ],
      spacing: { line: 480, before: 240, after: 360 }
    }));
  };

  // Two attorneys side by side, closing the stipulation. Generic — carries no
  // stipulation-specific wording itself, only line data the doctype's build()
  // supplies, so it is reusable for any side-by-side counsel need. Same table
  // geometry as pushAppellateCaption's counsel-grid. Mirrors
  // renderDualSignature() in document-engine.js.
  const pushDualSignature = (block) => {
    const side = (s) => {
      const cell = [];
      // Built against s.attorney specifically, not the module-level `att` —
      // dual_signature is meant to be reusable for two attorneys at once,
      // and signatureImageParagraphs() only ever knows about the primary one.
      const sigUri = s.attorney && typeof s.attorney.signature_image === 'string' ? s.attorney.signature_image : null;
      const sigMatch = sigUri && /^data:(image\/(png|jpeg));base64,(.*)$/.exec(sigUri);
      if (s.sig) {
        cell.push(new Paragraph({ children: [run('/s/')], spacing: { after: 240 } }));
      } else if (sigMatch) {
        try {
          cell.push(new Paragraph({
            children: [new ImageRun({
              data: Buffer.from(sigMatch[3], 'base64'),
              type: sigMatch[2] === 'png' ? 'png' : 'jpg',
              transformation: { width: 180, height: 50 }
            })]
          }));
        } catch (e) {
          console.error('Dual signature image could not be embedded:', e.message);
          cell.push(new Paragraph({ text: '', spacing: { after: 240 } }));
        }
      } else {
        cell.push(new Paragraph({ text: '', spacing: { after: 240 } }));
      }
      cell.push(new Paragraph({
        text: '', border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' } },
        spacing: { after: 120 }
      }));
      (s.lines || []).forEach(l => cell.push(new Paragraph({
        children: [run(l.text || '', l.bold ? { bold: true } : {})]
      })));
      return cell;
    };
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: COUNSEL_COLUMN_WIDTHS,
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      rows: [new TableRow({
        children: [
          new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, borders: NO_CELL_BORDERS, children: side(block.left || {}) }),
          new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, borders: NO_CELL_BORDERS, children: side(block.right || {}) }),
        ]
      })]
    }));
    children.push(new Paragraph({ text: '', spacing: { after: 240 } }));
  };

  // The ORDER page's fixed preamble. Court name and city print exactly as
  // stored (never upper-cased), same rule as the header line. "DISTRICT
  // COURT JUDGE" is filed text from the one example in hand, a district
  // court — a circuit-court stipulation would need a filed example before
  // this literal string is trusted for it (rule 3). Mirrors
  // renderOrderSession() in document-engine.js.
  const pushOrderSession = () => {
    const courtName = matter.court_name || '[COURT]';
    const city = matter.court_city || '[CITY]';
    const county = matter.court_county || '[COUNTY]';
    const judge = matter.judge_name || '____________';
    const centered = (text) => new Paragraph({
      children: [run(text)], alignment: AlignmentType.CENTER, spacing: { after: 200 }
    });
    children.push(centered(`At a session of the ${courtName} held in the City of ${city}`));
    children.push(centered(`County of ${county}, State of Michigan`));
    children.push(new Paragraph({
      children: [run('On '), run('                              ', { underline: {} })],
      alignment: AlignmentType.CENTER, spacing: { after: 200 }
    }));
    children.push(centered('Present:'));
    children.push(centered(`HONORABLE  ${judge}`));
    children.push(centered('DISTRICT COURT JUDGE'));
  };

  // The FROM date must be the exact same string pushStipulationClause printed
  // on page 1 — the doctype's build() computes it once and passes it to both,
  // which is the actual fix for the two-different-dates defect the filed
  // working file demonstrates. The TO date is left genuinely blank; the
  // clerk fills it in by hand once the court sets a new date. Mirrors
  // renderOrderClause() in document-engine.js.
  const pushOrderClause = (hearingType, from) => {
    children.push(new Paragraph({
      children: [run('Upon reading and filing the above Stipulation and the Court being apprised of the premises;')],
      alignment: AlignmentType.CENTER, spacing: { line: 480, after: 240 }
    }));
    children.push(new Paragraph({
      children: [
        run('IT IS HEREBY ORDERED', { bold: true }),
        run(` that the above ${hearingType} be adjourned from `),
        run(from, { underline: {} }),
        run(' to '),
        run('              ', { underline: {} })
      ],
      alignment: AlignmentType.CENTER, spacing: { line: 480, after: 480 }
    }));
  };

  // The judge's own signature line: no bar number, no address. Centered,
  // unlike pushAppearanceSignature's left-indented block, but the same
  // literal-underscore rule convention. Mirrors renderJudgeSignature().
  const pushJudgeSignature = () => {
    children.push(new Paragraph({
      children: [run('_____________________________')],
      alignment: AlignmentType.CENTER, spacing: { before: 720, after: 120 }
    }));
    children.push(new Paragraph({
      children: [run('District Court Judge')],
      alignment: AlignmentType.CENTER
    }));
  };

  // The memo's four-row label block: labels in a fixed left column, values in
  // a second. A value may run to several lines.
  const pushMemoLabels = (rows) => {
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [1296, 8064],
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      rows: (rows || []).map(r => new TableRow({
        children: [
          new TableCell({ borders: NO_CELL_BORDERS, children: [
            new Paragraph({ children: [run(r.label || '')], spacing: { after: 160 } })
          ] }),
          new TableCell({ borders: NO_CELL_BORDERS, children:
            String(r.value || '').split('\n').map((v, i) => new Paragraph({
              children: [run(v, (r.emphasizeFrom != null && i >= r.emphasizeFrom)
                ? { bold: true, italics: true } : undefined)],
              spacing: { after: 160 }
            }))
          }),
        ]
      }))
    }));
    children.push(new Paragraph({ text: '', spacing: { after: 200 } }));
  };

  // The seized item(s), bold and indented, printed verbatim. One per line.
  const pushItemLine = (text) => {
    const list = String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!list.length) {
      children.push(new Paragraph({
        children: [run('[NO ITEM DESCRIBED]', { bold: true })], indent: { left: 720 }
      }));
      return;
    }
    list.forEach(l => children.push(new Paragraph({
      children: [run(l, { bold: true })], indent: { left: 720 }, spacing: { before: 160, after: 160 }
    })));
  };

  // Proof of service whose document list is derived from the packet.
  const pushPosDerived = (b) => {
    const venue = [
      ['STATE OF MICHIGAN', ')'],
      ['SS', ')'],
      [`COUNTY OF ${(b.county || '').toUpperCase() || '____________'}`, ')']
    ];
    children.push(new Table({
      width: { size: 60, type: WidthType.PERCENTAGE },
      columnWidths: [3240, 720],
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      rows: venue.map(([l, r], i) => new TableRow({
        children: [
          new TableCell({ borders: NO_CELL_BORDERS, children: [new Paragraph({
            children: [run(l, { bold: true })],
            alignment: i === 1 ? AlignmentType.RIGHT : AlignmentType.LEFT
          })] }),
          new TableCell({ borders: NO_CELL_BORDERS, children: [new Paragraph({ children: [run(r)] })] }),
        ]
      }))
    }));
    children.push(new Paragraph({
      children: [run('The undersigned party hereby certifies that he has served copies of the following documents:')],
      spacing: { before: 240, after: 200 }
    }));
    (b.documents || []).filter(Boolean).forEach(d => children.push(new Paragraph({
      children: [run(d, { bold: true })], indent: { left: 504 }
    })));
    children.push(new Paragraph({
      children: [run('TO:', { bold: true }), run(`  ${b.to || '____________'}`)],
      spacing: { before: 240, after: 160 }
    }));
    children.push(new Paragraph({
      children: [run('ON:', { bold: true }),
        run(`  ${b.on || '____________'} by First Class Mail, postage fully prepaid, addressed as stated above.`)],
      spacing: { after: 160 }
    }));
  };

  // Spec §04: the caption and the counsel block are each closed by a hairline
  // RULE that ends in a forward slash, not by a bare slash.
  //
  // Drawn as ONE bottom-bordered paragraph with the slash right-aligned on it,
  // deliberately not as a two-cell table. The table version (rule cell + slash
  // cell) is what the geometry actually calls for, but its rule cell is empty,
  // and an empty cell collapses to zero width in any renderer that auto-fits
  // columns — which is exactly what happened: the rule vanished and the slash
  // slid to the left margin. A bordered paragraph cannot collapse.
  const pushRuleSlash = (afterTwips) => {
    children.push(new Paragraph({
      children: [run('/')],
      alignment: AlignmentType.RIGHT,
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' } },
      indent: { right: 1440 },
      spacing: { after: afterTwips }
    }));
  };

  const pushRespectfullySubmitted = (dated) => {
    const ourLabel = matter.client_role === 'plaintiff'
      ? (matter.plaintiff_label || 'Plaintiff')
      : (matter.party_label || 'Defendant');
    const text = [
      `${(att.name || '').toUpperCase()} ${att.bar_number || ''}`.trim(),
      `Attorney for ${ourLabel}`,
      ...String(att.firm_address || '').split('\n'),
      att.firm_phone || ''
    ].filter(Boolean).join('\n');
    children.push(new Paragraph({ children: [run('Respectfully submitted,')], indent: { left: 4320 }, spacing: { before: 480 } }));
    const sigImg = signatureImageParagraphs(4680);
    if (sigImg.length) children.push(...sigImg);
    else children.push(new Paragraph({ children: [run('/S/')], indent: { left: 4680 }, spacing: { before: 240 } }));
    // The brief's signature carries its own date (the attorney, 2026-08-19), labeled
    // "Date:" above the rule like every other signature.
    if (dated) {
      children.push(new Paragraph({
        children: [run(`Date: ${dated}`)], indent: { left: 4320 }, spacing: { before: 240 }
      }));
    }
    children.push(new Paragraph({ children: [run('_____________________________')], indent: { left: 4320 }, spacing: { before: 240 } }));
    children.push(...lines(text, { paraOpts: { indent: { left: 4320 } } }));
  };

  blocks.forEach(b => {
    if (b.type === 'appellate_caption') {
      pushAppellateCaption();
    } else if (b.type === 'centered_bold') {
      children.push(new Paragraph({
        children: [run(b.text, { bold: true })],
        alignment: AlignmentType.CENTER, spacing: { before: 360, after: 360 }
      }));
    } else if (b.type === 'heavy_rule') {
      children.push(new Paragraph({
        text: '', border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: '000000' } },
        spacing: { before: 120, after: 240 }
      }));
    } else if (b.type === 'respectfully_submitted') {
      pushRespectfullySubmitted(b.dated);
    } else if (b.type === 'word_count') {
      const n = String(b.text || '').replace(/\[[^\]]*\]/g, ' ').split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w)).length;
      children.push(new Paragraph({
        children: [run(`Number of Countable Words: ${n.toLocaleString()}`)],
        spacing: { before: 720 }
      }));
    } else if (b.type === 'district_caption') {
      pushDistrictCaption();
    } else if (b.type === 'title_underlined') {
      children.push(new Paragraph({
        children: [run(b.text, { bold: true, underline: {} })],
        alignment: AlignmentType.CENTER, spacing: { before: 400, after: 400 }
      }));
    } else if (b.type === 'plain') {
      children.push(new Paragraph({ children: [run(b.text || '')], spacing: { after: 120 } }));
    // ---- Blank-form blocks (the printable intake questionnaire) -----------
    // Mirrored by renderFormSection/renderFormField/renderFormTable in
    // document-engine.js. A block type missing from this chain is silently
    // dropped from the .docx while the PDF looks perfect (ground rule 0.2).
    } else if (b.type === 'form_section') {
      children.push(new Paragraph({
        children: [run(String(b.text || '').toUpperCase(), { bold: true })],
        spacing: { before: 320, after: 160 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000' } },
        // Never let a section heading strand alone at the foot of a page with
        // its first question overleaf — on a form someone fills in by hand that
        // reads as the end of the section.
        keepNext: true
      }));
    } else if (b.type === 'form_field') {
      children.push(new Paragraph({ children: [run(formFieldText(b))], spacing: { after: 200, line: 320 } }));
      // A textarea answer needs somewhere to write more than one line.
      if (b.kind === 'textarea') {
        children.push(new Paragraph({ children: [run(BLANK_RULE)], spacing: { after: 200, line: 320 } }));
      }
    } else if (b.type === 'form_table') {
      const headings = (b.headings || []).map(h => String(h));
      const rowCount = Math.max(1, b.rows || 1);
      const colWidth = Math.floor(9360 / (headings.length || 1));
      const cellBorders = {
        top: THIN_RULE, bottom: THIN_RULE, left: THIN_RULE, right: THIN_RULE
      };
      const tableRow = (cells, bold) => new TableRow({
        // A split prior-record table loses its headings on the second page, so
        // the columns become unlabelled boxes. Keep the whole grid together.
        cantSplit: true,
        children: cells.map(text => new TableCell({
          borders: cellBorders,
          children: [new Paragraph({
            children: [run(text, bold ? { bold: true } : undefined)],
            // An empty row still has to be tall enough to write a court name
            // into by hand.
            spacing: bold ? { after: 40 } : { before: 200, after: 200 },
            keepNext: bold || undefined
          })]
        }))
      });
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        columnWidths: headings.map(() => colWidth),
        layout: TableLayoutType.FIXED,
        borders: {
          top: THIN_RULE, bottom: THIN_RULE, left: THIN_RULE, right: THIN_RULE,
          insideHorizontal: THIN_RULE, insideVertical: THIN_RULE
        },
        rows: [
          tableRow(headings, true),
          ...Array.from({ length: rowCount }, () => tableRow(headings.map(() => ''), false))
        ]
      }));
      children.push(new Paragraph({ text: '', spacing: { after: 200 } }));
    } else if (b.type === 'body') {
      children.push(new Paragraph({
        children: [run(b.text || '')], spacing: { line: 480 }, indent: { firstLine: 720 }
      }));
    } else if (b.type === 'appearance_signature') {
      pushAppearanceSignature(b.dated, b.noBarNumber);
    // ---- Packet / letter blocks (Phase 3) ---------------------------------
    // Each mirrors a render function in document-engine.js. A block type
    // missing from this chain is silently dropped from the .docx while the
    // PDF looks perfect — ground rule 0.2, and how the caption once vanished.
    } else if (b.type === 'letterhead') {
      pushLetterhead();
    } else if (b.type === 'letter_date') {
      children.push(new Paragraph({
        children: [run(b.text || '')], indent: { left: 3600 }, spacing: { before: 480, after: 360 }
      }));
    } else if (b.type === 'recipient_block') {
      if (b.name) children.push(new Paragraph({ children: [run(b.name, { bold: true })] }));
      children.push(...lines(b.address || ''));
      children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
    } else if (b.type === 're_block') {
      pushReBlock(b.lines || [], b.plain);
    } else if (b.type === 'to_the_above') {
      children.push(new Paragraph({
        children: [run('TO THE ABOVE:', { bold: true })], spacing: { before: 200, after: 200 }
      }));
    } else if (b.type === 'salutation') {
      children.push(new Paragraph({ children: [run(`Dear ${b.text || ''}`)], spacing: { before: 200, after: 240 } }));
    } else if (b.type === 'daad_caption') {
      pushDaadCaption(b.packet || {});
    } else if (b.type === 'stipulation_clause') {
      pushStipulationClause(b.hearingType, b.from, b.reason);
    } else if (b.type === 'dual_signature') {
      pushDualSignature(b);
    } else if (b.type === 'order_session') {
      pushOrderSession();
    } else if (b.type === 'order_clause') {
      pushOrderClause(b.hearingType, b.from);
    } else if (b.type === 'judge_signature') {
      pushJudgeSignature();
    } else if (b.type === 'letter_body') {
      children.push(new Paragraph({
        children: [run(b.text || '')], indent: { firstLine: 720 }, spacing: { after: 160 }
      }));
    } else if (b.type === 'enclosure_list') {
      // Derived from the packet, including the "and" between two items.
      (b.items || []).filter(Boolean).forEach((t, i) => {
        if (i > 0) children.push(new Paragraph({ children: [run('and')], indent: { left: 720 }, spacing: { after: 160 } }));
        children.push(new Paragraph({
          children: [run(t, { bold: true })], indent: { left: 720 }, spacing: { after: 160 }
        }));
      });
    } else if (b.type === 'letter_close') {
      children.push(new Paragraph({
        children: [run(b.closing || 'Very truly yours,')], indent: { left: 3600 }, spacing: { before: 300 }
      }));
      children.push(...signatureImageParagraphs(3600));
      children.push(new Paragraph({
        children: [run((att.name || '').toUpperCase())], indent: { left: 3600 }, spacing: { before: 240 }
      }));
      // The office line under the closing comes from the LETTERHEAD's second
      // office line, not the attorney's firm_name — those are different
      // fields that happened to agree for the one letterhead in production.
      // A personal letterhead has no office line at all in the filed
      // exhibit; reading att.firm_name here printed one anyway, disagreeing
      // with the PDF (renderLetterClose() in document-engine.js), which is
      // exactly the failure ground rule 0.4 exists to catch. Fixed 2026-08-19.
      {
        const lhOffice = String((matter.letterhead || {}).office_lines || '')
          .split('\n').map(s => s.trim()).filter(Boolean)[1] || '';
        if (lhOffice) {
          const titled = lhOffice.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
          children.push(new Paragraph({ children: [run(titled)], indent: { left: 3600 } }));
        }
      }
    } else if (b.type === 'ref_initials') {
      // Separator and typist half both belong to the letterhead — ":" city,
      // "/" personal (decision 9). Empty typist_initials means no separator
      // and no second half, not a dangling "JAD:".
      const lh = matter.letterhead || {};
      const initials = String(att.name || '').split(/\s+/).filter(Boolean)
        .map(w => w[0].toUpperCase()).join('');
      if (initials) {
        const typist = lh.typist_initials || '';
        const sep = typist ? (lh.ref_separator || ':') : '';
        children.push(new Paragraph({
          children: [run(`${initials}${sep}${typist}`)], spacing: { before: 480 }
        }));
      }
      children.push(new Paragraph({ children: [run('Encl.')] }));
    } else if (b.type === 'cc_block') {
      const names = (b.names || []).filter(Boolean);
      if (names.length) {
        children.push(new Paragraph({
          children: [run('cc:')], spacing: { before: 240 }
        }));
        names.forEach(n => {
          children.push(new Paragraph({
            children: [run(n)], indent: { left: 400 }
          }));
        });
      }
    } else if (b.type === 'memo_labels') {
      pushMemoLabels(b.rows || []);
    } else if (b.type === 'item_line') {
      pushItemLine(b.text);
    } else if (b.type === 'numbered_answers') {
      (b.items || []).forEach((it, i) => {
        children.push(new Paragraph({
          children: [run(`${i + 1}.`), run('\t'), run(it.text || '')],
          indent: { left: 720, hanging: 360 }, spacing: { after: 160 }
        }));
        if (it.itemAfter) pushItemLine(it.itemAfter);
      });
    } else if (b.type === 'counsel_block') {
      // Bold = names only (decision 5) — every stacked name line, not just the
      // first, which was indistinguishable from correct while the block held
      // a single attorney.
      const cbNameCount = counselNameLines(att, matter.co_counsel).length;
      counselLines(att, ourRoleLabel, matter.co_counsel).forEach((l, i) => {
        children.push(new Paragraph({ children: [run(l, i < cbNameCount ? { bold: true } : undefined)] }));
      });
      pushRuleSlash(240);
    } else if (b.type === 'pos_derived') {
      pushPosDerived(b);
    } else if (b.type === 'caption') {
      pushCaption();
    } else if (b.type === 'title') {
      children.push(new Paragraph({
        children: [run(b.text, { bold: true })],
        alignment: AlignmentType.CENTER, spacing: { before: 400, after: 400 }
      }));
    } else if (b.type === 'paragraph') {
      children.push(new Paragraph({
        children: [run(b.text || '')], spacing: { line: 480 }, indent: { firstLine: 720 }
      }));
    } else if (b.type === 'freetext') {
      pushFreeText(b.text);
    } else if (b.type === 'spacer') {
      for (let i = 0; i < (b.lines || 1); i++) children.push(new Paragraph({ text: '' }));
    } else if (b.type === 'signature') {
      pushSignature();
    } else if (b.type === 'pagebreak') {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    } else if (b.type === 'proof_of_service' || b.type === 'proof_of_service_block') {
      const f = b.data || {};
      const date = f.service_date ? new Date(f.service_date + 'T12:00:00Z').toLocaleDateString() : new Date().toLocaleDateString();
      const method = f.service_method || 'first-class mail';
      const docs = f.documents_served || 'the foregoing document';
      // Bold AND underlined: the spec names PROOF OF SERVICE explicitly among
      // the underlined titles (§05). Mirrors the HTML block.
      children.push(new Paragraph({
        children: [run('PROOF OF SERVICE', { bold: true, underline: {} })],
        alignment: AlignmentType.CENTER, spacing: { after: 240 }
      }));
      children.push(new Paragraph({
        children: [run(`I hereby certify that on ${date}, I served a copy of ${docs} upon the following attorneys of record or parties in pro per via ${method}:`)],
        spacing: { line: 480 }, indent: { firstLine: 720 }
      }));
      children.push(...lines(matter.opposing_counsel || '[Opposing Counsel Not Specified]', {
        paraOpts: { indent: { left: 720 }, spacing: { before: 240, after: 240 } }
      }));
      pushSignature();
    }
  });

  if (children.length === 0) children.push(new Paragraph({ text: 'Generated Document' }));

  // Centered page number footer, matching the PDF engine's Chromium footer
  // (generate-pdf, above). A real PAGE field, not literal text — Word
  // recomputes it as pages are added or removed after generation.
  const pageNumberFooter = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ font: FONT, size: 20, children: [PageNumber.CURRENT] })]
    })]
  });

  const doc = new Document({
    // docx defaults to A4 when size isn't given; the PDF export (line ~218)
    // is explicitly US Letter, so leaving this out made the two formats
    // print at different page sizes.
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 }, // US Letter, twips
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
        }
      },
      footers: { default: pageNumberFooter },
      children
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  recordGenerated(matter, docType || docTypeLabel, 'docx', hash, outputPath);
  return { path: outputPath, stored: storePath(outputPath), unchanged: false };
});

// Reads a signature image and returns it as a data: URI, so it travels with the
// database instead of depending on a file that may move or not exist on the
// machine the database is restored onto.
ipcMain.handle('pick-signature-image', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose Signature Image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };

  const file = res.filePaths[0];
  const bytes = fs.readFileSync(file);
  // Word chokes on very large embedded images and the database is a single
  // file we back up constantly; a signature scan has no business being big.
  const MAX = 2 * 1024 * 1024;
  if (bytes.length > MAX) {
    return { canceled: true, error: `That image is ${(bytes.length / 1048576).toFixed(1)}MB. Please use one under 2MB.` };
  }
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return { canceled: false, dataUri: `data:${mime};base64,${bytes.toString('base64')}` };
});

// Reads an already-finished/scanned letter (attach-a-scan) and returns it as
// a data: URI, same storage pattern as the signature image above — the file
// itself is never opened by this app again, only its stored bytes.
ipcMain.handle('pick-letter-scan', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose Letter File',
    properties: ['openFile'],
    filters: [{ name: 'Documents', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }]
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  const file = res.filePaths[0];
  const bytes = fs.readFileSync(file);
  const MAX = 8 * 1024 * 1024; // a scanned page is bigger than a signature crop
  if (bytes.length > MAX) {
    return { canceled: true, error: `That file is ${(bytes.length / 1048576).toFixed(1)}MB. Please use one under 8MB.` };
  }
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg';
  return { canceled: false, dataUri: `data:${mime};base64,${bytes.toString('base64')}`, extension: ext.slice(1) };
});

// Attach-a-scan: the letter already exists outside the app (typed, signed,
// possibly scanned from paper) — this just copies the stored bytes into the
// packet's output folder under the same naming/reuse convention every other
// generated document uses. Unlike generate-pdf/generate-docx, there is
// nothing to build; the data URI's own mime type picks the extension.
ipcMain.handle('save-attached-file', async (e, dataUri, matter, docTypeLabel, docType) => {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUri || '');
  if (!m) return { error: 'No attached file to save.' };
  const extension = m[1] === 'application/pdf' ? 'pdf' : m[1] === 'image/png' ? 'png' : 'jpg';

  const resolved =
    resolveOutputPathOrAsk(matter, docType || docTypeLabel, docTypeLabel, extension, dataUri);
  if (resolved.needsFolderOwner) return { needsFolderOwner: true };
  if (resolved.error) return { error: resolved.error };
  const { outputPath, unchanged, hash } = resolved;
  if (unchanged) return { path: outputPath, stored: storePath(outputPath), unchanged: true };

  fs.writeFileSync(outputPath, Buffer.from(m[2], 'base64'));
  recordGenerated(matter, docType || docTypeLabel, extension, hash, outputPath);
  return { path: outputPath, stored: storePath(outputPath), unchanged: false };
});

// The folder-owner picker (renderer's ensureFolderOwner). Candidates are the
// case's client parties that are linked to a person — the same rows
// matterFolderOwner() counts — named as the person is named now.
ipcMain.handle('matter-folder-candidates', (e, matterId) => db.prepare(
  `SELECT DISTINCT pa.person_id AS person_id, COALESCE(pe.display_name, pa.name) AS name
     FROM parties pa LEFT JOIN people pe ON pe.id = pa.person_id
    WHERE pa.matter_id = ? AND pa.role = 'client' AND pa.person_id IS NOT NULL
    ORDER BY pa.side, pa.sort_order, pa.id`).all(matterId));

// Store the choice: a person id, or 0 for "No Client". Only while the case
// folder is still undecided — once output_dir is frozen the case never moves
// (ground rule 0.5), so a late or repeated answer changes nothing. A person
// id must be one of the case's client parties, never an arbitrary person.
ipcMain.handle('set-matter-folder-owner', (e, matterId, personId) => {
  const owner = Number(personId);
  if (!Number.isInteger(owner) || owner < 0) return { changed: false };
  if (owner !== 0) {
    const ok = db.prepare(
      `SELECT 1 FROM parties WHERE matter_id = ? AND person_id = ? AND role = 'client'`).get(matterId, owner);
    if (!ok) return { changed: false };
  }
  const r = db.prepare(
    'UPDATE matters SET folder_person_id = ? WHERE id = ? AND output_dir IS NULL').run(owner, matterId);
  return { changed: r.changes > 0 };
});

// The client's own folder, created on first use and frozen thereafter.
ipcMain.handle('client-docs-dir', (e, personId) => getClientDir(personId));

// The profile's Open Folder: the same folder, as { dir } or a plain { error }
// (a missing documents folder, a deleted client) rather than a thrown one.
ipcMain.handle('client-folder', (e, personId) => {
  const refusal = rootRefusal();
  if (refusal) return { error: refusal };
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(personId)) return { error: 'That client no longer exists.' };
  try {
    return { dir: getClientDir(personId) };
  } catch (err) {
    if (err && err.code === 'ROOT_MISSING') return { error: err.message };
    throw err;
  }
});

// Where each of a client's uploaded files is on THIS computer: { [row id]:
// absolute path }. The row keeps the folder it was copied into
// (client_documents.stored_dir, stored form) and the file name; a row from
// before migration 35 has no stored_dir and sits in the client's own folder,
// the frozen people.client_docs_dir. getClientDir (which creates that folder)
// is only reached when such a row exists, so browsing a client does not
// litter the output root with an empty folder.
// With the documents folder unavailable nothing may be created, so the frozen
// folder is only resolved (the file then shows as missing), never made.
function legacyClientDir(personId) {
  if (!rootRefusal()) return getClientDir(personId);
  const row = db.prepare('SELECT client_docs_dir FROM people WHERE id = ?').get(personId);
  return row && row.client_docs_dir ? loadPath(row.client_docs_dir) : null;
}
ipcMain.handle('client-document-paths', (e, personId) => {
  const rows = db.prepare(
    'SELECT id, filename, stored_dir FROM client_documents WHERE person_id = ?').all(personId);
  const out = {};
  let own = null;
  for (const r of rows) {
    let dir;
    if (r.stored_dir) dir = loadPath(r.stored_dir);
    else dir = own || (own = legacyClientDir(personId));
    if (dir) out[r.id] = path.join(dir, r.filename);
  }
  return out;
});

// The case screen's Open Folder: the case's own folder, through getMatterDir,
// so the first ask creates it and freezes it exactly as the first generated
// document would. An undecided owner comes back as { needsFolderOwner: true }
// with nothing created, for the renderer's picker.
ipcMain.handle('matter-folder', (e, matterId) => {
  const m = db.prepare('SELECT id, short_name, case_number FROM matters WHERE id = ?').get(matterId);
  if (!m) return { error: 'That case no longer exists.' };
  const refusal = rootRefusal();
  if (refusal) return { error: refusal };
  try {
    return { dir: getMatterDir(m) };
  } catch (err) {
    if (err && err.code === 'NEEDS_FOLDER_OWNER') return { needsFolderOwner: true };
    if (err && err.code === 'ROOT_MISSING') return { error: err.message };
    throw err;
  }
});

// The case screen's Add Documents: whose Documents list an upload to this case
// is recorded under. Every client_documents row belongs to a person — the
// client's profile is the only screen that lists, relabels or deletes them —
// so a case with no client to file under says so rather than copying a file
// nobody could find again in the app:
//   { personId }          the case's folder owner (stored, or its one client)
//   { needsFolderOwner }  several clients, not decided yet: ask, then again
//   { noClient }          filed under "No Client"
//   { noClients }         no client party linked to a person, nothing decided
//   { legacyShared }      a case folder frozen before owners were recorded,
//                         with several clients: which one is not known
function caseUploadOwner(matterId) {
  // A missing documents folder is said first: asking whose folder a case
  // belongs in is pointless when no folder can be written to at all.
  const missing = rootRefusal();
  if (missing) return { error: missing };
  const m = db.prepare('SELECT output_dir FROM matters WHERE id = ?').get(matterId);
  if (!m) return { error: 'That case no longer exists.' };
  const owner = matterFolderOwner(matterId);
  if (owner > 0) return { personId: owner };
  if (owner === 0) return { noClient: true };
  const clients = db.prepare(
    `SELECT COUNT(DISTINCT person_id) AS n FROM parties
      WHERE matter_id = ? AND role = 'client' AND person_id IS NOT NULL`).get(matterId).n;
  if (!clients) return { noClients: true };
  if (m.output_dir) return { legacyShared: true };
  return { needsFolderOwner: true };
}
ipcMain.handle('case-upload-owner', (e, matterId) => caseUploadOwner(matterId));

// Add already-existing files (drag-and-drop, or the dialog below) to a client.
// Explicit paths in, stored filenames out — no dialog, so this is the half that
// can be tested.
ipcMain.handle('add-client-document-files', (e, personId, filePaths, opts) =>
  addClientDocumentFiles(personId, filePaths, opts || {}));

// The same copy, in front of a multi-select file dialog.
ipcMain.handle('add-client-document', async (e, personId, opts) => {
  // Ask whose folder the case is in BEFORE the dialog, not after: the renderer
  // re-runs this call once the owner is chosen, and the user must not be made
  // to pick the same files twice. Nothing is created by this check.
  const matterId = opts && opts.matterId;
  const refusal = uploadRefusal(personId, matterId || null) || rootRefusal();
  if (refusal) return { error: refusal };
  if (matterId) {
    const m = db.prepare('SELECT output_dir FROM matters WHERE id = ?').get(matterId);
    if (m && !m.output_dir && matterFolderOwner(matterId) == null) return { needsFolderOwner: true };
  }
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Add Client Documents',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Documents', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'doc', 'docx', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  return addClientDocumentFiles(personId, res.filePaths, opts || {});
});

// Opening the finished document from the app, so it never has to be hunted for
// in Explorer. shell.openPath uses the OS default handler (Word, Acrobat).

// The documents-folder banner: the same refusal every save gives, or null.
// Asked afresh each time (startup, window focus, after Settings), so it
// clears by itself once the drive is reconnected.
ipcMain.handle('output-root-status', () => rootRefusal());

// The version shown in the corner of the app. Read from Electron rather than
// package.json so a packaged build reports what was actually installed.
ipcMain.handle('app-version', () => app.getVersion());

// The top bar's zoom controls. set-zoom snaps to a step and saves it.
ipcMain.handle('get-zoom', (e) => ({ factor: snapZoom(e.sender.getZoomFactor()), steps: ZOOM_STEPS }));
ipcMain.handle('set-zoom', (e, factor) => setAppZoom(e.sender, factor));

// The renderer has no filesystem access (contextIsolation) — this is the only
// way for the on-screen preview to load the same print.css the real PDF path
// injects, so a previewed signature image is capped/aspect-preserved the same
// way it would be in the actual PDF.
ipcMain.handle('read-print-css', () => {
  const cssPath = path.join(__dirname, 'print.css');
  return fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
});

// Open / Reveal / path-exists take a STORED location (a documents row's
// pdf_path, say) or an absolute one (a path main just handed back) and resolve
// it here, against this computer's output root. The renderer never joins or
// resolves a stored value itself.
ipcMain.handle('open-path', async (e, stored) => {
  if (!stored || typeof stored !== 'string') return { ok: false, error: 'No file' };
  const target = loadPath(stored);
  if (!fs.existsSync(target)) return { ok: false, error: 'That file no longer exists.' };
  const err = await shell.openPath(target);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('show-in-folder', (e, stored) => {
  if (!stored || typeof stored !== 'string') return { ok: false, error: 'No file' };
  const target = loadPath(stored);
  if (!fs.existsSync(target)) return { ok: false, error: 'That file no longer exists.' };
  shell.showItemInFolder(target);
  return { ok: true };
});

// A13: the app only ever POINTS AT files by path — it never manages, scans
// or reconciles the output folder. This lets a Documents list show a
// "missing" tag before the user clicks Open, instead of only discovering it
// then. Decided with the user 2026-08-26 over the alternative (the app
// actively owning/reconciling its output folder) — that's real machinery
// (a scan job, false positives from sync tools like OneDrive mid-sync) for
// a one-person practice's local app; this fits how everything else here
// works (record and roll up, never manage).
ipcMain.handle('path-exists', (e, stored) =>
  !!stored && typeof stored === 'string' && fs.existsSync(loadPath(stored)));

// Settings' documents folder. Changing it means "my Legal Documents folder is
// now HERE": every stored location is relative to it, so it is picked with a
// folder dialog (never typed), and once anything has been saved the choice is
// checked against what the database points into. A folder missing a top-level
// folder the saved locations live in (no Clients/ while client folders are
// stored, say) gets a plain warning first, because every existing document
// would then show as missing. Absolute (outside-root) locations are unaffected.
function layoutMissing(root) {
  const { PATH_COLUMNS } = require('./db-migrations');
  const tops = new Set();
  for (const [table, column] of PATH_COLUMNS) {
    let rows = [];
    try {
      rows = db.prepare(
        `SELECT DISTINCT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> ''`).all();
    } catch { continue; }
    for (const r of rows) {
      const top = F.storedTopFolder(r.v);
      if (top) tops.add(top);
    }
  }
  return [...tops].filter(t => !fs.existsSync(path.join(root, t))).sort();
}

ipcMain.handle('choose-output-root', async () => {
  const current = outputRoot();
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose your Legal Documents folder',
    defaultPath: fs.existsSync(current) ? current : app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return { canceled: true };
  const chosen = path.resolve(res.filePaths[0]);
  if (chosen === current) return { root: current, unchanged: true };
  if (hasSavedLocations()) {
    if (!fs.existsSync(chosen) || !fs.statSync(chosen).isDirectory()) {
      return { error: `That folder (${chosen}) doesn't exist. Choose the folder your documents are in.` };
    }
    const missing = layoutMissing(chosen);
    if (missing.length) {
      const confirm = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Use This Folder', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Your existing documents are not in this folder.',
        detail: `${chosen} has no ${missing.map(m => `"${m}"`).join(', ')} folder. ` +
          'Documents you have already saved will show as missing until your Legal Documents ' +
          'folder is moved there. Use this folder anyway?'
      });
      if (confirm.response !== 0) return { canceled: true };
    }
  }
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('output_root', ?)").run(chosen);
  return { root: chosen };
});

// --- Backup / restore -------------------------------------------------------

ipcMain.handle('backup-now', async () => {
  const { backupTo } = require('./db-backup');
  const suggested = `TrueCaption-backup-${require('./db-backup').stamp()}.db`;
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Back Up Data',
    defaultPath: path.join(app.getPath('documents'), suggested),
    filters: [{ name: 'TrueCaption backup', extensions: ['db'] }]
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  await backupTo(db, res.filePath);
  return { canceled: false, path: res.filePath };
});

// Restores, then relaunches: the database file is replaced underneath the open
// handle, so continuing in-process would read a stale connection.
ipcMain.handle('restore-backup', async () => {
  const { restoreFrom } = require('./db-backup');
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'data.db');

  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Restore From Backup',
    properties: ['openFile'],
    filters: [{ name: 'TrueCaption backup', extensions: ['db'] }]
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };

  const confirm = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Restore and Restart'],
    defaultId: 0,
    cancelId: 0,
    message: 'Replace all current data with this backup?',
    detail: 'A copy of your current data is saved first, so this can be undone.'
  });
  if (confirm.response !== 1) return { canceled: true };

  try {
    db.close();
    restoreFrom(res.filePaths[0], dbPath, userDataPath);
    app.relaunch();
    app.exit(0);
    return { canceled: false };
  } catch (err) {
    // Reopen so the app stays usable if the restore was rejected.
    const Database = require('better-sqlite3');
    db = new Database(dbPath);
    await dialog.showMessageBox(mainWindow, {
      type: 'error', message: 'Restore failed', detail: err.message
    });
    return { canceled: true, error: err.message };
  }
});
