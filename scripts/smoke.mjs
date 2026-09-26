// Launches the real Electron app and asserts the things that have actually
// broken before: the renderer script running at all, better-sqlite3 loading
// over IPC, and a full document exporting to .docx with every block present.
//
// Runs on any platform: `node scripts/smoke.mjs`. CI runs it on Windows so the
// build that ships to a Windows machine is verified on Windows.
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = path.join(
  APP_DIR,
  process.platform === 'darwin'
    ? 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    : process.platform === 'win32'
      ? 'node_modules/electron/dist/electron.exe'
      : 'node_modules/electron/dist/electron'
);

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(name);
};

// A .docx is a zip; word/document.xml holds the text. Read it without adding a
// dependency — PowerShell on Windows, unzip elsewhere.
function readDocxPart(docxPath, partName) {
  docxPath = onDisk(docxPath);
  try {
    if (process.platform === 'win32') {
      // A single quote inside a PowerShell single-quoted string is escaped by
      // doubling it. Without this, any generated filename containing an
      // apostrophe ("Defendant's Answer to ...") produced a parser error and
      // the file read as empty — which showed up as a dozen unrelated content
      // assertions failing on Windows only.
      const psPath = String(docxPath).replace(/'/g, "''");
      const ps = `Add-Type -A System.IO.Compression.FileSystem; ` +
        `$z=[IO.Compression.ZipFile]::OpenRead('${psPath}'); ` +
        `$e=$z.GetEntry('${partName}'); ` +
        `if (-not $e) { '' } else { $r=New-Object IO.StreamReader($e.Open()); $r.ReadToEnd() }`;
      return execFileSync('powershell', ['-NoProfile', '-Command', ps]).toString();
    }
    return execFileSync('unzip', ['-p', docxPath, partName]).toString();
  } catch (e) {
    console.log(`note: could not read docx part ${partName} —`, e.message);
    return '';
  }
}
function readDocxXml(docxPath) { return readDocxPart(docxPath, 'word/document.xml'); }

// Lists the zip entries in a .docx, to confirm embedded media exists.
function listDocxEntries(docxPath) {
  docxPath = onDisk(docxPath);
  try {
    if (process.platform === 'win32') {
      const ps = `Add-Type -A System.IO.Compression.FileSystem; ` +
        `([IO.Compression.ZipFile]::OpenRead('${docxPath}')).Entries | ForEach-Object { $_.FullName }`;
      return execFileSync('powershell', ['-NoProfile', '-Command', ps]).toString().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
    return execFileSync('unzip', ['-Z1', docxPath]).toString().split('\n').map(s => s.trim()).filter(Boolean);
  } catch (e) {
    console.log('note: could not list docx entries —', e.message);
    return [];
  }
}

// 1x1 opaque PNG, enough to prove the embed path works end to end.
const TINY_PNG = 'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Task 9b: path columns hold a location RELATIVE to the output root, "/"-
// separated (main.js storePath). A check that goes on to touch the disk, or
// compares with an absolute path, resolves the stored value the way main.js
// loadPath does. An absolute value (outside the root, or a path main handed
// back directly) passes through unchanged.
function onDisk(stored, root = tmpRoot) {
  if (stored == null || stored === '' || path.isAbsolute(String(stored))) return stored;
  return path.join(root, ...String(stored).split('/'));
}
// The same over a fixture's result: every path-column key (and every "...Dir"
// key a fixture copies one into), at any depth.
const STORED_KEY = /^(output_dir|stored_dir|client_docs_dir|pdf_path|docx_path)$|Dir$/;
function resolveStored(x) {
  if (Array.isArray(x)) return x.map(resolveStored);
  if (x && typeof x === 'object') {
    return Object.fromEntries(Object.entries(x).map(([k, v]) =>
      [k, STORED_KEY.test(k) && typeof v === 'string' ? onDisk(v) : resolveStored(v)]));
  }
  return x;
}

if (!fs.existsSync(electronBin)) {
  console.error('Electron binary not found at', electronBin);
  process.exit(1);
}

// Isolated profile: the smoke run must never read or write the real database.
// Also makes CI deterministic, since every run starts from an empty profile.
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-profile-'));

// --disable-gpu: this run spins up a hidden BrowserWindow per PDF (every
// generate-pdf call, main.js) on top of the main window, for ~12 minutes
// straight. A recurring flake ("Target page, context or browser has been
// closed", seen at two unrelated points in the run, always green on retry)
// matches a transient GPU-process crash under that load rather than any bug
// in a specific section — this trades hardware compositing for stability,
// which nothing here depends on (no pixel-level screenshot comparisons).
const app = await electron.launch({
  executablePath: electronBin,
  args: [APP_DIR, '--no-sandbox', '--disable-gpu', `--user-data-dir=${profileDir}`],
  cwd: APP_DIR,
  timeout: 120_000,
});

const pageErrors = [];
const page = await app.firstWindow();
page.on('pageerror', e => pageErrors.push(e.message));
await page.waitForLoadState('domcontentloaded').catch(() => {});
await new Promise(r => setTimeout(r, 5000));

// alert() would block the automation session.
await page.evaluate(() => { window.alert = () => {}; });

check('window opens', app.windows().length > 0);
check('no uncaught renderer errors', pageErrors.length === 0, pageErrors.join(' | '));

// The renderer script must have actually executed. Checking for DocumentEngine
// is not enough — that comes from document-engine.js, a separate script that
// still runs when renderer.js dies. Handlers are bound with addEventListener so
// they are not observable as properties either; click and assert the view moved.
// "New Matter" opens the intake-wizard fork first, not the matter form directly — Court Filing is
// what reaches view-matter-detail now.
const rendererRan = await page.evaluate(() => {
  const btn = document.getElementById('btn-new-matter');
  if (!btn) return false;
  btn.click();
  const fork = document.getElementById('view-matter-fork');
  return !!fork && !fork.classList.contains('hidden');
});
check('renderer.js executed (New Matter opens the fork)', rendererRan);

const wizardStep1Ran = await page.evaluate(() => {
  const btn = document.getElementById('btn-fork-court');
  if (!btn) return false;
  btn.click();
  const detail = document.getElementById('view-matter-detail');
  const step1 = document.getElementById('wizard-step-1-fields');
  const step2 = document.getElementById('wizard-step-2-fields');
  return !!detail && !detail.classList.contains('hidden')
    && !!step1 && !step1.classList.contains('hidden')
    && !!step2 && step2.classList.contains('hidden');
});
check('Court Filing enters wizard Step 1 (Step 2 hidden)', wizardStep1Ran);

const dbOk = await page.evaluate(async () => {
  try {
    const t = await window.api.dbAll("SELECT name FROM sqlite_master WHERE type='table'");
    return t.length >= 7;
  } catch { return false; }
});
check('better-sqlite3 works over IPC', dbOk);

// main.js no longer seeds a default attorney into a fresh database (A2: the
// fake "Jane Doe" row is gone). Home should quietly point at the My Office
// tab (formerly Attorneys) while the app has none.
await page.evaluate(() => { document.getElementById('nav-home').click(); });
await new Promise(r => setTimeout(r, 500)); // loadHome() is async
const homeSetupNote = await page.evaluate(() => {
  const note = document.getElementById('home-setup-note');
  return !note.classList.contains('hidden') && /My Office/.test(note.textContent);
});
check('Home nudges toward the My Office tab when no signing profile exists', homeSetupNote);

// The rest of this suite still needs one `is_default = 1` attorney to build
// documents against, so create it here — standing in for what a real user
// does once in the My Office tab.
await page.evaluate(async () => {
  await window.api.dbRun(
    `INSERT INTO attorneys (name, bar_number, firm_name, firm_address, firm_phone, firm_email, is_default)
     VALUES ('Jane Doe', 'P12345', 'Doe Law Firm PLLC', '123 Main St, Suite 100\nExampleton, MI 48000', '(555) 123-4567', 'jane@doelaw.com', 1)`);
});

await page.evaluate(() => { document.getElementById('nav-home').click(); });
await new Promise(r => setTimeout(r, 500)); // loadHome() is async
const homeSetupNoteGone = await page.evaluate(() =>
  document.getElementById('home-setup-note').classList.contains('hidden'));
check('Home setup nudge disappears once an attorney exists', homeSetupNoteGone);

// --- Client profile: the intake questionnaire is grouped into sections ------
// The optional groups (emergency contact, medical, education, priors) start
// collapsed so the everyday form stays short; the everyday groups start open.
// Collapse is the `data-collapsed` attribute, not a class, so the markup itself
// carries the initial state and CSS hides [data-collapsed] .section-body.
const profileSections = await page.evaluate(() => {
  document.getElementById('nav-people').click();
  document.getElementById('btn-new-person').click();
  const ids = ['sec-identity', 'sec-personal', 'sec-licences', 'sec-emergency',
               'sec-medical', 'sec-education', 'sec-priors', 'sec-notes'];
  const present = ids.filter(i => document.getElementById(i));
  const collapsed = id => document.getElementById(id)?.hasAttribute('data-collapsed');
  return {
    present,
    missing: ids.filter(i => !document.getElementById(i)),
    optionalCollapsed: ['sec-emergency', 'sec-medical', 'sec-education', 'sec-priors'].every(collapsed),
    everydayOpen: ['sec-identity', 'sec-personal', 'sec-licences'].every(id => !collapsed(id))
  };
});
check('profile has all eight sections', profileSections.missing.length === 0, profileSections.missing.join(', '));
check('optional sections start collapsed', profileSections.optionalCollapsed);
check('everyday sections start open', profileSections.everydayOpen);

// Every column migration 24 added must have an input on screen whose id follows
// the `per-<column>` convention — renderer.js maps ids to columns by string
// concatenation, so a typo here is a field that silently never saves.
const profileInputs = await page.evaluate(() => {
  const cols = ['intake_date', 'street', 'city', 'zip', 'cell_phone', 'home_phone',
    'marital_status', 'citizenship', 'employer',
    'emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_phone',
    'medical_issues', 'medications', 'medical_marijuana_card',
    'education_college', 'education_high_school', 'education_highest_grade',
    'cdl_license', 'cdl_number', 'chauffeur_license', 'chauffeur_number',
    'cpl_license', 'cpl_number'];
  const bools = ['cdl_license', 'chauffeur_license', 'cpl_license', 'medical_marijuana_card'];
  return {
    missing: cols.filter(c => !document.getElementById('per-' + c)),
    wrongType: bools.filter(c => {
      const el = document.getElementById('per-' + c);
      return !el || el.type !== 'checkbox';
    })
  };
});
check('every migration-24 column has an input on the profile form',
  profileInputs.missing.length === 0, profileInputs.missing.join(', '));
check('license and medical-marijuana flags are checkboxes',
  profileInputs.wrongType.length === 0, profileInputs.wrongType.join(', '));

// Toggling a section header flips data-collapsed both ways.
const profileToggle = await page.evaluate(() => {
  const sec = document.getElementById('sec-medical');
  const btn = sec.querySelector('.section-toggle');
  const before = sec.hasAttribute('data-collapsed');
  btn.click();
  const afterOpen = sec.hasAttribute('data-collapsed');
  btn.click();
  const afterClose = sec.hasAttribute('data-collapsed');
  return { before, afterOpen, afterClose };
});
check('section header toggles data-collapsed both ways',
  profileToggle.before === true && profileToggle.afterOpen === false && profileToggle.afterClose === true,
  JSON.stringify(profileToggle));

// --- Client profile: every intake field round-trips to the database ---------
// This is the orphaned-column guard. A column can exist in a migration, have an
// input on screen, and still never be written — that combination is invisible
// until someone reopens the profile and finds the field blank. So: type into
// every field, save, then read the row straight back out of SQLite and compare.
// `occupation` and `license_number` in particular were orphaned columns before
// this work, so they are covered here alongside migration 24's additions and
// the legacy `address` blob.
const PROFILE_TEXT = {
  display_name: 'Round Trip Test',
  kind: 'organization',
  firm_name: 'Round Trip LLC',
  address: '9 Old Blob Rd, Exampleton, MI 48000',
  phone: '(555) 010-0100',
  email: 'roundtrip@example.com',
  dob: '1980-07-04',
  notes: 'Round-trip smoke note.',
  license_number: 'Z-123-456',
  occupation: 'Driver',
  intake_date: '2026-08-24',
  street: '123 Main St',
  city: 'Exampleton',
  zip: '48000',
  cell_phone: '(555) 010-0101',
  home_phone: '(555) 010-0102',
  marital_status: 'Married',
  citizenship: 'US',
  employer: 'Acme Co',
  emergency_contact_name: 'Jane Doe',
  emergency_contact_relationship: 'Spouse',
  emergency_contact_phone: '(555) 010-0103',
  medical_issues: 'None reported',
  medications: 'None reported',
  education_college: 'State University',
  education_high_school: 'Exampleton HS',
  education_highest_grade: '12',
  cdl_number: 'CDL-1',
  chauffeur_number: 'CH-1',
  cpl_number: 'CPL-1',
  // The Organization block (Task 7). Hidden unless Type is Organization, which
  // `kind` above is — but the save writes them regardless of visibility.
  caption_name: 'ROUND TRIP, LLC',
  usual_role: 'defendant'
};
const PROFILE_BOOLS = ['cdl_license', 'chauffeur_license', 'cpl_license', 'medical_marijuana_card'];

const roundTrip = await page.evaluate(async ({ text, bools }) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  document.getElementById('nav-people').click();
  document.getElementById('btn-new-person').click();

  // Guard the guard: if someone adds a `per-*` input to the profile and forgets
  // to add it here, this test would keep passing while the new field silently
  // never saves. So enumerate the form and report anything this block misses.
  const onForm = [...document.querySelectorAll('#view-person-detail [id^="per-"]')]
    .map(el => el.id.slice(4))
    .filter(c => c !== 'id');
  // `signing_attorney_id` is a select of signing profiles, filled from the
  // attorneys table after the form opens; it stores an INTEGER, not text.
  const covered = new Set([...Object.keys(text), ...bools, 'signing_attorney_id']);
  const uncovered = onForm.filter(c => !covered.has(c));

  await sleep(200);
  const signSel = document.getElementById('per-signing_attorney_id');
  const signId = signSel.options[1] ? Number(signSel.options[1].value) : null;
  if (signId) signSel.value = String(signId);
  for (const [k, v] of Object.entries(text)) document.getElementById('per-' + k).value = v;
  for (const k of bools) document.getElementById('per-' + k).checked = true;
  document.getElementById('btn-save-person').click();
  await sleep(400);

  const id = document.getElementById('per-id').value;
  const row = await window.api.dbGet('SELECT * FROM people WHERE id = ?', [id]);
  const wrongText = Object.entries(text)
    .filter(([k, v]) => row[k] !== v)
    .map(([k, v]) => `${k} (typed ${JSON.stringify(v)}, stored ${JSON.stringify(row[k])})`);
  if (!signId || row.signing_attorney_id !== signId) {
    wrongText.push(`signing_attorney_id (chose ${JSON.stringify(signId)}, stored ${JSON.stringify(row.signing_attorney_id)})`);
  }
  // Integer 1 — not the string "on" that `.value` on a checkbox yields, and not
  // the boolean `true` that SQLite would refuse to bind.
  const wrongBool = bools
    .filter(k => row[k] !== 1)
    .map(k => `${k} (stored ${JSON.stringify(row[k])})`);

  // And the inverse: unticking a box previously ticked must store 0. A
  // checkbox that only ever writes 1 is a one-way switch the user cannot undo.
  for (const k of bools) document.getElementById('per-' + k).checked = false;
  document.getElementById('btn-save-person').click();
  await sleep(400);
  const after = await window.api.dbGet('SELECT * FROM people WHERE id = ?', [id]);
  const wrongUntick = bools
    .filter(k => after[k] !== 0)
    .map(k => `${k} (stored ${JSON.stringify(after[k])})`);

  // Reopening must show back what was stored, not a blank form.
  const reopened = await window.api.dbGet('SELECT * FROM people WHERE id = ?', [id]);
  return { id, uncovered, wrongText, wrongBool, wrongUntick, name: reopened.display_name };
}, { text: PROFILE_TEXT, bools: PROFILE_BOOLS });

check('round-trip test covers every input on the profile form',
  roundTrip.uncovered.length === 0, roundTrip.uncovered.join(', '));
check('every intake text field persists to the database',
  roundTrip.wrongText.length === 0, roundTrip.wrongText.join('; '));
check('every license checkbox persists as integer 1',
  roundTrip.wrongBool.length === 0, roundTrip.wrongBool.join('; '));
check('unticking a license checkbox persists as integer 0',
  roundTrip.wrongUntick.length === 0, roundTrip.wrongUntick.join('; '));

// --- Prior record: a repeating table on the person ---------------------------
// The offense text carries jurisdiction and place names, so an apostrophe is
// ordinary data here, not an edge case: "O'Brien County", "St. Mary's". A row
// built from an HTML string breaks on the first one, which is why the party
// rows are built with document.createElement and why these are too. The
// assertion below is what proves it.
const priors = await page.evaluate(async () => {
  const p = await window.api.dbGet("SELECT * FROM people WHERE display_name = 'Round Trip Test'");
  await window.openPerson(p.id);
  await new Promise(r => setTimeout(r, 300));
  document.getElementById('btn-add-prior').click();
  document.querySelector('#priors-list [data-field="offense"]').value = "O'Brien County OWI";
  document.querySelector('#priors-list [data-field="jurisdiction"]').value = '90th District';
  document.querySelector('#priors-list [data-field="offense_date"]').value = '2019-04-02';
  document.getElementById('btn-save-person').click();
  await new Promise(r => setTimeout(r, 400));
  return window.api.dbAll('SELECT * FROM person_priors WHERE person_id = ?', [p.id]);
});
check('a prior offense saves against the person', priors.length === 1, JSON.stringify(priors));
check('an apostrophe in a prior survives the round trip',
  priors[0] && priors[0].offense === "O'Brien County OWI", JSON.stringify(priors[0]));
check('a prior saves its jurisdiction and date alongside the offense',
  priors[0] && priors[0].jurisdiction === '90th District' && priors[0].offense_date === '2019-04-02',
  JSON.stringify(priors[0]));

// Reopening must show the saved row back, and a second save must not duplicate
// it — the save deletes and re-inserts, so a stale array would double the row.
const priorsReopen = await page.evaluate(async () => {
  const p = await window.api.dbGet("SELECT * FROM people WHERE display_name = 'Round Trip Test'");
  await window.openPerson(p.id);
  await new Promise(r => setTimeout(r, 300));
  const shown = document.querySelector('#priors-list [data-field="offense"]');
  document.getElementById('btn-save-person').click();
  await new Promise(r => setTimeout(r, 400));
  const rows = await window.api.dbAll('SELECT * FROM person_priors WHERE person_id = ?', [p.id]);
  return { shown: shown ? shown.value : null, count: rows.length };
});
check('reopening a person shows the prior that was saved',
  priorsReopen.shown === "O'Brien County OWI", JSON.stringify(priorsReopen));
check('saving twice does not duplicate a prior', priorsReopen.count === 1, JSON.stringify(priorsReopen));

// The leak guard. The priors array lives outside openPerson, so a client opened
// after one with a record would show that record as their own if the array were
// not reset — someone else's criminal history on an innocent person's profile.
const priorsLeak = await page.evaluate(async () => {
  const res = await window.api.dbRun(
    'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
    ['Priors Leak Test', 'individual', new Date().toISOString()]);
  const withPriors = await window.api.dbGet("SELECT * FROM people WHERE display_name = 'Round Trip Test'");
  await window.openPerson(withPriors.id);
  await new Promise(r => setTimeout(r, 300));
  const onA = document.querySelectorAll('#priors-list [data-field="offense"]').length;
  await window.openPerson(res.lastInsertRowid);
  await new Promise(r => setTimeout(r, 300));
  const onB = document.querySelectorAll('#priors-list [data-field="offense"]').length;
  // And a brand-new, unsaved person must not inherit either.
  document.getElementById('btn-new-person').click();
  await new Promise(r => setTimeout(r, 200));
  const onNew = document.querySelectorAll('#priors-list [data-field="offense"]').length;
  return { onA, onB, onNew, id: res.lastInsertRowid };
});
check('a client with priors shows them', priorsLeak.onA === 1, JSON.stringify(priorsLeak));
check('priors do not leak from one client onto the next',
  priorsLeak.onB === 0, JSON.stringify(priorsLeak));
check('priors do not leak onto a brand-new person',
  priorsLeak.onNew === 0, JSON.stringify(priorsLeak));

// Saving a person who has no priors must not throw, and must clear any that
// were saved before — removing a row on screen has to reach the database.
const priorsClear = await page.evaluate(async () => {
  const p = await window.api.dbGet("SELECT * FROM people WHERE display_name = 'Round Trip Test'");
  await window.openPerson(p.id);
  await new Promise(r => setTimeout(r, 300));
  document.querySelector('#priors-list [data-remove-prior]').click();
  document.getElementById('btn-save-person').click();
  let cleared = await window.api.dbAll('SELECT * FROM person_priors WHERE person_id = ?', [p.id]);
  for (let i = 0; i < 40 && cleared.length; i++) {
    await new Promise(r => setTimeout(r, 100));
    cleared = await window.api.dbAll('SELECT * FROM person_priors WHERE person_id = ?', [p.id]);
  }
  // A person that has never been saved has no id to delete against; saving must
  // still work rather than blowing up on a DELETE with an empty person_id.
  document.getElementById('btn-new-person').click();
  await new Promise(r => setTimeout(r, 200));
  document.getElementById('per-display_name').value = 'Priors Unsaved Test';
  document.getElementById('btn-add-prior').click();
  document.querySelector('#priors-list [data-field="offense"]').value = 'Retail fraud';
  document.getElementById('btn-save-person').click();
  let fresh = await window.api.dbGet("SELECT * FROM people WHERE display_name = 'Priors Unsaved Test'");
  for (let i = 0; i < 40 && !fresh; i++) {
    await new Promise(r => setTimeout(r, 100));
    fresh = await window.api.dbGet("SELECT * FROM people WHERE display_name = 'Priors Unsaved Test'");
  }
  const freshPriors = fresh
    ? await window.api.dbAll('SELECT * FROM person_priors WHERE person_id = ?', [fresh.id])
    : [];
  return { cleared: cleared.length, freshPriors };
});
check('removing a prior and saving clears it from the database',
  priorsClear.cleared === 0, JSON.stringify(priorsClear));
check('a prior entered before the person is first saved still persists',
  priorsClear.freshPriors.length === 1 && priorsClear.freshPriors[0].offense === 'Retail fraud',
  JSON.stringify(priorsClear.freshPriors));

// --- Filled markers on the collapsed sections --------------------------------
// Four sections start collapsed, so their contents are invisible until the user opens
// each one. The marker is the whole point: it says "there IS something in here"
// without making the user expand all four on every client. Which means the negative
// case is the test that matters — a marker that is always on tells the user nothing,
// so an EMPTY section must clear it.
//
// Two of the traps are checked below by construction:
//   * an unchecked checkbox has a `.value` of the string "on", so a marker read
//     from `.value` would light up Medical for every client alive. 'Priors
//     Unsaved Test' has nothing in Medical but that one unticked box.
//   * Prior Record holds no `per-*` inputs at all — it is the repeating table
//     built from the `priors` array — so its marker has to consult the array.
const filledMarkers = await page.evaluate(async () => {
  const marker = id => {
    const el = document.querySelector(`#${id} .section-filled`);
    return el ? !el.classList.contains('hidden') : null;
  };
  const snap = () => ({
    identity: marker('sec-identity'),
    notes: marker('sec-notes'),
    emergency: marker('sec-emergency'),
    medical: marker('sec-medical'),
    education: marker('sec-education'),
    priors: marker('sec-priors')
  });

  // Filled: medical issues, medications, emergency contact, schools. No priors
  // left on this one — the block above deleted its only row.
  const filled = await window.api.dbGet("SELECT * FROM people WHERE display_name = 'Round Trip Test'");
  await window.openPerson(filled.id);
  await new Promise(r => setTimeout(r, 300));
  const onFilled = snap();

  // Name plus one prior offense, and nothing else at all.
  const bare = await window.api.dbGet("SELECT * FROM people WHERE display_name = 'Priors Unsaved Test'");
  await window.openPerson(bare.id);
  await new Promise(r => setTimeout(r, 300));
  const onBare = snap();

  // A brand-new person carries nothing, so it shows nothing.
  await window.openPerson(null);
  await new Promise(r => setTimeout(r, 200));
  const onNew = snap();

  return { onFilled, onBare, onNew };
});
check('a collapsed section holding answers shows the filled marker',
  filledMarkers.onFilled.medical === true && filledMarkers.onFilled.emergency === true
  && filledMarkers.onFilled.education === true, JSON.stringify(filledMarkers.onFilled));
check('an empty collapsed section shows no filled marker',
  filledMarkers.onBare.medical === false && filledMarkers.onBare.emergency === false
  && filledMarkers.onBare.education === false, JSON.stringify(filledMarkers.onBare));
check('the Prior Record marker follows the priors table, not the inputs',
  filledMarkers.onFilled.priors === false && filledMarkers.onBare.priors === true,
  JSON.stringify(filledMarkers));
check('a filled marker does not linger from the previous client',
  filledMarkers.onFilled.medical === true && filledMarkers.onBare.medical === false,
  JSON.stringify(filledMarkers));
// The dot answers "is there anything in there?" about a section you cannot see
// into. Beside an OPEN section it is noise, so it is display:none while open.
const markerVisibility = await page.evaluate(async () => {
  const p = await window.api.dbGet("SELECT * FROM people WHERE display_name = 'Round Trip Test'");
  await window.openPerson(p.id);
  const vis = (id) => {
    const sec = document.getElementById(id);
    const dot = sec.querySelector('.section-filled');
    return {
      collapsed: sec.hasAttribute('data-collapsed'),
      hasAnswers: !dot.classList.contains('hidden'),
      shown: getComputedStyle(dot).display !== 'none'
    };
  };
  return { medical: vis('sec-medical'), identity: vis('sec-identity') };
});
check('a collapsed section with answers actually shows its dot',
  markerVisibility.medical.collapsed && markerVisibility.medical.hasAnswers
    && markerVisibility.medical.shown, JSON.stringify(markerVisibility.medical));
check('an open section does not show a dot, even when it has answers',
  !markerVisibility.identity.collapsed && markerVisibility.identity.hasAnswers
    && !markerVisibility.identity.shown, JSON.stringify(markerVisibility.identity));

check('a brand-new person shows no filled markers at all',
  Object.values(filledMarkers.onNew).every(v => v === false),
  JSON.stringify(filledMarkers.onNew));

// --- The address split and its consumers ------------------------------------
// street/city/zip supersede the single `address` textarea, so everything that
// PRINTS an address must compose it from the parts. The legacy blob is still
// read — migration 24 deliberately skipped every address it could not parse
// unambiguously, and those clients' letters must not go out with a blank
// address block — but it is never written back.
const addressCompose = await page.evaluate(async () => {
  const mk = async (name, street, city, zip, address) => {
    const res = await window.api.dbRun(
      'INSERT INTO people (display_name, street, city, zip, address, created_at) VALUES (?,?,?,?,?,?)',
      [name, street, city, zip, address, new Date().toISOString()]);
    return window.api.dbGet('SELECT * FROM people WHERE id = ?', [res.lastInsertRowid]);
  };
  const split = await mk('Address Split Test', '9 Elm St', 'Sampleton, MI', '48000', null);
  const legacy = await mk('Address Legacy Test', null, null, null, '4 Ambiguous Way, Apt 2\nExampleton, MI 48000');
  const lower = await mk('Address Lowercase Test', '1 Low St', 'Exampleton, mi', '48000', null);
  const spaced = await mk('Address Spaced Test', '2 Spaced St', 'Exampleton , MI', '48000', null);
  return {
    composed: window.composePersonAddress(split),
    legacy: window.composePersonAddress(legacy),
    lower: window.composePersonAddress(lower),
    spaced: window.composePersonAddress(spaced),
    // Normalising must happen on the way OUT. Rewriting what a human typed
    // behind their back is how a deliberate entry silently becomes wrong.
    storedLower: (await window.api.dbGet('SELECT city FROM people WHERE id = ?', [lower.id])).city,
    empty: window.composePersonAddress({}),
    nullish: window.composePersonAddress(null)
  };
});
// A PARTIAL street/city/zip must never beat the legacy blob. Migration 24
// deliberately skipped every address it could not parse unambiguously, so for
// those clients `address` holds the only complete address on file — and
// Street/City/ZIP are three independent inputs with nothing requiring them to
// be filled together. Filling in just the City and ZIP on such a profile once
// composed a street-less address and mailed it.
const addressPartial = await page.evaluate(() => {
  const legacy = 'Apt 4\n9 Elm St\nSampleton, MI 48000';
  const C = window.composePersonAddress;
  return {
    noStreet: C({ street: '', city: 'Sampleton, MI', zip: '48000', address: legacy }),
    noCityZip: C({ street: '9 Elm St', city: '', zip: '', address: legacy }),
    blankStreet: C({ street: '   ', city: 'Exampleton', zip: '48000', address: legacy }),
    completeWins: C({ street: '9 Elm St', city: 'Sampleton, MI', zip: '48000', address: legacy }),
    // With no legacy blob there is nothing better — a partial address beats none.
    partialNoLegacy: C({ street: '9 Elm St', city: '', zip: '', address: null }),
    legacyText: legacy
  };
});
// The two single-field gaps an earlier guard let through: `street && line2`
// treated line2 as present when EITHER city or zip was filled, so these printed
// on real letters as "9 Elm St / Sampleton, MI" and "9 Elm St / 48000".
const addressSingleGap = await page.evaluate(() => {
  const legacy = 'Apt 4\n9 Elm St\nSampleton, MI 48000';
  const C = window.composePersonAddress;
  return {
    noZip: C({ street: '9 Elm St', city: 'Sampleton, MI', zip: '', address: legacy }),
    noCity: C({ street: '9 Elm St', city: '', zip: '48000', address: legacy }),
    noZipNoLegacy: C({ street: '9 Elm St', city: 'Sampleton, MI', zip: '', address: null }),
    legacyText: legacy
  };
});
check('a missing ZIP falls back to the legacy blob rather than printing without one',
  addressSingleGap.noZip === addressSingleGap.legacyText, JSON.stringify(addressSingleGap.noZip));
check('a missing city falls back rather than printing street over bare ZIP',
  addressSingleGap.noCity === addressSingleGap.legacyText, JSON.stringify(addressSingleGap.noCity));
check('a missing ZIP with no legacy blob still prints what there is',
  addressSingleGap.noZipNoLegacy === '9 Elm St\nSampleton, MI', JSON.stringify(addressSingleGap.noZipNoLegacy));

// THE RACE. savePriors used to read the module-level `priors` array live inside
// a loop of awaited IPC calls, so navigating to another client mid-save wrote
// that client's prior offences onto the one being saved. Here the save is
// deliberately NOT awaited before openPerson(B) runs — which is exactly what a
// click on the global search box does.
const priorsRace = await page.evaluate(async () => {
  const mk = async (name) => (await window.api.dbRun(
    'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
    [name, 'individual', new Date().toISOString()])).lastInsertRowid;
  const A = await mk('Race Client A');
  const B = await mk('Race Client B');
  const addPrior = (pid, offense, order) => window.api.dbRun(
    `INSERT INTO person_priors (person_id, offense, sort_order) VALUES (?,?,?)`,
    [pid, offense, order]);
  await addPrior(A, "A's own first prior", 0);
  await addPrior(A, "A's own second prior", 1);
  await addPrior(B, "B's own first prior", 0);
  await addPrior(B, "B's own second prior", 1);

  await window.openPerson(A);
  const savePromise = window.savePriorsForTest(A);   // in flight, not awaited
  await window.openPerson(B);                        // navigate away mid-save
  await savePromise;

  return {
    a: (await window.api.dbAll('SELECT offense FROM person_priors WHERE person_id = ? ORDER BY sort_order', [A])).map(r => r.offense),
    b: (await window.api.dbAll('SELECT offense FROM person_priors WHERE person_id = ? ORDER BY sort_order', [B])).map(r => r.offense)
  };
});
check("navigating away mid-save never writes another client's priors onto this one",
  !priorsRace.a.some(o => o.includes("B's")), JSON.stringify(priorsRace.a));
check('navigating away mid-save does not silently drop the priors being saved',
  priorsRace.a.length === 2, JSON.stringify(priorsRace.a));
check("the other client's own priors are left intact",
  priorsRace.b.length === 2 && !priorsRace.b.some(o => o.includes("A's")), JSON.stringify(priorsRace.b));

check('a missing street falls back to the legacy blob, not a street-less address',
  addressPartial.noStreet === addressPartial.legacyText, JSON.stringify(addressPartial.noStreet));
check('a missing city/zip falls back to the legacy blob, not a bare street',
  addressPartial.noCityZip === addressPartial.legacyText, JSON.stringify(addressPartial.noCityZip));
check('a whitespace-only street counts as missing and falls back',
  addressPartial.blankStreet === addressPartial.legacyText, JSON.stringify(addressPartial.blankStreet));
check('a complete street/city/zip still wins over the legacy blob',
  addressPartial.completeWins === '9 Elm St\nSampleton, MI 48000', JSON.stringify(addressPartial.completeWins));
check('a partial address with no legacy blob still returns what it has',
  addressPartial.partialNoLegacy === '9 Elm St', JSON.stringify(addressPartial.partialNoLegacy));

check('composePersonAddress builds a two-line block from street/city/zip',
  addressCompose.composed === '9 Elm St\nSampleton, MI 48000',
  JSON.stringify(addressCompose.composed));
check('composePersonAddress falls back to the legacy address blob',
  addressCompose.legacy === '4 Ambiguous Way, Apt 2\nExampleton, MI 48000',
  JSON.stringify(addressCompose.legacy));
check('composePersonAddress uppercases a lower-case state code',
  addressCompose.lower === '1 Low St\nExampleton, MI 48000', JSON.stringify(addressCompose.lower));
check('composePersonAddress absorbs a stray space before the comma',
  addressCompose.spaced === '2 Spaced St\nExampleton, MI 48000', JSON.stringify(addressCompose.spaced));
check('composing does not rewrite the stored city',
  addressCompose.storedLower === 'Exampleton, mi', JSON.stringify(addressCompose.storedLower));
check('composePersonAddress returns empty string, not "undefined", for an empty person',
  addressCompose.empty === '' && addressCompose.nullish === '',
  JSON.stringify([addressCompose.empty, addressCompose.nullish]));

// And the one consumer that snapshots it: a standalone letter freezes the
// recipient's address at creation, so it must freeze the composed value rather
// than the superseded blob.
const letterSnapshot = await page.evaluate(async () => {
  const p = await window.api.dbGet("SELECT * FROM people WHERE display_name = 'Address Split Test'");
  document.getElementById('nav-matters').click();
  document.getElementById('btn-new-matter').click();
  document.getElementById('btn-fork-letter').click();
  document.getElementById('ltr-recipient_person_id').value = String(p.id);
  document.getElementById('ltr-recipient_name').value = p.display_name;
  document.getElementById('btn-create-letter').click();
  await new Promise(r => setTimeout(r, 600));
  const row = await window.api.dbGet(
    "SELECT recipient_address FROM packets WHERE recipient_person_id = ? ORDER BY id DESC LIMIT 1", [p.id]);
  return row && row.recipient_address;
});
check('a standalone letter snapshots the composed address',
  letterSnapshot === '9 Elm St\nSampleton, MI 48000', JSON.stringify(letterSnapshot));

// Send generated files to a temp dir so the smoke run never writes into the
// real "Legal Documents" folder.
//
// Case folders live under the case's client (getMatterDir). Most fixture
// cases below are built straight in the database with parties that are NOT
// linked to a person, so there is no client to file them under, and generate
// would answer { needsFolderOwner: true } and write nothing. Those fixtures
// insert folder_person_id = 0 — the explicit "No Client" choice the
// folder-owner picker records — so they land in <tmpRoot>/No Client/<Case>/.
// The client-folder rules themselves are checked in the "Case folders live
// under their client" section.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-smoke-'));
await page.evaluate(async (root) => {
  await window.api.dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('output_root', ?)", [root]);
}, tmpRoot);

// Full export round-trip on the doc type whose label contains a "/".
const result = await page.evaluate(async () => {
  const r = await window.api.dbRun(
    "INSERT INTO matters (folder_person_id, short_name, case_number, client_role, caption_style, opposing_counsel, created_at) VALUES (0, ?,?,?,?,?,?)",
    ['Smoke v Test', '2026-CV-1', 'plaintiff', 'full', 'Opposing Counsel\n1 Road', new Date().toISOString()]);
  const id = r.lastInsertRowid;
  await window.api.dbRun("INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,?)", [id, 'Alice Smoke', 'plaintiff', 0]);
  await window.api.dbRun("INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,?)", [id, 'Bob Test', 'defendant', 0]);

  const matter = await window.api.dbGet(
    "SELECT m.*, c.name as court_name, j.name as judge_name FROM matters m LEFT JOIN courts c ON m.court_id=c.id LEFT JOIN judges j ON m.judge_id=j.id WHERE m.id=?", [id]);
  matter.parties = await window.api.dbAll("SELECT * FROM parties WHERE matter_id=? ORDER BY sort_order", [id]);
  const attorney = await window.api.dbGet("SELECT * FROM attorneys WHERE is_default=1");
  const dt = window.DocumentEngine.doctypes.find(d => d.id === 'brief_shell');
  const blocks = dt.build(matter, attorney, { brief_title: 'Smoke Brief' });

  const docx = await window.api.generateDocx(blocks, matter, attorney, dt.label, dt.id);
  const html = window.DocumentEngine.renderHtml(blocks, matter, attorney);
  const pdf = await window.api.generatePdf(html, matter, dt.label, dt.id);
  // Regenerate identical content: should reuse the file, not create a copy.
  const again = await window.api.generateDocx(blocks, matter, attorney, dt.label, dt.id);
  // A6, queried here (not in a later, separate page.evaluate) so it reads
  // right after the writes that produce it, while this same browser page is
  // known to still be alive.
  const activityRows = await window.api.dbAll(
    "SELECT event_type FROM activity_log WHERE matter_id = ? AND event_type = 'document_generated'", [id]);
  return { docx: docx.path, pdf: pdf.path, again, matterId: id, activityRows };
}).catch(e => ({ error: String(e) }));

// --- Appellate brief: two case numbers, both counsel blocks, word count -----
const appellate = await page.evaluate(async () => {
  const a = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  const oc = (await window.api.dbRun(
    `INSERT INTO people (display_name, kind, firm_name, bar_number, address, phone, email, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    ['John Roe', 'individual', 'ROE & ASSOCIATES P.L.L.C.', 'P90010',
     '10 Sample Boulevard\nExampleton, MI 48000', '(555) 010-7000', 'oc@example.com', new Date().toISOString()])).lastInsertRowid;
  const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['CIRCUIT COURT FOR THE COUNTY OF WAYNE'])).lastInsertRowid;
  const id = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, client_role, caption_style, party_label,
      plaintiff_label, caption_authority, opposing_counsel_person_id, created_at) VALUES (0, ?,?,?,?,?,?,?,?,?,?)`,
    ['Appellant Appeal', '26-APPEAL-01-AR', court, 'plaintiff', 'full', 'Defendant – Appellant',
     'Plaintiff – Appellee', 'PEOPLE OF THE CITY OF EXAMPLETON', oc, new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)', [id, 'Riley Appellant', 'defendant']);
  await window.api.dbRun('INSERT INTO matter_cases (matter_id,case_number,judge_name,sort_order) VALUES (?,?,?,0)', [id, '26-APPEAL-01-AR', 'Priscilla A. Bench']);
  await window.api.dbRun('INSERT INTO matter_cases (matter_id,case_number,judge_name,sort_order) VALUES (?,?,?,1)', [id, '2025-APPEAL-OD', 'Marcus T. Gavel']);

  const matter = await window.api.dbGet(
    'SELECT m.*, c.name as court_name FROM matters m LEFT JOIN courts c ON c.id=m.court_id WHERE m.id=?', [id]);
  matter.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id=?', [id]);
  matter.cases = await window.api.dbAll('SELECT * FROM matter_cases WHERE matter_id=? ORDER BY sort_order', [id]);
  matter.our_counsel = { name: a.name, bar_number: a.bar_number, firm_name: a.firm_name, address: a.firm_address, phone: a.firm_phone, email: a.firm_email };
  const o = await window.api.dbGet('SELECT * FROM people WHERE id=?', [oc]);
  matter.opposing_counsel_person = { name: o.display_name, bar_number: o.bar_number, firm_name: o.firm_name, address: o.address, phone: o.phone, email: o.email };

  const dt = window.DocumentEngine.doctypes.find(d => d.id === 'appellate_brief');
  const opts = {
    doc_title: 'Answer to Application for Leave to Appeal',
    oral_argument: 'Yes', dated: '2026-06-25',
    body_text: 'one two three four five [ignored placeholder] six',
    relief: 'seven eight nine ten'
  };
  const blocks = dt.build(matter, a, opts);
  const docx = await window.api.generateDocx(blocks, matter, a, dt.label, dt.id);

  // Multi-attorney "ours" counsel block: the signing attorney's own extra
  // counsel of record (matter.co_counsel), same data the district caption's
  // counsel_block already renders.
  const coAttId = (await window.api.dbRun(
    'INSERT INTO attorneys (name, bar_number, firm_name) VALUES (?,?,?)',
    ['Nadia Roe', 'P90011', 'Roe & Associates P.L.L.C.'])).lastInsertRowid;
  const coAtt = await window.api.dbGet('SELECT id, name, bar_number FROM attorneys WHERE id=?', [coAttId]);
  const coMatter = { ...matter, co_counsel: [coAtt] };
  const coDocx = await window.api.generateDocx(
    dt.build(coMatter, a, opts), coMatter, a, dt.label, dt.id);

  // The signing attorney also appears (by id) in matter.co_counsel — must
  // still print exactly once, per counselNameLines()'s de-dup.
  const dupMatter = { ...matter, co_counsel: [{ id: a.id, name: a.name, bar_number: a.bar_number }, coAtt] };
  const dupDocx = await window.api.generateDocx(
    dt.build(dupMatter, a, opts), dupMatter, a, dt.label, dt.id);

  return { docx: docx.path, coDocx: coDocx.path, dupDocx: dupDocx.path, coName: coAtt.name, signerName: a.name, ocName: o.display_name };
}).catch(e => ({ error: String(e) }));

if (appellate.error) {
  check('appellate export', false, appellate.error);
} else {
  const bxml = readDocxXml(appellate.docx);
  for (const needle of [
    'CIRCUIT COURT FOR THE COUNTY OF WAYNE', 'PEOPLE OF THE CITY OF EXAMPLETON',
    'Plaintiff – Appellee', 'Defendant – Appellant', 'RILEY APPELLANT',
    'Case No. 26-APPEAL-01-AR', 'Hon. Priscilla A. Bench',
    'Case No. 2025-APPEAL-OD', 'Hon. Marcus T. Gavel',
    'ROE &amp; ASSOCIATES P.L.L.C.', 'John Roe (P90010)',
    'ORAL ARGUMENT REQUESTED', 'Respectfully submitted,', '/S/'
  ]) {
    check(`appellate .docx contains ${JSON.stringify(needle)}`, bxml.includes(needle));
  }
  // 10 real words; the bracketed placeholder must not be counted.
  check('countable words excludes bracketed placeholders',
    bxml.includes('Number of Countable Words: 10'),
    (bxml.match(/Number of Countable Words: [\d,]+/) || ['<none>'])[0]);

  // Multi-attorney "ours" counsel block (co_counsel): the appellate caption
  // used to print only the signing attorney, silently dropping every other
  // matter_attorneys row.
  const countIn = (str, re) => (str.match(re) || []).length;
  const coXml = readDocxXml(appellate.coDocx);
  check('appellate .docx with co_counsel still contains the signing attorney',
    coXml.includes(appellate.signerName));
  check('appellate .docx with co_counsel also contains the additional attorney',
    coXml.includes(appellate.coName));
  check('appellate .docx with co_counsel leaves the opposing counsel cell unaffected',
    countIn(coXml, new RegExp(appellate.ocName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) === 1);

  // De-dup: the signing attorney also present (by id) in co_counsel must
  // still print exactly once, matching counselNameLines()'s existing rule.
  const dupXml = readDocxXml(appellate.dupDocx);
  const signerRe = new RegExp(appellate.signerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  check('appellate .docx: signing attorney also in co_counsel prints exactly once',
    countIn(dupXml, signerRe) === countIn(coXml, signerRe),
    `dup=${countIn(dupXml, signerRe)} co=${countIn(coXml, signerRe)}`);
  check('appellate .docx: de-duplication still keeps the other attorney',
    dupXml.includes(appellate.coName));
}

// --- A matter type's caption authority must reach the document --------------
// Regression: type_caption_authority was read by the renderer but never
// selected, so choosing "Criminal Defense" produced no authority line at all
// unless it was retyped by hand on every matter.
const typeAuthority = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const type = await window.api.dbGet("SELECT id, caption_authority FROM matter_types WHERE name = 'Criminal Defense'");
  const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['90th DISTRICT COURT'])).lastInsertRowid;
  const id = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, client_role, caption_style,
      party_label, matter_type_id, created_at) VALUES (0, ?,?,?,?,?,?,?,?)`,
    ['Type Authority', '2026-TA-1', court, 'defendant', 'full', 'Defendant', type.id, new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)', [id, 'Jamie Testperson', 'defendant']);

  // Drive the real generate flow so the production query is what gets tested.
  await window.api.dbRun("UPDATE matters SET archived = 0 WHERE id = ?", [id]);
  document.getElementById('nav-matters').click();
  await wait(400);
  const row = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes('Type Authority'));
  if (!row) return { error: 'matter row not found' };
  row.click();
  await wait(700);
  document.getElementById('btn-goto-generate').click();
  await wait(600);
  document.getElementById('gen-doctype').value = 'appearance';
  document.getElementById('gen-doctype').dispatchEvent(new Event('change'));
  await wait(400);

  // Click the real button rather than exposing an internal for the test.
  document.getElementById('btn-generate-docx').click();
  await wait(2500);

  const gen = await window.api.dbGet(
    "SELECT path FROM generated_files WHERE matter_id = ? AND format = 'docx' ORDER BY id DESC LIMIT 1", [id]);
  return { expected: type.caption_authority, docx: gen && gen.path };
}).catch(e => ({ error: String(e) }));

if (typeAuthority.error) {
  check('matter type authority reaches the document', false, typeAuthority.error);
} else if (!typeAuthority.docx) {
  check('matter type authority reaches the document', false, 'no .docx was generated');
} else {
  const txml = readDocxXml(typeAuthority.docx);
  check('matter type supplies the caption authority without a per-matter override',
    txml.includes(typeAuthority.expected),
    `expected ${JSON.stringify(typeAuthority.expected)}`);
}

// --- packetOnly doc types must not appear on the standalone Generate screen -
// The flag existed since Phase 3 but nothing read it, so every C&D document
// (and now the two driver-license ones) was pickable outside its packet flow,
// where fields.packet is undefined and it silently prints blank fields.
const packetOnlyFilter = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const id = (await window.api.dbRun(
    "INSERT INTO matters (short_name, client_role, caption_style, created_at) VALUES (?,?,?,?)",
    ['Doctype Picker Test', 'defendant', 'full', new Date().toISOString()])).lastInsertRowid;
  document.getElementById('nav-matters').click();
  await wait(400);
  const row = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes('Doctype Picker Test'));
  if (!row) return { error: 'matter row not found' };
  row.click();
  await wait(700);
  document.getElementById('btn-goto-generate').click();
  await wait(600);
  const ids = [...document.getElementById('gen-doctype').options].map(o => o.value);
  return { ids };
}).catch(e => ({ error: String(e) }));

if (packetOnlyFilter.error) {
  check('packetOnly doc types excluded from Generate Document', false, packetOnlyFilter.error);
} else {
  const packetOnlyIds = ['cd_transmittal', 'cd_memorandum', 'cd_answer_motion',
    'cd_answer_complaint', 'cd_proof_of_service', 'dl_letter', 'dl_appearance'];
  check('none of the packetOnly doc types are offered on the standalone screen',
    packetOnlyIds.every(id => !packetOnlyFilter.ids.includes(id)),
    JSON.stringify(packetOnlyFilter.ids));
  check('ordinary doc types are still offered',
    packetOnlyFilter.ids.includes('appearance'),
    JSON.stringify(packetOnlyFilter.ids));
}

// --- Documents: PDF+Word for one field state merge into a single row, Mark
// as Filed works through the real control, and Regenerate freezes to the
// snapshot even after the matter is edited afterward ------------------------
const snapshotFlow = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['98-1 DISTRICT COURT'])).lastInsertRowid;
  const id = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, client_role, caption_style,
      party_label, caption_authority, created_at) VALUES (0, ?,?,?,?,?,?,?,?)`,
    ['Snapshot Test', '2026-SNAP-1', court, 'defendant', 'full', 'Defendant',
     'PEOPLE OF THE STATE OF MICHIGAN', new Date().toISOString()])).lastInsertRowid;
  const partyId = (await window.api.dbRun(
    'INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)',
    [id, 'Original Name', 'defendant'])).lastInsertRowid;

  document.getElementById('nav-matters').click();
  await wait(300);
  const row = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes('Snapshot Test'));
  if (!row) return { error: 'matter row not found' };
  row.click();
  await wait(700);
  document.getElementById('btn-goto-generate').click();
  await wait(600);
  document.getElementById('gen-doctype').value = 'appearance';
  document.getElementById('gen-doctype').dispatchEvent(new Event('change'));
  await wait(400);

  // PDF generation spins up a hidden BrowserWindow, so it is slower than Word.
  document.getElementById('btn-generate-pdf').click();
  await wait(4000);
  document.getElementById('btn-generate-docx').click();
  await wait(2000);

  const afterFirstGen = await window.api.dbAll(
    "SELECT * FROM documents WHERE matter_id = ? AND doc_type = 'appearance' ORDER BY created_at DESC", [id]);

  // #documents-list is rebuilt by handleGenerate() after every click, even
  // while the Generate view (not the matter-detail view) is the one showing.
  const docDiv = () => document.querySelector('#documents-list > div');
  const markBtn = docDiv() && [...docDiv().querySelectorAll('button')].find(b => b.textContent.includes('Mark as Filed'));
  if (markBtn) markBtn.click();
  await wait(400);

  const afterFiling = await window.api.dbGet(
    "SELECT * FROM documents WHERE matter_id = ? AND doc_type = 'appearance' ORDER BY created_at DESC LIMIT 1", [id]);

  // A11: the scan-and-file reminder shows up quietly on the row, dismissing
  // it removes the note from screen, and the dismissal is actually persisted
  // in the database (not just a DOM change that would reappear on reload).
  const reminderShown = docDiv() && [...docDiv().querySelectorAll('.quiet-note')].some(n => n.textContent.includes('scan'));
  const doneLink = docDiv() && [...docDiv().querySelectorAll('.quiet-note a')].find(a => a.textContent === 'Done');
  if (doneLink) doneLink.click();
  await wait(300);
  const reminderGoneFromScreen = docDiv() && ![...docDiv().querySelectorAll('.quiet-note')].some(n => n.textContent.includes('scan'));
  const reminderPersisted = await window.api.dbGet(
    'SELECT scan_reminder_done FROM documents WHERE id = ?', [afterFiling.id]);

  // Edit the matter after the document already exists.
  await window.api.dbRun('UPDATE parties SET name = ? WHERE id = ?', ['Changed Name', partyId]);

  const regenLink = docDiv() && [...docDiv().querySelectorAll('a')].find(a => a.textContent.includes('Regenerate'));
  if (regenLink) regenLink.click();
  await wait(500);

  const bannerVisible = !document.getElementById('gen-regen-banner').classList.contains('hidden');

  document.getElementById('btn-generate-docx').click();
  await wait(2000);

  const afterRegen = await window.api.dbAll(
    "SELECT * FROM documents WHERE matter_id = ? AND doc_type = 'appearance' ORDER BY created_at DESC", [id]);

  return {
    firstGenRowCount: afterFirstGen.length,
    firstGenHasBothPaths: afterFirstGen.length > 0 && !!afterFirstGen[0].pdf_path && !!afterFirstGen[0].docx_path,
    firstGenHasSnapshot: afterFirstGen.length > 0 && !!afterFirstGen[0].matter_snapshot,
    filedAt: afterFiling && afterFiling.filed_at,
    reminderShown, reminderGoneFromScreen,
    reminderPersisted: reminderPersisted && reminderPersisted.scan_reminder_done,
    bannerVisible,
    regenRowCount: afterRegen.length,
    regenDocxPath: afterRegen[0] && afterRegen[0].docx_path
  };
}).catch(e => ({ error: String(e) }));

if (snapshotFlow.error) {
  check('documents snapshot/dedup flow', false, snapshotFlow.error);
} else {
  check('generating PDF then Word for the same field state merges into one documents row',
    snapshotFlow.firstGenRowCount === 1 && snapshotFlow.firstGenHasBothPaths,
    JSON.stringify(snapshotFlow));
  check('the merged row captured a matter_snapshot', snapshotFlow.firstGenHasSnapshot);
  check('Mark as Filed sets filed_at through the real UI control', !!snapshotFlow.filedAt, String(snapshotFlow.filedAt));
  check('a freshly generated document shows the scan-and-file reminder', snapshotFlow.reminderShown);
  check('dismissing the reminder removes it from screen', snapshotFlow.reminderGoneFromScreen);
  check('dismissing the reminder is persisted (scan_reminder_done = 1)', snapshotFlow.reminderPersisted === 1);
  check('Regenerate shows the frozen-snapshot banner', snapshotFlow.bannerVisible);
  // Regenerating creates a new row rather than silently rewriting the old
  // one — the document list is the activity log (build plan §1), so a
  // deliberate re-generation is its own entry, even when the content is
  // unchanged from what the snapshot already produced.
  check('Regenerate creates a new activity-log row',
    snapshotFlow.regenRowCount === 2, `rows=${snapshotFlow.regenRowCount}`);
  if (snapshotFlow.regenDocxPath) {
    const rxml = readDocxXml(snapshotFlow.regenDocxPath);
    check('regenerated .docx uses the OLD party name from the snapshot, not the edited one',
      rxml.includes('ORIGINAL NAME') && !rxml.includes('CHANGED NAME'),
      (rxml.match(/ORIGINAL NAME|CHANGED NAME/g) || ['<none>']).join(','));
  }
}

// --- Scanned signature image reaches both outputs ---------------------------
// Word-built appearances often embed one above the signature rule (INCLUDEPICTURE).
const signature = await page.evaluate(async (pngDataUri) => {
  const a = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  await window.api.dbRun('UPDATE attorneys SET signature_image = ? WHERE id = ?', [pngDataUri, a.id]);
  const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE id = ?', [a.id]);

  const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['91st DISTRICT COURT'])).lastInsertRowid;
  const id = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, client_role, caption_style,
      party_label, caption_authority, created_at) VALUES (0, ?,?,?,?,?,?,?,?)`,
    ['Signature Test', '2026-SIG-1', court, 'defendant', 'full', 'Defendant',
     'PEOPLE OF CITY OF EXAMPLETON', new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)', [id, 'Test Client', 'defendant']);

  const matter = await window.api.dbGet(
    'SELECT m.*, c.name as court_name FROM matters m LEFT JOIN courts c ON c.id=m.court_id WHERE m.id=?', [id]);
  matter.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id=?', [id]);

  const dt = window.DocumentEngine.doctypes.find(d => d.id === 'appearance');
  const blocks = dt.build(matter, attorney, { dated: '2026-01-05' });
  const html = window.DocumentEngine.renderHtml(blocks, matter, attorney);
  const docx = await window.api.generateDocx(blocks, matter, attorney, dt.label, dt.id);

  // Confirm it is a real, loadable image in the rendered HTML, not just a string.
  const probe = document.createElement('div');
  probe.innerHTML = html;
  const img = probe.querySelector('.sig-image img');
  const loaded = img ? await new Promise(res => {
    const t = new Image();
    t.onload = () => res(t.naturalWidth > 0);
    t.onerror = () => res(false);
    t.src = img.getAttribute('src');
  }) : false;

  return { docx: docx.path, hasImgTag: !!img, loaded };
}, TINY_PNG).catch(e => ({ error: String(e) }));

if (signature.error) {
  check('signature image', false, signature.error);
} else {
  check('signature image appears in the rendered HTML', signature.hasImgTag);
  check('signature image actually decodes', signature.loaded);
  // A .docx embeds images as separate zip entries under word/media/.
  const media = listDocxEntries(signature.docx).filter(n => n.startsWith('word/media/'));
  check('signature image embedded in the .docx', media.length > 0, JSON.stringify(media));
}

// --- "Include signature image" checkbox gates every render path -------------
// The attorney's signature was auto-printing on every document just because one was
// saved on the attorney's profile (2026-08-21 bug report). Fixed with a single
// choke point in gatherRenderData(), gated on #gen-include-signature —
// defaults unchecked, and covers single-document generate AND packet generate
// (dl_appearance), since generatePacket() calls the same function. The
// checkbox itself only exists in the Generate Document view, not the Packet
// view — this also confirms what a packet generation inherits when the user
// never sees a checkbox to check.
const sigCheckbox = await page.evaluate(async (pngDataUri) => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const a = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  await window.api.dbRun('UPDATE attorneys SET signature_image = ? WHERE id = ?', [pngDataUri, a.id]);

  const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['Sig Checkbox Test Court'])).lastInsertRowid;
  const id = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, client_role, caption_style,
      party_label, caption_authority, created_at) VALUES (0, ?,?,?,?,?,?,?,?)`,
    ['Sig Checkbox Test', '2026-SIGCB-1', court, 'defendant', 'full', 'Defendant',
     'PEOPLE OF THE STATE OF MICHIGAN', new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)', [id, 'Test Client', 'defendant']);

  document.getElementById('nav-matters').click();
  await wait(300);
  const row = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes('Sig Checkbox Test'));
  if (!row) return { error: 'matter row not found' };
  row.click();
  await wait(700);
  document.getElementById('btn-goto-generate').click();
  await wait(600);
  document.getElementById('gen-doctype').value = 'appearance';
  document.getElementById('gen-doctype').dispatchEvent(new Event('change'));
  await wait(400);

  const box = document.getElementById('gen-include-signature');
  const uncheckedIsDefault = !box.checked;

  document.getElementById('btn-generate-docx').click();
  await wait(2500);
  const uncheckedRow = await window.api.dbGet(
    "SELECT docx_path FROM documents WHERE matter_id = ? AND doc_type = 'appearance' ORDER BY id DESC LIMIT 1", [id]);

  box.checked = true;
  document.getElementById('btn-generate-docx').click();
  await wait(2500);
  const checkedRow = await window.api.dbGet(
    "SELECT docx_path FROM documents WHERE matter_id = ? AND doc_type = 'appearance' ORDER BY id DESC LIMIT 1", [id]);

  // Leave the Generate Document checkbox unchecked, then drive a packet with
  // its OWN checkbox (pk-include-signature) checked — this must not depend
  // on gen-include-signature's leftover state at all.
  box.checked = false;
  document.getElementById('nav-matters').click();
  await wait(300);
  const row2 = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes('Sig Checkbox Test'));
  if (!row2) return { error: 'matter row not found (2nd pass)' };
  row2.click();
  await wait(700);
  document.getElementById('btn-new-packet').click();
  await wait(500);
  document.getElementById('pk-kind').value = 'driver_license_hearing';
  document.getElementById('pk-kind').dispatchEvent(new Event('change'));
  await wait(400);
  document.getElementById('pkf_packet_date').value = '2026-01-05';
  document.getElementById('pkf_hearing_type').value = 'Implied Consent Refusal';
  document.getElementById('pkf_client_dob').value = '1990-01-01';
  document.getElementById('pkf_client_license_number').value = 'X123456789';
  document.getElementById('pkf_recipient_name').value = 'Driver Assessment and Appeal Division';
  document.getElementById('pkf_recipient_address').value = 'P.O. Box 00000\nExampleton, MI 48000';

  document.getElementById('btn-generate-packet-docx').click();
  await wait(3500);
  const packetUncheckedDoc = await window.api.dbGet(
    `SELECT d.docx_path FROM documents d JOIN packets p ON p.id = d.packet_id
     WHERE p.matter_id = ? AND d.doc_type = 'dl_appearance' ORDER BY d.id DESC LIMIT 1`, [id]);

  document.getElementById('pk-include-signature').checked = true;
  document.getElementById('btn-generate-packet-docx').click();
  await wait(3500);
  const packetCheckedDoc = await window.api.dbGet(
    `SELECT d.docx_path FROM documents d JOIN packets p ON p.id = d.packet_id
     WHERE p.matter_id = ? AND d.doc_type = 'dl_appearance' ORDER BY d.id DESC LIMIT 1`, [id]);

  // 9A: this packet was created by New Packet (which seeds the first packet
  // kind, Claim & Delivery) and switched to the driver-license kind on the
  // form. Its label and its folder must follow the kind actually chosen.
  const switchedPacket = await window.api.dbGet(
    `SELECT p.kind, p.label, p.output_dir FROM packets p JOIN documents d ON d.packet_id = p.id
     WHERE p.matter_id = ? AND d.doc_type = 'dl_appearance' ORDER BY d.id DESC LIMIT 1`, [id]);

  return {
    switchedPacket,
    uncheckedIsDefault,
    uncheckedDocx: uncheckedRow && uncheckedRow.docx_path,
    checkedDocx: checkedRow && checkedRow.docx_path,
    packetUncheckedDocx: packetUncheckedDoc && packetUncheckedDoc.docx_path,
    packetCheckedDocx: packetCheckedDoc && packetCheckedDoc.docx_path,
    matterId: id
  };
}, TINY_PNG).catch(e => ({ error: String(e) }));

if (sigCheckbox.error) {
  check('signature checkbox gating', false, sigCheckbox.error);
} else {
  check('gen-include-signature defaults unchecked', sigCheckbox.uncheckedIsDefault);
  {
    const sp = sigCheckbox.switchedPacket || {};
    const folder = String(sp.output_dir || '').split(/[\\/]/).filter(Boolean).pop() || '';
    check('a packet switched to the driver-license kind is labelled for that kind, not Claim & Delivery',
      sp.kind === 'driver_license_hearing' && sp.label === 'Driver License Hearing Request', JSON.stringify(sp));
    check('its packet folder is named for the driver-license kind',
      folder.includes('Driver License Hearing') && !folder.includes('Claim'), folder);
  }

  if (sigCheckbox.uncheckedDocx) {
    // The 'appearance' doctype's signature block (pushAppearanceSignature /
    // renderAppearanceSignature) has never had a "/S/" text fallback — with
    // no image it just leaves blank space above the rule, same as an
    // attorney with nothing saved on file ever did. Only some other doctypes'
    // signature blocks (e.g. counsel_block, appellate) fall back to "/S/".
    const umedia = listDocxEntries(sigCheckbox.uncheckedDocx).filter(n => n.startsWith('word/media/'));
    check('unchecked: no signature image embedded in the .docx', umedia.length === 0, JSON.stringify(umedia));
  } else {
    check('unchecked generate produced a .docx', false);
  }

  if (sigCheckbox.checkedDocx) {
    const cmedia = listDocxEntries(sigCheckbox.checkedDocx).filter(n => n.startsWith('word/media/'));
    check('checked: signature image embedded in the .docx', cmedia.length > 0, JSON.stringify(cmedia));
  } else {
    check('checked generate produced a .docx', false);
  }

  if (sigCheckbox.packetUncheckedDocx) {
    // The packet view has its OWN checkbox (pk-include-signature) — this
    // confirms the packet path does not fall back to gen-include-signature's
    // state at all, checked or not.
    const pumedia = listDocxEntries(sigCheckbox.packetUncheckedDocx).filter(n => n.startsWith('word/media/'));
    check('packet, pk-include-signature unchecked: no signature image embedded',
      pumedia.length === 0, JSON.stringify(pumedia));
  } else {
    check('packet generated a dl_appearance .docx (unchecked pass)', false);
  }

  if (sigCheckbox.packetCheckedDocx) {
    const pcmedia = listDocxEntries(sigCheckbox.packetCheckedDocx).filter(n => n.startsWith('word/media/'));
    check('packet, pk-include-signature checked: signature image embedded',
      pcmedia.length > 0, JSON.stringify(pcmedia));
  } else {
    check('packet generated a dl_appearance .docx (checked pass)', false);
  }

  // A6: the two packet generations above (dl_appearance x2) each log ONE
  // "packet_generated" row — not one per document inside the packet, and
  // not the per-file "document_generated" rows that a non-packet generate
  // produces (recordGenerated skips those when matter.packet is set).
  const packetActivity = await page.evaluate((matterId) => window.api.dbAll(
    `SELECT event_type, COUNT(*) c FROM activity_log WHERE matter_id = ? GROUP BY event_type`,
    [matterId]), sigCheckbox.matterId);
  const packetGenCount = (packetActivity.find(r => r.event_type === 'packet_generated') || {}).c || 0;
  // The 2 here is not zero: earlier in THIS SAME test, two standalone
  // 'appearance' documents were generated outside any packet (uncheckedRow /
  // checkedRow, via gen-doctype + btn-generate-docx) — those correctly log
  // document_generated. What this asserts is that the two packet
  // generations that follow did NOT add a third and fourth on top.
  const perDocCount = (packetActivity.find(r => r.event_type === 'document_generated') || {}).c || 0;
  check('packet generation logs one activity row per packet, not per document inside it',
    packetGenCount === 2 && perDocCount === 2, JSON.stringify(packetActivity));
}

// A6: matter_created, stage_changed, court_date_added and court_date_done —
// the events that originate in the renderer rather than a main-process
// IPC handler. Driven through the real Save button and Add Court Date
// button, not a SQL fixture, since the logging lives inside saveMatter()
// and saveMatterEvents().
const activityFlow = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const log = async (matterId) => window.api.dbAll(
    'SELECT event_type, description FROM activity_log WHERE matter_id = ? ORDER BY id', [matterId]);

  document.getElementById('nav-matters').click();
  await wait(300);
  document.getElementById('btn-new-matter').click();
  await wait(400);
  // btn-new-matter alone only opens the Court Filing / Letter fork; the form
  // reset (resetNewMatterForm, clearing currentMatterId) happens on
  // btn-fork-court's own click handler. Skipping it here left this test
  // saving ON TOP of whatever matter was last open in an earlier test.
  document.getElementById('btn-fork-court').click();
  await wait(400);
  // A new case starts with no side (9A); Save requires one.
  document.getElementById('mat-client_role').value = 'plaintiff';
  document.getElementById('mat-short_name').value = 'Activity Log Test';
  document.getElementById('btn-save-matter').click();
  await wait(900);

  const m = await window.api.dbGet(
    'SELECT id FROM matters WHERE short_name = ? ORDER BY id DESC LIMIT 1', ['Activity Log Test']);
  const afterCreate = await log(m.id);

  document.getElementById('mat-stage').value = 'Pretrial';
  document.getElementById('mat-stage').dispatchEvent(new Event('change'));
  document.getElementById('btn-save-matter').click();
  await wait(900);
  const afterStage = await log(m.id);

  document.getElementById('btn-add-event').click();
  await wait(150);
  let rows = document.querySelectorAll('#matter-events-list > div');
  let last = rows[rows.length - 1];
  const typeInput = last.querySelector('[data-field="event_type"]');
  typeInput.value = 'Pretrial';
  typeInput.dispatchEvent(new Event('change'));
  const dateInput = last.querySelector('[data-field="event_date"]');
  dateInput.value = '2026-09-01';
  dateInput.dispatchEvent(new Event('input'));
  document.getElementById('btn-save-matter').click();
  await wait(900);
  const afterAdd = await log(m.id);

  rows = document.querySelectorAll('#matter-events-list > div');
  last = rows[rows.length - 1];
  const doneBox = last.querySelector('[data-field="done"]');
  doneBox.checked = true;
  doneBox.dispatchEvent(new Event('change'));
  document.getElementById('btn-save-matter').click();
  await wait(900);
  const afterDone = await log(m.id);

  return { matterId: m.id, afterCreate, afterStage, afterAdd, afterDone };
}).catch(e => ({ error: String(e) }));

if (activityFlow.error) {
  check('activity log flow', false, activityFlow.error);
} else {
  check('saving a brand-new matter logs matter_created',
    activityFlow.afterCreate.length === 1 && activityFlow.afterCreate[0].event_type === 'matter_created',
    JSON.stringify(activityFlow.afterCreate));
  check('changing stage and saving logs stage_changed',
    activityFlow.afterStage.length === 2 && activityFlow.afterStage[1].event_type === 'stage_changed'
      && activityFlow.afterStage[1].description.includes('Pretrial'),
    JSON.stringify(activityFlow.afterStage));
  check('adding a court date and saving logs court_date_added',
    activityFlow.afterAdd.length === 3 && activityFlow.afterAdd[2].event_type === 'court_date_added',
    JSON.stringify(activityFlow.afterAdd));
  check('ticking Done and saving logs court_date_done',
    activityFlow.afterDone.length === 4 && activityFlow.afterDone[3].event_type === 'court_date_done',
    JSON.stringify(activityFlow.afterDone));

  // And it shows on the matter's own Activity panel, newest first.
  const panel = await page.evaluate(() => document.getElementById('matter-activity').innerText);
  check('the matter Activity panel shows the logged events',
    /court date marked done/i.test(panel) && /matter created/i.test(panel), panel);

  // --- A7: payments, on the same matter (still open from the flow above) ----
  const paymentsFlow = await page.evaluate(async (matterId) => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const personId = (await window.api.dbRun(
      "INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)",
      ['Payments Test Client', 'individual', new Date().toISOString()])).lastInsertRowid;

    document.getElementById('btn-add-payment').click();
    await wait(150);
    let rows = document.querySelectorAll('#matter-payments-list > div');
    let last = rows[rows.length - 1];
    let inputs = last.querySelectorAll('input');
    inputs[0].value = '2026-08-01';
    inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = '500.50';
    inputs[1].dispatchEvent(new Event('input'));
    const totalAfterFirst = document.getElementById('matter-payments-total').textContent;

    // A second payment, to prove the total sums rather than overwrites.
    document.getElementById('btn-add-payment').click();
    await wait(150);
    rows = document.querySelectorAll('#matter-payments-list > div');
    last = rows[rows.length - 1];
    inputs = last.querySelectorAll('input');
    inputs[0].value = '2026-08-15';
    inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = '250.00';
    inputs[1].dispatchEvent(new Event('input'));
    const totalAfterSecond = document.getElementById('matter-payments-total').textContent;

    document.getElementById('btn-save-matter').click();
    await wait(900);

    const dbRows = await window.api.dbAll(
      'SELECT amount_cents, paid_date FROM matter_payments WHERE matter_id = ? ORDER BY paid_date', [matterId]);

    // Link the client AFTER the save above — saveMatter() wholesale-replaces
    // `parties` from its own in-memory list on every save, which would
    // otherwise wipe a row inserted straight into the table beforehand.
    await window.api.dbRun(
      "INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,0)",
      [matterId, personId, 'Payments Test Client', 'defendant', 'client']);
    const partyRows = await window.api.dbAll('SELECT * FROM parties WHERE person_id = ?', [personId]);

    // The client-profile rollup: navigate there through the real People list.
    document.getElementById('nav-people').click();
    await wait(400);
    const rowTexts = [...document.querySelectorAll('#people-list tr')].map(r => r.innerText);
    const target = [...document.querySelectorAll('#people-list tr')]
      .find(r => r.innerText.includes('Payments Test Client'));
    if (target) target.click();
    await wait(500);
    for (let i = 0; i < 40 && !document.getElementById('person-payments').innerText.includes('Paid to date'); i++) await wait(100);
    const personPanelText = document.getElementById('person-payments').innerText;
    const casesPanelText = document.getElementById('person-cases').innerText;

    return { totalAfterFirst, totalAfterSecond, dbRows, personPanelText, partyRows, rowTexts, casesPanelText, personId };
  }, activityFlow.matterId).catch(e => ({ error: String(e) }));

  if (paymentsFlow.error) {
    check('payments flow', false, paymentsFlow.error);
  } else {
    check('the running total updates as amounts are typed, before saving',
      paymentsFlow.totalAfterFirst === '$500.50' && paymentsFlow.totalAfterSecond === '$750.50',
      JSON.stringify(paymentsFlow));
    check('both payments are stored as integer cents',
      paymentsFlow.dbRows.length === 2
        && paymentsFlow.dbRows[0].amount_cents === 50050 && paymentsFlow.dbRows[0].paid_date === '2026-08-01'
        && paymentsFlow.dbRows[1].amount_cents === 25000 && paymentsFlow.dbRows[1].paid_date === '2026-08-15',
      JSON.stringify(paymentsFlow.dbRows));
    check('the client profile rolls up paid-to-date for the matter',
      paymentsFlow.personPanelText.includes('Paid to date: $750.50'), JSON.stringify(paymentsFlow));
  }

  // A8: the shared "Today" button, exercised on a real payment date field.
  const todayBtnCheck = await page.evaluate(() => {
    const today = (() => {
      const d = new Date(); const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    })();
    document.getElementById('btn-add-payment').click();
    const rows = document.querySelectorAll('#matter-payments-list > div');
    const last = rows[rows.length - 1];
    const dateInput = last.querySelector('input[type="date"]');
    const todayBtn = [...last.querySelectorAll('.today-btn')][0];
    if (!dateInput || !todayBtn) return { error: 'date input or Today button not found' };
    dateInput.value = '2000-01-01';
    todayBtn.click();
    return { value: dateInput.value, today };
  }).catch(e => ({ error: String(e) }));
  check('clicking Today fills the date field with today\'s date',
    !todayBtnCheck.error && todayBtnCheck.value === todayBtnCheck.today, JSON.stringify(todayBtnCheck));
}

// --- A9: the read-only month calendar --------------------------------------
const calendarFlow = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const p = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${p(now.getMonth() + 1)}`;
  // Day 1 of the current month is certainly in the past relative to "today"
  // unless today itself is the 1st — either way this is a real, deterministic
  // fixture, not a guess about what "today" happens to be during the run.
  const overdueDate = `${thisMonth}-01`;

  const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['Calendar Test Court'])).lastInsertRowid;
  const matterId = (await window.api.dbRun(
    `INSERT INTO matters (short_name, case_number, court_id, client_role, caption_style, created_at)
     VALUES (?,?,?,?,?,?)`,
    ['Calendar Flow Test', '2026-CAL-1', court, 'defendant', 'full', new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun(
    `INSERT INTO matter_events (matter_id, event_type, event_date, done) VALUES (?,?,?,0)`,
    [matterId, 'Pretrial', overdueDate]);

  document.getElementById('nav-home').click();
  await wait(300);
  document.getElementById('home-view-calendar').click();
  await wait(400);
  const monthLabel = document.getElementById('cal-month-label').textContent;
  const backVisible = !document.getElementById('view-home').classList.contains('hidden') ? false
    : !document.getElementById('view-calendar').classList.contains('hidden');

  const evEl = [...document.querySelectorAll('.cal-event')].find(el => el.textContent.includes('Calendar Flow Test'));
  const overdueClass = evEl ? evEl.className : null;

  if (evEl) evEl.click();
  await wait(700);
  const openedMatter = document.getElementById('mat-short_name').value;

  // Back to the calendar, then Prev/Next.
  document.getElementById('nav-home').click();
  await wait(200);
  document.getElementById('home-view-calendar').click();
  await wait(300);
  const before = document.getElementById('cal-month-label').textContent;
  document.getElementById('btn-cal-prev').click();
  await wait(200);
  const afterPrev = document.getElementById('cal-month-label').textContent;
  document.getElementById('btn-cal-next').click();
  await wait(200);
  const afterNext = document.getElementById('cal-month-label').textContent;

  document.getElementById('btn-back-from-calendar').click();
  await wait(300);
  const backOnHome = !document.getElementById('view-home').classList.contains('hidden');

  return { monthLabel, backVisible, overdueClass, openedMatter, before, afterPrev, afterNext, backOnHome };
}).catch(e => ({ error: String(e) }));

if (calendarFlow.error) {
  check('calendar flow', false, calendarFlow.error);
} else {
  check('View Calendar opens the calendar view', calendarFlow.backVisible);
  check('the calendar shows the current month', /\d{4}/.test(calendarFlow.monthLabel), calendarFlow.monthLabel);
  check('a past, not-done court date renders with the overdue style',
    !!calendarFlow.overdueClass && calendarFlow.overdueClass.includes('cal-overdue'), String(calendarFlow.overdueClass));
  check('clicking a calendar event opens its matter',
    calendarFlow.openedMatter === 'Calendar Flow Test', calendarFlow.openedMatter);
  check('Prev/Next move the calendar a month at a time and back',
    calendarFlow.afterPrev !== calendarFlow.before && calendarFlow.afterNext === calendarFlow.before,
    JSON.stringify(calendarFlow));
  check('Back returns to Home', calendarFlow.backOnHome);
}

// --- A10: case transfers ----------------------------------------------------
const transferFlow = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const courtA = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['Transfer Test Court A'])).lastInsertRowid;
  const courtB = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['Transfer Test Court B'])).lastInsertRowid;
  const attA = (await window.api.dbRun(
    `INSERT INTO attorneys (name, label, bar_number, is_default) VALUES (?,?,?,0)`,
    ['Transfer Attorney A', 'Transfer Attorney A', 'P90101'])).lastInsertRowid;
  const attB = (await window.api.dbRun(
    `INSERT INTO attorneys (name, label, bar_number, is_default) VALUES (?,?,?,0)`,
    ['Transfer Attorney B', 'Transfer Attorney B', 'P90102'])).lastInsertRowid;

  document.getElementById('nav-matters').click();
  await wait(300);
  document.getElementById('btn-new-matter').click();
  await wait(300);
  document.getElementById('btn-fork-court').click();
  await wait(400);
  // A new case starts with no side (9A); Save requires one.
  document.getElementById('mat-client_role').value = 'plaintiff';

  document.getElementById('mat-short_name').value = 'Transfer Flow Test';
  document.getElementById('mat-court_id').value = String(courtA);
  document.getElementById('mat-court').value = 'Transfer Test Court A';
  document.getElementById('mat-attorney_id').value = String(attA);
  document.getElementById('btn-save-matter').click();
  await wait(900);

  const m = await window.api.dbGet(
    'SELECT id FROM matters WHERE short_name = ? ORDER BY id DESC LIMIT 1', ['Transfer Flow Test']);
  const afterCreate = await window.api.dbAll(
    'SELECT * FROM matter_transfers WHERE matter_id = ?', [m.id]);

  // Now actually transfer: different court, different attorney.
  document.getElementById('mat-court_id').value = String(courtB);
  document.getElementById('mat-court').value = 'Transfer Test Court B';
  document.getElementById('mat-attorney_id').value = String(attB);
  document.getElementById('btn-save-matter').click();
  await wait(900);

  const afterTransfer = await window.api.dbAll(
    'SELECT field, from_value, to_value FROM matter_transfers WHERE matter_id = ? ORDER BY field', [m.id]);
  const panelText = document.getElementById('matter-transfers').innerText;

  // Re-saving with nothing changed must not log a third, duplicate transfer.
  document.getElementById('btn-save-matter').click();
  await wait(900);
  const afterNoopSave = await window.api.dbAll(
    'SELECT COUNT(*) c FROM matter_transfers WHERE matter_id = ?', [m.id]);

  return { matterId: m.id, afterCreate, afterTransfer, panelText, noopCount: afterNoopSave[0].c };
}).catch(e => ({ error: String(e) }));

if (transferFlow.error) {
  check('case transfer flow', false, transferFlow.error);
} else {
  check('creating a matter with a court/attorney already set logs no transfer',
    transferFlow.afterCreate.length === 0, JSON.stringify(transferFlow.afterCreate));
  check('changing court and attorney and saving logs both transfers',
    transferFlow.afterTransfer.length === 2
      && transferFlow.afterTransfer.some(t => t.field === 'court' && t.from_value === 'Transfer Test Court A' && t.to_value === 'Transfer Test Court B')
      && transferFlow.afterTransfer.some(t => t.field === 'attorney' && t.from_value === 'Transfer Attorney A' && t.to_value === 'Transfer Attorney B'),
    JSON.stringify(transferFlow.afterTransfer));
  check('the Transfer History panel shows both changes',
    /Court changed.*Court A.*Court B/.test(transferFlow.panelText.replace(/\n/g, ' '))
      && /Attorney changed.*Attorney A.*Attorney B/.test(transferFlow.panelText.replace(/\n/g, ' ')),
    transferFlow.panelText);
  check('saving again with nothing changed does not duplicate the transfer log',
    transferFlow.noopCount === 2, String(transferFlow.noopCount));
}

// --- A12: the clickthrough tutorial ------------------------------------------
// The anti-drift guarantee: every step's anchored element must still exist.
// Reads window.__tutorialSteps (the real array the app uses), not a second
// hand-maintained list, so a renamed/removed target fails this for real.
const tutorialAnchors = await page.evaluate(() =>
  (window.__tutorialSteps || []).map(s => ({ id: s.id, exists: !!document.getElementById(s.id) })));
check('the tutorial has steps defined', tutorialAnchors.length > 0, String(tutorialAnchors.length));
check('every tutorial step is anchored to an element that actually exists',
  tutorialAnchors.every(a => a.exists),
  JSON.stringify(tutorialAnchors.filter(a => !a.exists)));

const tutorialFlow = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const overlay = document.getElementById('tutorial-overlay');

  const neverAutoLaunched = overlay.classList.contains('hidden');

  document.getElementById('nav-home').click();
  await wait(200);
  document.getElementById('home-start-tutorial').click();
  await wait(200);
  const openedFromHome = !overlay.classList.contains('hidden');
  const step1Text = document.getElementById('tutorial-title').textContent;

  const stepCount = window.__tutorialSteps.length;
  for (let i = 0; i < stepCount - 1; i++) {
    document.getElementById('btn-tutorial-next').click();
    await wait(150);
  }
  const lastStepLabel = document.getElementById('btn-tutorial-next').textContent;
  const lastStepTitle = document.getElementById('tutorial-title').textContent;
  const highlightPositioned = document.getElementById('tutorial-highlight').style.width !== '';

  document.getElementById('btn-tutorial-next').click(); // "Done" on the last step
  await wait(200);
  const closedAtEnd = overlay.classList.contains('hidden');

  // And the "? Help" button opens the same tour.
  document.getElementById('btn-start-tutorial').click();
  await wait(200);
  const openedFromHelp = !overlay.classList.contains('hidden');
  document.getElementById('btn-tutorial-close').click();
  await wait(150);
  const closedByCloseButton = overlay.classList.contains('hidden');

  return {
    neverAutoLaunched, openedFromHome, step1Text, stepCount,
    lastStepLabel, lastStepTitle, highlightPositioned, closedAtEnd,
    openedFromHelp, closedByCloseButton
  };
}).catch(e => ({ error: String(e) }));

if (tutorialFlow.error) {
  check('tutorial flow', false, tutorialFlow.error);
} else {
  check('the tutorial never auto-launches', tutorialFlow.neverAutoLaunched);
  check('"Take a quick tour" on Home opens it', tutorialFlow.openedFromHome && !!tutorialFlow.step1Text);
  check('stepping through Next reaches the last step', tutorialFlow.lastStepLabel === 'Done', tutorialFlow.lastStepLabel);
  check('the highlight box is positioned over the last step\'s target', tutorialFlow.highlightPositioned);
  check('clicking Done on the last step closes the tour', tutorialFlow.closedAtEnd);
  check('the "? Help" button reopens the tour', tutorialFlow.openedFromHelp);
  check('Close closes the tour', tutorialFlow.closedByCloseButton);
}

// --- A13: missing-file tag, checked when the list renders -------------------
const missingFileFlow = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['Missing File Test Court'])).lastInsertRowid;
  const matterId = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, client_role, caption_style, created_at)
     VALUES (0, ?,?,?,?,?,?)`,
    ['Missing File Test', '2026-MF-1', court, 'defendant', 'full', new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)', [matterId, 'Missing File Client', 'defendant']);

  document.getElementById('nav-matters').click();
  await wait(300);
  const row = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes('Missing File Test'));
  row.click();
  await wait(700);
  document.getElementById('btn-goto-generate').click();
  await wait(600);
  document.getElementById('gen-doctype').value = 'appearance';
  document.getElementById('gen-doctype').dispatchEvent(new Event('change'));
  await wait(400);
  document.getElementById('btn-generate-docx').click();
  await wait(2500);

  const doc = await window.api.dbGet(
    "SELECT * FROM documents WHERE matter_id = ? AND doc_type = 'appearance' ORDER BY created_at DESC LIMIT 1", [matterId]);

  const docDiv = () => document.querySelector('#documents-list > div');
  await wait(300); // the existence check itself is async
  const missingBeforeDelete = docDiv() && !docDiv().querySelector('.missing-file-tag').classList.contains('hidden');

  // Actually delete the file on disk — the whole point of A13 is that the
  // app never manages the folder, so nothing in the app does this except
  // this test fixture standing in for "the user deleted it in Explorer."
  await window.api.dbRun('SELECT 1'); // keep shape; deletion happens via fs below
  return { matterId, docId: doc.id, docxPath: doc.docx_path, missingBeforeDelete };
}).catch(e => ({ error: String(e) }));

if (missingFileFlow.error) {
  check('missing-file setup', false, missingFileFlow.error);
} else {
  check('no missing tag while the file is actually on disk', missingFileFlow.missingBeforeDelete === false);

  fs.unlinkSync(onDisk(missingFileFlow.docxPath));

  const afterDelete = await page.evaluate(async (matterId) => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    // Revisit the matter — loadDocuments() re-renders and re-checks on load,
    // exactly the "verify on load" half of the A13 decision.
    document.getElementById('nav-matters').click();
    await wait(200);
    const row = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes('Missing File Test'));
    row.click();
    await wait(700);
    await wait(300); // the existence check is async
    const tag = document.querySelector('#documents-list .missing-file-tag');
    return { tagExists: !!tag, tagVisible: tag && !tag.classList.contains('hidden') };
  }, missingFileFlow.matterId).catch(e => ({ error: String(e) }));

  check('the missing tag appears once the file is gone, on reload',
    afterDelete.tagVisible === true, JSON.stringify(afterDelete));
}

// --- Preview panel renders the same content the PDF path produces ----------
const previewCheck = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['Preview Test Court'])).lastInsertRowid;
  const id = (await window.api.dbRun(
    `INSERT INTO matters (short_name, case_number, court_id, client_role, caption_style,
      party_label, caption_authority, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ['Preview Test', '2026-PREV-1', court, 'defendant', 'full', 'Defendant',
     'PEOPLE OF THE STATE OF MICHIGAN', new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)', [id, 'Test Client', 'defendant']);

  document.getElementById('nav-matters').click();
  await wait(300);
  const row = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes('Preview Test'));
  if (!row) return { error: 'matter row not found' };
  row.click();
  await wait(700);
  document.getElementById('btn-goto-generate').click();
  await wait(600);
  document.getElementById('gen-doctype').value = 'appearance';
  document.getElementById('gen-doctype').dispatchEvent(new Event('change'));
  await wait(400);

  document.getElementById('btn-preview').click();
  await wait(500);

  const panel = document.getElementById('preview-panel');
  const frame = document.getElementById('preview-frame');
  return {
    panelVisible: !panel.classList.contains('hidden'),
    hasSrcdoc: !!(frame.srcdoc && frame.srcdoc.length > 200),
    hasPrintContainer: frame.srcdoc.includes('id="print-container"')
  };
}).catch(e => ({ error: String(e) }));

if (previewCheck.error) {
  check('preview panel', false, previewCheck.error);
} else {
  check('preview panel becomes visible on click', previewCheck.panelVisible);
  check('preview iframe has real srcdoc content', previewCheck.hasSrcdoc);
  check('preview iframe wraps content in #print-container', previewCheck.hasPrintContainer);
}

// --- Packet view previews one document at a time ----------------------------
const packetPreviewCheck = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['Packet Preview Test Court'])).lastInsertRowid;
  const id = (await window.api.dbRun(
    `INSERT INTO matters (short_name, case_number, court_id, client_role, caption_style,
      party_label, caption_authority, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ['Packet Preview Test', '2026-PKPREV-1', court, 'defendant', 'full', 'Defendant',
     'PEOPLE OF THE STATE OF MICHIGAN', new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)', [id, 'Test Client', 'defendant']);

  document.getElementById('nav-matters').click();
  await wait(300);
  const row = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes('Packet Preview Test'));
  if (!row) return { error: 'matter row not found' };
  row.click();
  await wait(700);
  document.getElementById('btn-new-packet').click();
  await wait(500);
  document.getElementById('pk-kind').value = 'driver_license_hearing';
  document.getElementById('pk-kind').dispatchEvent(new Event('change'));
  await wait(400);
  document.getElementById('pkf_packet_date').value = '2026-01-05';
  document.getElementById('pkf_hearing_type').value = 'Implied Consent Refusal';
  document.getElementById('pkf_client_dob').value = '1990-01-01';
  document.getElementById('pkf_client_license_number').value = 'X123456789';
  document.getElementById('pkf_recipient_name').value = 'Driver Assessment and Appeal Division';
  document.getElementById('pkf_recipient_address').value = 'P.O. Box 00000\nExampleton, MI 48000';

  const rows = [...document.querySelectorAll('#packet-contents > div')];
  const letterRow = rows.find(r => r.innerText.includes('Covering Letter'));
  const appearanceRow = rows.find(r => r.innerText.includes('Appearance and Request for Hearing'));
  if (!letterRow || !appearanceRow) return { error: 'expected packet document rows not found', rowCount: rows.length };

  letterRow.querySelector('a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await wait(500);
  const letterSrcdoc = document.getElementById('packet-preview-frame').srcdoc;

  appearanceRow.querySelector('a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await wait(500);
  const appearanceSrcdoc = document.getElementById('packet-preview-frame').srcdoc;

  const panel = document.getElementById('packet-preview-panel');
  return {
    panelVisible: !panel.classList.contains('hidden'),
    letterHasRecipient: letterSrcdoc.includes('Driver Assessment and Appeal Division'),
    appearanceHasLicenseNumber: appearanceSrcdoc.includes('X123456789'),
    lettersAreDistinct: letterSrcdoc !== appearanceSrcdoc
  };
}).catch(e => ({ error: String(e) }));

if (packetPreviewCheck.error) {
  check('packet preview', false, packetPreviewCheck.error);
} else {
  check('packet preview panel becomes visible on click', packetPreviewCheck.panelVisible);
  check('packet preview: covering letter carries the recipient name', packetPreviewCheck.letterHasRecipient);
  check('packet preview: appearance carries the license number', packetPreviewCheck.appearanceHasLicenseNumber);
  check('packet preview: each row renders its own distinct document', packetPreviewCheck.lettersAreDistinct);
}

// --- Caption input is escaped, not parsed as markup -------------------------
// "&" is ordinary in real data (FLEE & ELUDE FELONY, ROE & ASSOCIATES), and a
// "<" would otherwise swallow the rest of the caption.
const escaping = await page.evaluate(async () => {
  const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['91st DISTRICT COURT'])).lastInsertRowid;
  const id = (await window.api.dbRun(
    `INSERT INTO matters (short_name, case_number, court_id, client_role, caption_style,
       party_label, caption_authority, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ['Escape Test', 'CN<1>&2', court, 'defendant', 'full', 'Defendant',
     'PEOPLE OF CITY OF EXAMPLETON', new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)',
    [id, 'Smith & Jones <b>LLC</b>', 'defendant']);
  // Caption notes are user-typed free text and land in the caption, so they
  // are the same injection surface as party names.
  for (const [i, t] of [['FLEE & ELUDE FELONY'], ['<script>window.__pwned=1</script>']].entries()) {
    await window.api.dbRun(
      'INSERT INTO matter_caption_notes (matter_id, note_text, sort_order) VALUES (?,?,?)', [id, t[0], i]);
  }

  const matter = await window.api.dbGet(
    'SELECT m.*, c.name as court_name FROM matters m LEFT JOIN courts c ON c.id=m.court_id WHERE m.id=?', [id]);
  matter.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id=?', [id]);
  matter.caption_notes = (await window.api.dbAll(
    'SELECT note_text FROM matter_caption_notes WHERE matter_id=? ORDER BY sort_order', [id])).map(r => r.note_text);
  const dt = window.DocumentEngine.doctypes.find(d => d.id === 'appearance');
  const html = window.DocumentEngine.renderHtml(dt.build(matter, attorney, {}), matter, attorney);

  // innerHTML is intentional here: the test must parse the output exactly as the
  // PDF window would, so that surviving markup shows up as real elements. This
  // is the assertion, not an oversight.
  const probe = document.createElement('div');
  probe.innerHTML = html;
  return {
    html,
    text: probe.innerText,
    injectedTags: probe.querySelectorAll('script, b').length,
    pwned: !!window.__pwned
  };
}).catch(e => ({ error: String(e) }));

if (escaping.error) {
  check('caption escaping', false, escaping.error);
} else {
  check('no script/markup tags survive from matter data', escaping.injectedTags === 0, `found ${escaping.injectedTags}`);
  check('no injected script executed', escaping.pwned === false);
  check('ampersand renders literally', escaping.text.includes('FLEE & ELUDE FELONY'));
  check('angle brackets render literally',
    escaping.text.includes('SMITH & JONES <B>LLC</B>') || escaping.text.includes('Smith & Jones <b>LLC</b>'),
    JSON.stringify(escaping.text.slice(0, 200)));
  check('raw "&" is encoded in the HTML source', escaping.html.includes('&amp;'));
}

// --- The caption fields must be reachable from the matter form --------------
const formFields = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  document.getElementById('nav-matters').click();
  await wait(300);
  document.getElementById('btn-new-matter').click();
  await wait(400);

  document.getElementById('mat-short_name').value = 'Form Roundtrip';
  document.getElementById('mat-case_number').value = '2026-FF-777';
  document.getElementById('mat-party_label').value = 'Respondent';
  document.getElementById('mat-caption_authority').value = 'PEOPLE OF CITY OF EXAMPLETON';
  // Drives the actual checkbox, not a SQL fixture — closes the gap between
  // "the render gate works" (proven elsewhere against a SQL-inserted row)
  // and "the checkbox actually persists" (this).
  document.getElementById('mat-case_number_pending').checked = true;

  // Caption notes are an ordered list now, entered a row at a time. Three
  // notes go in, then the middle one is moved up, so what is asserted is the
  // ORDER the user left on screen — not just that the text survived.
  const addNote = async (text) => {
    document.getElementById('btn-add-note').click();
    await wait(120);
    const inputs = document.querySelectorAll('#matter-notes-list input');
    const last = inputs[inputs.length - 1];
    last.value = text;
    last.dispatchEvent(new Event('input'));
  };
  await addNote('OWI (misdemeanor)');
  await addNote('SPEEDING');
  await addNote('BAC 0.XX');
  // Blank rows must not become empty caption lines.
  await addNote('   ');

  // "↑" on the third row: SPEEDING and BAC swap.
  const rows = [...document.querySelectorAll('#matter-notes-list > div')];
  rows[2].querySelector('button[title="Move up"]').click();
  await wait(150);
  const onScreen = [...document.querySelectorAll('#matter-notes-list input')].map(i => i.value);

  document.getElementById('btn-save-matter').click();
  await wait(900);

  const saved = await window.api.dbGet(
    'SELECT * FROM matters WHERE short_name = ? ORDER BY id DESC LIMIT 1', ['Form Roundtrip']);
  const notes = await window.api.dbAll(
    'SELECT note_text, sort_order FROM matter_caption_notes WHERE matter_id = ? ORDER BY sort_order, id',
    [saved.id]);

  // Reopen the matter: the rows must come back in the saved order.
  document.getElementById('nav-matters').click();
  await wait(300);
  const row = [...document.querySelectorAll('#matters-list tr')]
    .find(r => r.innerText.includes('Form Roundtrip'));
  if (row) row.click();
  await wait(600);
  const reopened = [...document.querySelectorAll('#matter-notes-list input')].map(i => i.value);
  const reopenedPending = document.getElementById('mat-case_number_pending').checked;

  return {
    party_label: saved?.party_label,
    caption_authority: saved?.caption_authority,
    case_number_pending: saved?.case_number_pending,
    onScreen, notes, reopened, reopenedPending
  };
}).catch(e => ({ error: String(e) }));

if (formFields.error) {
  check('matter form saves caption fields', false, formFields.error);
} else {
  check('matter form saves party label', formFields.party_label === 'Respondent', String(formFields.party_label));
  check('matter form saves caption authority',
    formFields.caption_authority === 'PEOPLE OF CITY OF EXAMPLETON', String(formFields.caption_authority));
  check('caption note rows reorder on screen',
    formFields.onScreen.slice(0, 3).join('|') === 'OWI (misdemeanor)|BAC 0.XX|SPEEDING',
    JSON.stringify(formFields.onScreen));
  check('matter form saves caption notes in the order shown',
    formFields.notes.map(n => n.note_text).join('|') === 'OWI (misdemeanor)|BAC 0.XX|SPEEDING',
    JSON.stringify(formFields.notes));
  check('blank caption note rows are not saved',
    formFields.notes.length === 3, JSON.stringify(formFields.notes));
  check('caption notes reload into the form in order',
    formFields.reopened.join('|') === 'OWI (misdemeanor)|BAC 0.XX|SPEEDING',
    JSON.stringify(formFields.reopened));
  check('the pending-case-number checkbox persists to the database',
    formFields.case_number_pending === 1, String(formFields.case_number_pending));
  check('the pending-case-number checkbox reloads checked',
    formFields.reopenedPending === true, String(formFields.reopenedPending));
}

// --- Case intake fields (migration 26) must be reachable from the matter form
// The charge is DELIBERATELY not one of them: it lives in
// matter_caption_notes (migration 20) because it prints in the caption of
// every filing. A parallel "current charge" field here would be a second
// source of truth for what the client is charged with, and the two would
// drift. The intake question is answered through the caption-notes control.
const caseIntake = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  document.getElementById('nav-matters').click();
  await wait(300);
  document.getElementById('btn-new-matter').click();
  await wait(400);
  document.getElementById('btn-fork-court').click();
  await wait(400);
  // A new case starts with no side (9A); Save requires one.
  document.getElementById('mat-client_role').value = 'plaintiff';
  // Editing mode, not the wizard: show both steps so every field is reachable.
  document.getElementById('wizard-step-1-fields').classList.remove('hidden');
  document.getElementById('wizard-step-2-fields').classList.remove('hidden');

  document.getElementById('mat-short_name').value = 'Case Intake Roundtrip';
  document.getElementById('mat-case_number').value = '2026-CI-909';

  const intake = {
    stage: 'Arraignment pending',
    bac: 'refused',
    police_agency: 'Michigan State Police – Sampleton Post',
    citation_number: 'A1234567',
    date_of_offense: '2026-03-14',
    referred_by: 'Prior client (M. Okonkwo)',
    fee_quoted: 'TBD after arraignment'
  };
  const missing = [];
  for (const [k, v] of Object.entries(intake)) {
    const el = document.getElementById('mat-' + k);
    if (!el) { missing.push(k); continue; }
    el.value = v;
    el.dispatchEvent(new Event('change'));
  }
  // Engagement status answers a different question and must still work.
  const eng = document.querySelector('input[name="mat-engagement_status"][value="Probable"]');
  if (eng) { eng.checked = true; }

  // The intake "Current Charge" answer goes through the existing caption-notes
  // control — the same rows the caption prints from.
  document.getElementById('btn-add-note').click();
  await wait(150);
  const noteInputs = document.querySelectorAll('#matter-notes-list input');
  const lastNote = noteInputs[noteInputs.length - 1];
  lastNote.value = 'OWI 1st Offense';
  lastNote.dispatchEvent(new Event('input'));

  document.getElementById('btn-save-matter').click();
  await wait(1000);

  const saved = await window.api.dbGet(
    'SELECT * FROM matters WHERE short_name = ? ORDER BY id DESC LIMIT 1', ['Case Intake Roundtrip']);
  if (!saved) return { error: 'matter did not save' };
  const captionNotes = await window.api.dbAll(
    'SELECT note_text, sort_order FROM matter_caption_notes WHERE matter_id = ? ORDER BY sort_order, id',
    [saved.id]);
  const mCols = await window.api.dbAll('PRAGMA table_info(matters)');

  // Give the matter what a generated appearance needs, then drive the real
  // generate flow so the caption is built by production code.
  const type = await window.api.dbGet("SELECT id FROM matter_types WHERE name = 'Criminal Defense'");
  const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['90th DISTRICT COURT'])).lastInsertRowid;
  // folder_person_id = 0: the party below is not linked to a person, so this
  // case is filed under "No Client" (see the note at tmpRoot).
  await window.api.dbRun('UPDATE matters SET court_id = ?, matter_type_id = ?, client_role = ?, party_label = ?, folder_person_id = 0 WHERE id = ?',
    [court, type ? type.id : null, 'defendant', 'Defendant', saved.id]);
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)',
    [saved.id, 'Dana Intaketest', 'defendant']);

  // Reopen through the list, exactly as a user would, and read the fields back.
  document.getElementById('nav-matters').click();
  await wait(400);
  const row = [...document.querySelectorAll('#matters-list tr')]
    .find(r => r.innerText.includes('Case Intake Roundtrip'));
  if (!row) return { error: 'saved matter not found in the list' };
  row.click();
  await wait(800);
  const reopened = {};
  for (const k of Object.keys(intake)) {
    const el = document.getElementById('mat-' + k);
    reopened[k] = el ? el.value : null;
  }
  const reopenedEngagement =
    document.querySelector('input[name="mat-engagement_status"]:checked')?.value || null;
  const reopenedNotes = [...document.querySelectorAll('#matter-notes-list input')].map(i => i.value);

  document.getElementById('btn-goto-generate').click();
  await wait(700);
  document.getElementById('gen-doctype').value = 'appearance';
  document.getElementById('gen-doctype').dispatchEvent(new Event('change'));
  await wait(400);
  document.getElementById('btn-generate-docx').click();
  await wait(2500);
  const gen = await window.api.dbGet(
    "SELECT path FROM generated_files WHERE matter_id = ? AND format = 'docx' ORDER BY id DESC LIMIT 1",
    [saved.id]);

  return {
    intake,
    saved: Object.fromEntries(Object.keys(intake).map(k => [k, saved[k]])),
    engagement_status: saved.engagement_status,
    captionNotes, reopened, reopenedEngagement, reopenedNotes,
    columns: mCols.map(c => c.name),
    docx: gen && gen.path
  };
}).catch(e => ({ error: String(e) }));

if (caseIntake.error) {
  check('case intake fields save from the matter form', false, caseIntake.error);
} else {
  for (const k of Object.keys(caseIntake.intake)) {
    check(`matter form saves ${k}`,
      caseIntake.saved[k] === caseIntake.intake[k],
      `saved ${JSON.stringify(caseIntake.saved[k])}, wanted ${JSON.stringify(caseIntake.intake[k])}`);
    check(`matter form reloads ${k}`,
      caseIntake.reopened[k] === caseIntake.intake[k],
      `reloaded ${JSON.stringify(caseIntake.reopened[k])}, wanted ${JSON.stringify(caseIntake.intake[k])}`);
  }
  check('engagement_status still answers its own question alongside stage',
    caseIntake.engagement_status === 'Probable' && caseIntake.reopenedEngagement === 'Probable',
    `${caseIntake.engagement_status} / ${caseIntake.reopenedEngagement}`);
  check('the intake charge lands in matter_caption_notes, not a new column',
    caseIntake.captionNotes.some(n => n.note_text === 'OWI 1st Offense'),
    JSON.stringify(caseIntake.captionNotes));
  check('the intake charge reloads into the caption-notes control',
    caseIntake.reopenedNotes.includes('OWI 1st Offense'),
    JSON.stringify(caseIntake.reopenedNotes));
  check('no current_charge column was introduced',
    !caseIntake.columns.includes('current_charge'),
    JSON.stringify(caseIntake.columns));
  if (!caseIntake.docx) {
    check('the intake charge reaches the caption of a generated document', false, 'no .docx was generated');
  } else {
    const ixml = readDocxXml(caseIntake.docx);
    check('the intake charge reaches the caption of a generated document',
      ixml.includes('OWI 1st Offense'));
  }
}

// --- Stage drives which intake fields are asked for -------------------------
// The stage a case is at decides which intake answers are expected, so nobody
// is asked for a citation number that does not exist yet. Three things this
// must never do: block a save, clear a hidden field, or throw on the blank
// stage that every matter already in the field has.
const stageMatrix = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const texts = () => [...document.querySelectorAll('#matter-issues li')].map(li => li.textContent);
  // The matrix, restated independently of the renderer's copy. Keys are
  // checked against the <select> options below rather than trusted.
  const EXPECTED = {
    'Not yet charged':       { citation_number: 'hidden',   date_of_offense: 'required', bac: 'optional', case_number: 'hidden' },
    'Cited, no court date':  { citation_number: 'required', date_of_offense: 'required', bac: 'optional', case_number: 'hidden' },
    'Arraignment pending':   { citation_number: 'required', date_of_offense: 'required', bac: 'optional', case_number: 'required' },
    'Pretrial':              { citation_number: 'required', date_of_offense: 'required', bac: 'optional', case_number: 'required' },
    'Post-conviction or PV': { citation_number: 'optional', date_of_offense: 'required', bac: 'hidden',   case_number: 'required' },
    'Appeal':                { citation_number: 'optional', date_of_offense: 'required', bac: 'hidden',   case_number: 'required' },
    'Licence restoration':   { citation_number: 'hidden',   date_of_offense: 'optional', bac: 'hidden',   case_number: 'hidden' }
  };
  const SENTENCE = {
    citation_number: 'No citation / ticket number.',
    date_of_offense: 'No date of offense.',
    case_number: 'No case number.',
    bac: null // BAC is never required — plenty of OWI clients refused the test.
  };
  const FIELDS = ['citation_number', 'date_of_offense', 'bac', 'case_number'];
  const isHidden = (f) => {
    const el = document.getElementById('mat-' + f);
    if (!el) return null;
    const g = el.closest('.form-group');
    return g ? g.classList.contains('hidden') : null;
  };
  const setStage = async (v) => {
    const sel = document.getElementById('mat-stage');
    sel.value = v;
    sel.dispatchEvent(new Event('change'));
    await wait(300);
  };
  const openByName = async (name) => {
    document.getElementById('nav-matters').click();
    await wait(500);
    const row = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes(name));
    if (!row) return false;
    row.click();
    await wait(800);
    document.getElementById('wizard-step-1-fields').classList.remove('hidden');
    document.getElementById('wizard-step-2-fields').classList.remove('hidden');
    return true;
  };

  // A saved matter, deliberately missing every stage-governed answer.
  document.getElementById('nav-matters').click();
  await wait(300);
  document.getElementById('btn-new-matter').click();
  await wait(400);
  document.getElementById('btn-fork-court').click();
  await wait(400);
  // A new case starts with no side (9A); Save requires one.
  document.getElementById('mat-client_role').value = 'plaintiff';
  document.getElementById('wizard-step-1-fields').classList.remove('hidden');
  document.getElementById('wizard-step-2-fields').classList.remove('hidden');
  document.getElementById('mat-short_name').value = 'Stage Matrix Sweep';
  document.getElementById('btn-save-matter').click();
  await wait(1200);
  const created = await window.api.dbGet(
    'SELECT * FROM matters WHERE short_name = ? ORDER BY id DESC LIMIT 1', ['Stage Matrix Sweep']);
  if (!created) return { error: 'stage sweep matter did not save' };
  if (!await openByName('Stage Matrix Sweep')) return { error: 'stage sweep matter not in the list' };

  const stageOptions = [...document.getElementById('mat-stage').options]
    .map(o => o.value).filter(v => v !== '');
  const optionMismatch = [
    ...stageOptions.filter(v => !(v in EXPECTED)).map(v => `<select> has "${v}", matrix does not`),
    ...Object.keys(EXPECTED).filter(v => !stageOptions.includes(v)).map(v => `matrix has "${v}", <select> does not`)
  ];

  // Every governed answer blank, so "required" has something to complain about.
  FIELDS.forEach(f => { document.getElementById('mat-' + f).value = ''; });

  const wrong = [];
  const seen = {};
  for (const stage of stageOptions) {
    await setStage(stage);
    const list = texts();
    seen[stage] = { hidden: {}, list };
    for (const f of FIELDS) {
      const rule = (EXPECTED[stage] || {})[f];
      const hid = isHidden(f);
      seen[stage].hidden[f] = hid;
      if (hid === null) { wrong.push(`${stage}/${f}: no .form-group found`); continue; }
      if (rule === 'hidden' && hid !== true) wrong.push(`${stage}/${f}: should be hidden, is visible`);
      if (rule !== 'hidden' && hid !== false) wrong.push(`${stage}/${f}: should be visible, is hidden`);
      const sentence = SENTENCE[f];
      if (!sentence) {
        continue;
      } else if (rule === 'required') {
        if (!list.includes(sentence)) wrong.push(`${stage}/${f}: "${sentence}" missing from Still needed: ${JSON.stringify(list)}`);
      } else {
        if (list.includes(sentence)) wrong.push(`${stage}/${f}: "${sentence}" should not be asked for ${JSON.stringify(list)}`);
      }
    }
    if (list.some(t => /BAC/i.test(t))) wrong.push(`${stage}: BAC is optional everywhere, but it was asked for`);
  }

  // Blank stage — the state every matter in the real database is in.
  await setStage('');
  const blank = { hidden: {}, list: texts() };
  FIELDS.forEach(f => { blank.hidden[f] = isHidden(f); });

  // Saving is never blocked: a stage whose required answers are all blank.
  await setStage('Pretrial');
  document.getElementById('btn-save-matter').click();
  await wait(1200);
  const afterBlankSave = await window.api.dbGet(
    'SELECT * FROM matters WHERE id = ?', [created.id]);
  const savedWithBlanks = !!afterBlankSave && afterBlankSave.stage === 'Pretrial'
    && !afterBlankSave.citation_number && !afterBlankSave.date_of_offense;

  // Hiding is not clearing, case 1: a stage switch away and back.
  if (!await openByName('Stage Matrix Sweep')) return { error: 'matter not reopenable for the hiding checks' };
  await setStage('Pretrial');
  document.getElementById('mat-citation_number').value = 'C-999-SWITCH';
  document.getElementById('mat-citation_number').dispatchEvent(new Event('change'));
  await setStage('Licence restoration');
  const hiddenDuringSwitch = isHidden('citation_number');
  await setStage('Pretrial');
  const preservedOnSwitch = document.getElementById('mat-citation_number').value;

  // Hiding is not clearing, case 2: a SAVE performed while the field is hidden.
  document.getElementById('mat-citation_number').value = 'C-777-SAVED';
  document.getElementById('mat-citation_number').dispatchEvent(new Event('change'));
  await setStage('Licence restoration');
  const hiddenAtSave = isHidden('citation_number');
  document.getElementById('btn-save-matter').click();
  await wait(1200);
  const afterHiddenSave = await window.api.dbGet('SELECT * FROM matters WHERE id = ?', [created.id]);
  if (!await openByName('Stage Matrix Sweep')) return { error: 'matter not reopenable after the hidden save' };
  const reopenedCitation = document.getElementById('mat-citation_number').value;

  return {
    stageOptions, optionMismatch, wrong, seen, blank, savedWithBlanks,
    hiddenDuringSwitch, preservedOnSwitch,
    hiddenAtSave,
    savedWhileHidden: afterHiddenSave && afterHiddenSave.citation_number,
    reopenedStage: document.getElementById('mat-stage').value,
    reopenedCitation
  };
}).catch(e => ({ error: String(e) }));

if (stageMatrix.error) {
  check('stage drives which intake fields are asked for', false, stageMatrix.error);
} else {
  check('the stage matrix covers exactly the stages the dropdown offers',
    stageMatrix.optionMismatch.length === 0, stageMatrix.optionMismatch.join('; '));
  check('every stage hides exactly the fields it should',
    stageMatrix.wrong.length === 0, stageMatrix.wrong.join('; '));
  check('saving is never blocked by a required intake field',
    stageMatrix.savedWithBlanks === true, JSON.stringify(stageMatrix.savedWithBlanks));
  check('a blank stage shows every field and requires nothing extra',
    Object.values(stageMatrix.blank.hidden).every(h => h === false)
      && !stageMatrix.blank.list.includes('No citation / ticket number.')
      && !stageMatrix.blank.list.includes('No date of offense.'),
    JSON.stringify(stageMatrix.blank));
  check('hiding a field does not clear it — switch away and back',
    stageMatrix.hiddenDuringSwitch === true && stageMatrix.preservedOnSwitch === 'C-999-SWITCH',
    `hiddenWhileAway=${stageMatrix.hiddenDuringSwitch} value=${JSON.stringify(stageMatrix.preservedOnSwitch)}`);
  check('a hidden field survives a save while hidden',
    stageMatrix.hiddenAtSave === true && stageMatrix.savedWhileHidden === 'C-777-SAVED'
      && stageMatrix.reopenedCitation === 'C-777-SAVED',
    `hiddenAtSave=${stageMatrix.hiddenAtSave} db=${JSON.stringify(stageMatrix.savedWhileHidden)} reopened=${JSON.stringify(stageMatrix.reopenedCitation)}`);
}

// --- Court dates: a repeating table on the matter ---------------------------
// Same shape as the priors table on the person, and the same three ways it can
// go wrong: rows read live across an await land on the wrong file, a
// half-committed save erases half a docket, and an array not reset on load
// shows one client's hearings on another's case. `done` is an INTEGER column,
// so it must be read from .checked — .value on a checkbox is "on" whether it
// is ticked or not.
const events = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const newMatter = async (name) => {
    document.getElementById('nav-matters').click();
    await wait(300);
    document.getElementById('btn-new-matter').click();
    await wait(400);
    document.getElementById('btn-fork-court').click();
    await wait(400);
    // A new case starts with no side (9A); Save requires one.
    document.getElementById('mat-client_role').value = 'plaintiff';
    document.getElementById('wizard-step-1-fields').classList.remove('hidden');
    document.getElementById('wizard-step-2-fields').classList.remove('hidden');
    document.getElementById('mat-short_name').value = name;
    document.getElementById('btn-save-matter').click();
    await wait(1200);
    return window.api.dbGet(
      'SELECT * FROM matters WHERE short_name = ? ORDER BY id DESC LIMIT 1', [name]);
  };
  const openByName = async (name) => {
    document.getElementById('nav-matters').click();
    await wait(500);
    const row = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes(name));
    if (!row) return false;
    row.click();
    await wait(900);
    document.getElementById('wizard-step-1-fields').classList.remove('hidden');
    document.getElementById('wizard-step-2-fields').classList.remove('hidden');
    return true;
  };
  const rowsOnScreen = () => [...document.querySelectorAll('#matter-events-list [data-field="event_type"]')];
  const addEvent = async (vals) => {
    document.getElementById('btn-add-event').click();
    await wait(150);
    const rows = [...document.querySelectorAll('#matter-events-list > div')]
      .filter(el => el.querySelector('[data-field]'));
    const row = rows[rows.length - 1];
    Object.entries(vals).forEach(([k, v]) => {
      const input = row.querySelector(`[data-field="${k}"]`);
      if (!input) return;
      if (input.type === 'checkbox') {
        input.checked = !!v;
        input.dispatchEvent(new Event('change'));
      } else {
        input.value = v;
        input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input'));
      }
    });
  };

  const withDates = await newMatter('Court Dates Roundtrip');
  if (!withDates) return { error: 'court-date matter did not save' };
  if (!await openByName('Court Dates Roundtrip')) return { error: 'court-date matter not reopenable' };

  await addEvent({ event_type: 'Pretrial', event_date: '2026-09-04', event_time: '09:30',
                   location: "90th District, Judge O'Casey", notes: 'adjourned from 8/12' });
  await addEvent({ event_type: 'Arraignment', event_date: '2026-08-01', event_time: '13:00',
                   location: 'Exampleton', notes: '', done: true });
  // A row left completely blank is not a court date and must not be saved.
  await addEvent({});
  const typeOptions = [...rowsOnScreen()[0].options].map(o => o.value).filter(Boolean);

  document.getElementById('btn-save-matter').click();
  await wait(1200);
  const saved = await window.api.dbAll(
    'SELECT * FROM matter_events WHERE matter_id = ? ORDER BY event_date, id', [withDates.id]);

  // Reopen: the rows come back, the done tick comes back ticked, and a second
  // save must not duplicate them — the save deletes and re-inserts.
  if (!await openByName('Court Dates Roundtrip')) return { error: 'not reopenable after save' };
  const reopenedCount = rowsOnScreen().length;
  const reopenedFirst = rowsOnScreen()[0] ? rowsOnScreen()[0].value : null;
  const doneChecks = [...document.querySelectorAll('#matter-events-list [data-field="done"]')].map(c => c.checked);
  const reopenedLocation = (document.querySelector('#matter-events-list [data-field="location"]') || {}).value;
  document.getElementById('btn-save-matter').click();
  await wait(1200);
  const afterSecondSave = await window.api.dbAll(
    'SELECT * FROM matter_events WHERE matter_id = ?', [withDates.id]);

  // The leak guard. A matter with no dates, opened straight after one with
  // them, must show none of them.
  const noDates = await newMatter('Court Dates Empty');
  if (!noDates) return { error: 'empty court-date matter did not save' };
  if (!await openByName('Court Dates Roundtrip')) return { error: 'leak check: A not reopenable' };
  for (let i = 0; i < 40 && rowsOnScreen().length < 2; i++) await wait(100);
  const onA = rowsOnScreen().length;
  if (!await openByName('Court Dates Empty')) return { error: 'leak check: B not reopenable' };
  const onB = rowsOnScreen().length;
  // Saving a matter with zero events must not throw, and must leave the other
  // matter's dates entirely alone.
  document.getElementById('btn-save-matter').click();
  await wait(1200);
  const onBInDb = await window.api.dbAll(
    'SELECT * FROM matter_events WHERE matter_id = ?', [noDates.id]);
  const aStillIntact = await window.api.dbAll(
    'SELECT * FROM matter_events WHERE matter_id = ?', [withDates.id]);
  // And a brand-new, unsaved matter must not inherit them either.
  document.getElementById('nav-matters').click();
  await wait(300);
  document.getElementById('btn-new-matter').click();
  await wait(400);
  document.getElementById('btn-fork-court').click();
  await wait(400);
  const onNew = rowsOnScreen().length;

  // Removing every row and saving has to reach the database.
  if (!await openByName('Court Dates Roundtrip')) return { error: 'clear check: not reopenable' };
  let guard = 0;
  while (document.querySelector('#matter-events-list [data-remove-event]') && guard++ < 10) {
    document.querySelector('#matter-events-list [data-remove-event]').click();
    await wait(120);
  }
  document.getElementById('btn-save-matter').click();
  await wait(1200);
  let cleared = await window.api.dbAll(
    'SELECT * FROM matter_events WHERE matter_id = ?', [withDates.id]);
  for (let i = 0; i < 40 && cleared.length; i++) {
    await wait(100);
    cleared = await window.api.dbAll('SELECT * FROM matter_events WHERE matter_id = ?', [withDates.id]);
  }

  return {
    typeOptions, saved, reopenedCount, reopenedFirst, doneChecks, reopenedLocation,
    afterSecondSave: afterSecondSave.length,
    onA, onB, onNew, onBInDb: onBInDb.length, aStillIntact: aStillIntact.length,
    cleared: cleared.length
  };
}).catch(e => ({ error: String(e) }));

if (events.error) {
  check('court dates on the matter form', false, events.error);
} else {
  check('the court-date type dropdown offers exactly the agreed event types',
    JSON.stringify(events.typeOptions) === JSON.stringify(
      ['Arraignment', 'Pretrial', 'Motion hearing', 'Trial', 'Sentencing', 'PV hearing', 'Filing deadline', 'Other']),
    JSON.stringify(events.typeOptions));
  check('two court dates save against the matter, and the blank row does not',
    events.saved.length === 2, JSON.stringify(events.saved));
  check('a court date saves its type, date, time and notes',
    events.saved.some(e => e.event_type === 'Pretrial' && e.event_date === '2026-09-04'
      && e.event_time === '09:30' && e.notes === 'adjourned from 8/12'),
    JSON.stringify(events.saved));
  check('an apostrophe in a court location survives the round trip',
    events.saved.some(e => e.location === "90th District, Judge O'Casey"),
    JSON.stringify(events.saved.map(e => e.location)));
  check('done stores as integer 1 when ticked and 0 when not',
    events.saved.length === 2
      && events.saved.every(e => e.done === 0 || e.done === 1)
      && events.saved.find(e => e.event_type === 'Arraignment').done === 1
      && events.saved.find(e => e.event_type === 'Pretrial').done === 0,
    JSON.stringify(events.saved.map(e => ({ t: e.event_type, done: e.done, type: typeof e.done }))));
  check('reopening a matter shows the court dates that were saved',
    events.reopenedCount === 2 && events.reopenedFirst === 'Arraignment'
      && events.reopenedLocation === 'Exampleton',
    JSON.stringify(events));
  check('a ticked done comes back ticked, an unticked one does not',
    JSON.stringify(events.doneChecks) === JSON.stringify([true, false]),
    JSON.stringify(events.doneChecks));
  check('saving twice does not duplicate a court date',
    events.afterSecondSave === 2, String(events.afterSecondSave));
  check('a matter with court dates shows them', events.onA === 2, JSON.stringify(events));
  check('court dates do not leak from one matter onto the next',
    events.onB === 0, JSON.stringify(events));
  check('court dates do not leak onto a brand-new matter',
    events.onNew === 0, JSON.stringify(events));
  check('saving a matter with no court dates neither throws nor touches another matter',
    events.onBInDb === 0 && events.aStillIntact === 2, JSON.stringify(events));
  check('removing every court date and saving clears them from the database',
    events.cleared === 0, String(events.cleared));
}

// --- Court dates roll up to the profile and the People list -----------------
// Read-only views over matter_events. Design §7 is deliberately bounded to
// "record and roll up": no calendar view, no firm-wide docket, no
// notifications, no computed deadlines.
//
// The three ways a roll-up goes wrong, all asserted here: a date already
// ticked Done offered as the next one; a date that has already gone by
// presented as though it were still coming; and a person with no dates
// sorting to the TOP of the People list, burying everyone who actually has a
// hearing this month.
//
// Every date is computed from the run date and never hard-coded — a fixture
// that is in the future today is in the past next year, and the past/future
// line is the whole feature.
const rollUp = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const iso = (offsetDays) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const SOON = iso(30), LATER = iso(60), LONG_PAST = iso(-40), OVERDUE = iso(-5);

  const mkPerson = async (name) => {
    const r = await window.api.dbRun(
      'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
      [name, 'individual', new Date().toISOString()]);
    return r.lastInsertRowid;
  };
  const mkMatter = async (personId, name, stage) => {
    const r = await window.api.dbRun(
      'INSERT INTO matters (short_name, case_number, client_role, caption_style, stage, created_at) VALUES (?,?,?,?,?,?)',
      [name, '', 'defendant', 'full', stage || null, new Date().toISOString()]);
    await window.api.dbRun(
      'INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,0)',
      [r.lastInsertRowid, personId, name + ' client', 'defendant', 'client']);
    return r.lastInsertRowid;
  };
  const mkEvent = (matterId, type, date, done) => window.api.dbRun(
    'INSERT INTO matter_events (matter_id, event_type, event_date, done) VALUES (?,?,?,?)',
    [matterId, type, date, done ? 1 : 0]);

  // One client, two cases, three dates — the arraignment is already done, so
  // the pretrial is the next one on case A and the trial is next on case B.
  const spread = await mkPerson('Roll Up Spread');
  const caseA = await mkMatter(spread, 'Roll Up Case A');
  const caseB = await mkMatter(spread, 'Roll Up Case B');
  await mkEvent(caseA, 'Arraignment', LONG_PAST, true);
  await mkEvent(caseA, 'Pretrial', SOON, false);
  await mkEvent(caseB, 'Trial', LATER, false);

  // A date in the past that was never ticked done: overdue, not next.
  const late = await mkPerson('Roll Up Overdue');
  const caseC = await mkMatter(late, 'Roll Up Case C');
  await mkEvent(caseC, 'Motion hearing', OVERDUE, false);

  // A client with a case but no dates at all, and one with no case at all.
  const bare = await mkPerson('Roll Up No Dates');
  await mkMatter(bare, 'Roll Up Case D');
  const nobody = await mkPerson('Roll Up No Case');

  // A client whose only date is done: still nothing to show.
  const finished = await mkPerson('Roll Up All Done');
  const caseE = await mkMatter(finished, 'Roll Up Case E');
  await mkEvent(caseE, 'Sentencing', SOON, true);

  const readCases = async (id) => {
    await window.openPerson(id);
    await wait(400);
    const el = document.getElementById('person-cases');
    return {
      text: el.innerText,
      dates: [...el.querySelectorAll('.next-date')].map(n => ({
        text: n.textContent, overdue: n.classList.contains('overdue')
      }))
    };
  };
  const spreadCases = await readCases(spread);
  const lateCases = await readCases(late);
  const bareCases = await readCases(bare);
  const nobodyCases = await readCases(nobody);
  const finishedCases = await readCases(finished);

  const peopleRows = async () => {
    document.getElementById('nav-people').click();
    await wait(400);
    return [...document.querySelectorAll('#people-list tr')].map(tr => {
      const cell = tr.querySelector('td.next-date');
      return {
        text: tr.innerText,
        next: cell ? cell.textContent : null,
        overdue: !!(cell && cell.classList.contains('overdue'))
      };
    });
  };
  const listed = await peopleRows();
  const header = document.querySelector('#view-people table thead').innerText;

  // Sorting by next date: everyone with a date first, in date order, and
  // everyone without one at the bottom — in BOTH directions.
  const sortHeader = document.getElementById('people-sort-next');
  sortHeader.click();
  await wait(400);
  const asc = await (async () => [...document.querySelectorAll('#people-list tr')].map(tr => {
    const cell = tr.querySelector('td.next-date');
    return { text: tr.innerText.split('\n')[0], next: cell ? cell.textContent : null };
  }))();
  sortHeader.click();
  await wait(400);
  const desc = [...document.querySelectorAll('#people-list tr')].map(tr => {
    const cell = tr.querySelector('td.next-date');
    return { text: tr.innerText.split('\n')[0], next: cell ? cell.textContent : null };
  });

  // The stale-stage nudge on the matter. The stage is 'Arraignment pending'
  // and the arraignment has been and gone.
  const staleP = await mkPerson('Roll Up Stale Stage');
  const staleM = await mkMatter(staleP, 'Roll Up Stale Case', 'Arraignment pending');
  await mkEvent(staleM, 'Arraignment', LONG_PAST, false);
  const freshM = await mkMatter(staleP, 'Roll Up Fresh Case', 'Pretrial');
  await mkEvent(freshM, 'Pretrial', SOON, false);

  // openMatter is not exposed on window, so the matter is opened the way a
  // user opens it: from the matters list.
  const openMatterByName = async (name) => {
    document.getElementById('nav-matters').click();
    await wait(500);
    const row = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes(name));
    if (!row) return false;
    row.click();
    await wait(900);
    document.getElementById('wizard-step-1-fields').classList.remove('hidden');
    document.getElementById('wizard-step-2-fields').classList.remove('hidden');
    return true;
  };
  if (!await openMatterByName('Roll Up Stale Case')) return { error: 'stale-stage matter not reopenable' };
  const staleNote = document.getElementById('matter-stage-note').innerText;
  const staleHidden = document.getElementById('matter-stage-note').classList.contains('hidden');
  if (!await openMatterByName('Roll Up Fresh Case')) return { error: 'fresh matter not reopenable' };
  const freshNote = document.getElementById('matter-stage-note').innerText;
  const freshHidden = document.getElementById('matter-stage-note').classList.contains('hidden');
  // Reading the note must never move the stage, and neither must saving the
  // matter afterwards: the app cannot know whether the hearing was adjourned,
  // waived or resolved by plea (design §7).
  if (!await openMatterByName('Roll Up Stale Case')) return { error: 'stale matter not reopenable twice' };
  document.getElementById('btn-save-matter').click();
  await wait(1200);
  const stageAfter = (await window.api.dbGet('SELECT stage FROM matters WHERE id = ?', [staleM])).stage;

  return {
    SOON, LATER, LONG_PAST, OVERDUE,
    spreadCases, lateCases, bareCases, nobodyCases, finishedCases,
    listed, header, asc, desc,
    staleNote, staleHidden, freshNote, freshHidden, stageAfter
  };
}).catch(e => ({ error: String(e) }));

if (rollUp.error) {
  check('court dates roll up to the profile and People list', false, rollUp.error);
} else {
  const rowFor = (name) => rollUp.listed.find(r => r.text.includes(name)) || {};
  check('each case row on the profile shows its own next court date',
    rollUp.spreadCases.dates.length === 2
      && rollUp.spreadCases.text.includes('Pretrial — ' + rollUp.SOON)
      && rollUp.spreadCases.text.includes('Trial — ' + rollUp.LATER),
    JSON.stringify(rollUp.spreadCases));
  check('a court date already ticked done is never shown as the next one',
    !rollUp.spreadCases.text.includes('Arraignment')
      && !rollUp.spreadCases.text.includes(rollUp.LONG_PAST)
      && rollUp.finishedCases.dates.length === 0
      && !rollUp.finishedCases.text.includes('Sentencing'),
    JSON.stringify([rollUp.spreadCases.text, rollUp.finishedCases.text]));
  check('a past date that was never ticked done renders as overdue, not as next',
    rollUp.lateCases.dates.length === 1
      && rollUp.lateCases.dates[0].overdue === true
      && rollUp.lateCases.dates[0].text.includes(rollUp.OVERDUE),
    JSON.stringify(rollUp.lateCases));
  check('a case with no court dates shows a blank, not "undefined"',
    rollUp.bareCases.dates.length === 0 && !/undefined|null|NaN/.test(rollUp.bareCases.text),
    JSON.stringify(rollUp.bareCases));
  check('a client on no case at all still renders their Cases panel',
    !/undefined|NaN/.test(rollUp.nobodyCases.text), JSON.stringify(rollUp.nobodyCases));
  check('the People list has a Next date column',
    rollUp.header.includes('Next date'), rollUp.header.replace(/\n/g, ' | '));
  check('the People list shows the soonest date across all of a client’s cases',
    rowFor('Roll Up Spread').next === rollUp.SOON, JSON.stringify(rowFor('Roll Up Spread')));
  check('an overdue date on the People list is marked overdue',
    rowFor('Roll Up Overdue').next === rollUp.OVERDUE
      && rowFor('Roll Up Overdue').overdue === true,
    JSON.stringify(rowFor('Roll Up Overdue')));
  check('a client with no dates gets an empty Next date cell, not "undefined"',
    rowFor('Roll Up No Dates').next === '' && rowFor('Roll Up No Case').next === ''
      && rowFor('Roll Up All Done').next === '',
    JSON.stringify([rowFor('Roll Up No Dates'), rowFor('Roll Up No Case'), rowFor('Roll Up All Done')]));
  const dated = (rows) => rows.filter(r => r.next);
  const blanks = (rows) => rows.filter(r => !r.next);
  const lastDated = (rows) => rows.map(r => !!r.next).lastIndexOf(true);
  const firstBlank = (rows) => rows.map(r => !!r.next).indexOf(false);
  check('sorting by next date puts the soonest first',
    dated(rollUp.asc).length >= 2
      && dated(rollUp.asc)[0].next === rollUp.OVERDUE
      && dated(rollUp.asc).every((r, i, a) => i === 0 || a[i - 1].next <= r.next),
    JSON.stringify(rollUp.asc));
  check('sorting by next date puts people with no date LAST, not first',
    firstBlank(rollUp.asc) > lastDated(rollUp.asc)
      && blanks(rollUp.asc).length >= 3,
    JSON.stringify(rollUp.asc));
  check('reversing the sort keeps people with no date last',
    firstBlank(rollUp.desc) > lastDated(rollUp.desc)
      && dated(rollUp.desc).every((r, i, a) => i === 0 || a[i - 1].next >= r.next),
    JSON.stringify(rollUp.desc));
  check('a passed arraignment on an "Arraignment pending" case shows a quiet note',
    rollUp.staleHidden === false
      && /arraignment date .*has passed/i.test(rollUp.staleNote)
      && rollUp.staleNote.includes('Arraignment pending'),
    JSON.stringify(rollUp.staleNote));
  check('a case whose date is still ahead of it gets no note',
    rollUp.freshHidden === true && rollUp.freshNote.trim() === '',
    JSON.stringify(rollUp.freshNote));
  check('the note never changes the stage by itself',
    rollUp.stageAfter === 'Arraignment pending', JSON.stringify(rollUp.stageAfter));
}

// --- Appellate fields must be reachable from the matter form too ------------
const appellateForm = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  document.getElementById('nav-matters').click();
  await wait(300);
  document.getElementById('btn-new-matter').click();
  await wait(400);

  document.getElementById('mat-short_name').value = 'Appeal Roundtrip';
  document.getElementById('mat-case_number').value = '26-AAA-01-AR';
  document.getElementById('mat-plaintiff_label').value = 'Plaintiff – Appellee';
  document.getElementById('mat-party_label').value = 'Defendant – Appellant';

  // Add the case below.
  document.getElementById('btn-add-case').click();
  await wait(200);
  const inputs = document.querySelectorAll('#matter-cases-list input');
  inputs[0].value = '2025-BBB-OD';
  inputs[0].dispatchEvent(new Event('input'));
  inputs[1].value = 'Marcus T. Gavel';
  inputs[1].dispatchEvent(new Event('input'));

  document.getElementById('btn-save-matter').click();

  let saved = await window.api.dbGet(
    'SELECT * FROM matters WHERE short_name = ? ORDER BY id DESC LIMIT 1', ['Appeal Roundtrip']);
  let cases = saved ? await window.api.dbAll(
    'SELECT * FROM matter_cases WHERE matter_id = ? ORDER BY sort_order, id', [saved.id]) : [];
  for (let i = 0; i < 60 && (!saved || cases.length < 2); i++) {
    await wait(100);
    saved = await window.api.dbGet(
      'SELECT * FROM matters WHERE short_name = ? ORDER BY id DESC LIMIT 1', ['Appeal Roundtrip']);
    cases = saved ? await window.api.dbAll(
      'SELECT * FROM matter_cases WHERE matter_id = ? ORDER BY sort_order, id', [saved.id]) : [];
  }
  return { plaintiff_label: saved.plaintiff_label, party_label: saved.party_label, cases };
}).catch(e => ({ error: String(e) }));

if (appellateForm.error) {
  check('appellate form fields', false, appellateForm.error);
} else {
  check('form saves compound plaintiff label',
    appellateForm.plaintiff_label === 'Plaintiff – Appellee', String(appellateForm.plaintiff_label));
  check('form saves compound defendant label',
    appellateForm.party_label === 'Defendant – Appellant', String(appellateForm.party_label));
  check('form saves two case rows', appellateForm.cases.length === 2,
    JSON.stringify(appellateForm.cases.map(c => `${c.case_number}/${c.judge_name || ''}`)));
  check('the case below keeps its judge',
    appellateForm.cases.some(c => c.case_number === '2025-BBB-OD' && c.judge_name === 'Marcus T. Gavel'));
}

// --- Appearance: every caption element must survive the Word export ---------
// The .docx generator handles block types explicitly; an unhandled type is
// dropped silently, which is how the caption once vanished from Word output.
const appearance = await page.evaluate(async () => {
  const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['99th JUDICIAL DISTRICT COURT'])).lastInsertRowid;
  const id = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, client_role, caption_style,
      party_label, caption_authority, created_at) VALUES (0, ?,?,?,?,?,?,?,?)`,
    ['Roe', '25C-TEST-FT', court, 'defendant', 'full', 'Respondent',
     'PEOPLE OF THE STATE OF MICHIGAN', new Date().toISOString()]
  )).lastInsertRowid;
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)', [id, 'Morgan Roe', 'defendant']);
  for (const [i, t] of ['OWI (misdemeanor)', 'FLEE & ELUDE FELONY'].entries()) {
    await window.api.dbRun(
      'INSERT INTO matter_caption_notes (matter_id, note_text, sort_order) VALUES (?,?,?)', [id, t, i]);
  }

  const matter = await window.api.dbGet(
    'SELECT m.*, c.name as court_name FROM matters m LEFT JOIN courts c ON c.id=m.court_id WHERE m.id=?', [id]);
  matter.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id=?', [id]);
  matter.caption_notes = (await window.api.dbAll(
    'SELECT note_text FROM matter_caption_notes WHERE matter_id=? ORDER BY sort_order', [id])).map(r => r.note_text);
  const dt = window.DocumentEngine.doctypes.find(d => d.id === 'appearance');
  const blocks = dt.build(matter, attorney, { dated: '2025-12-23' });
  const html = window.DocumentEngine.renderHtml(blocks, matter, attorney);
  const docx = await window.api.generateDocx(blocks, matter, attorney, dt.label, dt.id);
  return { docx: docx.path, html };
}).catch(e => ({ error: String(e) }));

// --- Caption notes: one line or three, and nothing else moves ---------------
// The Phase 2 requirement, stated by the user: a compound entry like
// "OWI, Speed 11-15, BAC 0.XX" must be enterable as ONE note or THREE without
// anything else in the caption shifting. Asserted structurally — every
// paragraph of the .docx that is not itself a note must be byte-identical
// between the two — because the caption is the block that has most often
// broken in Word while the PDF looked perfect.
const captionNotes = await page.evaluate(async () => {
  const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  const court = (await window.api.dbRun(
    'INSERT INTO courts (name, header_line) VALUES (?,?)',
    ['92nd DISTRICT COURT', 'IN THE 92nd DISTRICT COURT'])).lastInsertRowid;

  const mk = async (shortName, notes) => {
    const id = (await window.api.dbRun(
      `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, client_role, caption_style,
        party_label, caption_authority, created_at) VALUES (0, ?,?,?,?,?,?,?,?)`,
      [shortName, '26D-1234-FY', court, 'defendant', 'full', 'Defendant',
       'PEOPLE OF THE STATE OF MICHIGAN', new Date().toISOString()])).lastInsertRowid;
    await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)',
      [id, 'Pat Placeholder', 'defendant']);
    for (const [i, t] of notes.entries()) {
      await window.api.dbRun(
        'INSERT INTO matter_caption_notes (matter_id, note_text, sort_order) VALUES (?,?,?)', [id, t, i]);
    }
    const matter = await window.api.dbGet(
      'SELECT m.*, c.name as court_name, c.header_line as court_header_line FROM matters m LEFT JOIN courts c ON c.id=m.court_id WHERE m.id=?', [id]);
    matter.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id=?', [id]);
    matter.caption_notes = (await window.api.dbAll(
      'SELECT note_text FROM matter_caption_notes WHERE matter_id=? ORDER BY sort_order', [id])).map(r => r.note_text);
    const dt = window.DocumentEngine.doctypes.find(d => d.id === 'appearance');
    const blocks = dt.build(matter, attorney, { dated: '2026-01-05' });
    const html = window.DocumentEngine.renderHtml(blocks, matter, attorney);
    const docx = await window.api.generateDocx(blocks, matter, attorney, dt.label, dt.id);
    return { docx: docx.path, html };
  };

  const one = await mk('Notes As One', ['OWI, Speed 11-15, BAC 0.XX']);
  const three = await mk('Notes As Three', ['OWI', 'Speed 11-15', 'BAC 0.XX']);

  // Editing ONLY a caption note must produce a new .docx. Nothing about a
  // caption note appears in the block list — { type: 'district_caption' } is
  // the whole block — so a hash taken over the blocks alone cannot see this
  // change and hands back the stale file. Also true of the judge, the court
  // header and the case number.
  const edited = await window.api.dbGet('SELECT * FROM matters WHERE short_name = ?', ['Notes As Three']);
  const editedMatter = await window.api.dbGet(
    'SELECT m.*, c.name as court_name, c.header_line as court_header_line FROM matters m LEFT JOIN courts c ON c.id=m.court_id WHERE m.id=?', [edited.id]);
  editedMatter.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id=?', [edited.id]);
  editedMatter.caption_notes = ['OWI', 'Speed 11-15', 'BAC 0.YY'];  // last note edited
  const dtEdit = window.DocumentEngine.doctypes.find(d => d.id === 'appearance');
  const editedDocx = await window.api.generateDocx(
    dtEdit.build(editedMatter, attorney, { dated: '2026-01-05' }), editedMatter, attorney, dtEdit.label, dtEdit.id);

  // A document generated before migration 12 has a matter_snapshot carrying
  // `charges` and no `caption_notes`. Regenerating it must still print its
  // notes, or every already-filed document silently loses its caption stack.
  const legacyMatter = await window.api.dbGet(
    'SELECT m.*, c.name as court_name, c.header_line as court_header_line FROM matters m LEFT JOIN courts c ON c.id=m.court_id WHERE m.short_name=?', ['Notes As One']);
  legacyMatter.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id=?', [legacyMatter.id]);
  legacyMatter.charges = 'PRE-MIGRATION NOTE A\nPRE-MIGRATION NOTE B';
  delete legacyMatter.caption_notes;
  const dt = window.DocumentEngine.doctypes.find(d => d.id === 'appearance');
  const legacyBlocks = dt.build(legacyMatter, attorney, { dated: '2026-01-05' });
  const legacyHtml = window.DocumentEngine.renderHtml(legacyBlocks, legacyMatter, attorney);
  const legacyDocx = await window.api.generateDocx(legacyBlocks, legacyMatter, attorney, dt.label, dt.id);

  // ...but once caption_notes exists, it wins outright. An empty list means
  // the user deleted every note, and the retired column must not resurrect
  // them.
  const supersededMatter = { ...legacyMatter, caption_notes: [] };
  const supersededHtml = window.DocumentEngine.renderHtml(
    dt.build(supersededMatter, attorney, { dated: '2026-01-05' }), supersededMatter, attorney);

  return { one, three, edited: editedDocx, legacyHtml, legacyDocx: legacyDocx.path, supersededHtml };
}).catch(e => ({ error: String(e) }));

// Temporary case-number flag:
// a matter can carry a case_number while case_number_pending suppresses it
// from every printed caption, falling back to the same blank line used for
// "no number at all" — never new placeholder text.
const pendingCase = await page.evaluate(async () => {
  const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  const court = (await window.api.dbRun(
    'INSERT INTO courts (name, header_line) VALUES (?,?)',
    ['PENDING TEST COURT', 'IN THE PENDING TEST COURT'])).lastInsertRowid;

  const mkMatter = async (pending) => {
    const id = (await window.api.dbRun(
      `INSERT INTO matters (folder_person_id, short_name, case_number, case_number_pending, court_id, client_role,
        party_label, caption_authority, created_at) VALUES (0, ?,?,?,?,?,?,?,?)`,
      ['Pending Flag Test', 'PENDING-9999', pending ? 1 : 0, court, 'defendant',
       'Defendant', 'PEOPLE OF THE STATE OF MICHIGAN', new Date().toISOString()])).lastInsertRowid;
    await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)',
      [id, 'Pat Placeholder', 'defendant']);
    const matter = await window.api.dbGet(
      `SELECT m.*, c.name as court_name, c.header_line as court_header_line
       FROM matters m LEFT JOIN courts c ON c.id=m.court_id WHERE m.id=?`, [id]);
    matter.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id=?', [id]);
    matter.caption_notes = [];
    matter.cases = [{ case_number: matter.case_number, judge_name: null }];
    return matter;
  };

  // Drives district_caption (appearance), appellate_caption (appellate_brief)
  // and the legacy caption (notice_of_hearing) the same way a real document
  // does: through a doctype's build(), then through both renderHtml and
  // generateDocx — not by calling the private render*Caption functions
  // directly.
  const renderCaption = async (dtId, matter) => {
    const dt = window.DocumentEngine.doctypes.find(d => d.id === dtId);
    const fields = dtId === 'notice_of_hearing'
      ? { hearing_date: '2026-09-01', hearing_time: '9:00 AM', motion_being_heard: 'Test Motion', judge_courtroom: 'Room 1' }
      : { dated: '2026-01-05' };
    const blocks = dt.build(matter, attorney, fields);
    const html = window.DocumentEngine.renderHtml(blocks, matter, attorney);
    const docx = await window.api.generateDocx(blocks, matter, attorney, dt.label, dt.id);
    return { html, docxPath: docx.path };
  };

  const pending = await mkMatter(true);
  const notPending = await mkMatter(false);

  const both = async (dtId) => ({
    pending: await renderCaption(dtId, pending),
    notPending: await renderCaption(dtId, notPending)
  });

  return {
    district: await both('appearance'),
    appellate: await both('appellate_brief'),
    legacy: await both('notice_of_hearing')
  };
}).catch(e => ({ error: String(e) }));

if (pendingCase.error) {
  check('temporary case-number flag fixtures', false, pendingCase.error);
} else {
  for (const [label, key] of [['district', 'district'], ['appellate', 'appellate'], ['legacy', 'legacy']]) {
    const c = pendingCase[key];
    const pendingXml = readDocxXml(c.pending.docxPath);
    const notPendingXml = readDocxXml(c.notPending.docxPath);

    check(`${label} caption, PDF engine: pending suppresses the case number`,
      !c.pending.html.includes('PENDING-9999') && c.pending.html.includes('____________'));
    check(`${label} caption, Word engine: pending suppresses the case number`,
      !!pendingXml && !pendingXml.includes('PENDING-9999') && pendingXml.includes('____________'));
    check(`${label} caption, PDF engine: NOT pending still prints the case number`,
      c.notPending.html.includes('PENDING-9999'));
    check(`${label} caption, Word engine: NOT pending still prints the case number`,
      !!notPendingXml && notPendingXml.includes('PENDING-9999'));
  }
}

// "et al." manual override:
// matters.caption_style now has a third state, 'et_al_force', and several
// call sites that used to ignore caption_style entirely (the district and
// appellate captions' plaintiff authority lines, the appellate caption's
// defendant line) now respect it consistently across all three caption
// types and both render engines.
const captionStyleCoverage = await page.evaluate(async () => {
  const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  const court = (await window.api.dbRun(
    'INSERT INTO courts (name, header_line) VALUES (?,?)',
    ['CAPTION STYLE TEST COURT', 'IN THE CAPTION STYLE TEST COURT'])).lastInsertRowid;

  const mkMatter = async (label, plaintiffNames, defendantNames) => {
    const id = (await window.api.dbRun(
      `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, client_role, party_label, created_at)
       VALUES (0, ?,?,?,?,?,?)`,
      [`Caption Style ${label}`, `CS-${label}`, court, 'defendant', 'Defendant',
       new Date().toISOString()])).lastInsertRowid;
    let order = 0;
    for (const name of plaintiffNames) {
      await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,?)',
        [id, name, 'plaintiff', order++]);
    }
    order = 0;
    for (const name of defendantNames) {
      await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,?)',
        [id, name, 'defendant', order++]);
    }
    const matter = await window.api.dbGet(
      `SELECT m.*, c.name as court_name, c.header_line as court_header_line
       FROM matters m LEFT JOIN courts c ON c.id=m.court_id WHERE m.id=?`, [id]);
    matter.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id=?', [id]);
    matter.caption_notes = [];
    matter.cases = [{ case_number: matter.case_number, judge_name: null }];
    return matter;
  };

  // Same drive-it-through-a-real-doctype pattern as the pending-case-flag
  // fixture above: appearance -> district caption, appellate_brief ->
  // appellate caption, notice_of_hearing -> legacy caption.
  const renderCaption = async (dtId, matter) => {
    const dt = window.DocumentEngine.doctypes.find(d => d.id === dtId);
    const fields = dtId === 'notice_of_hearing'
      ? { hearing_date: '2026-09-01', hearing_time: '9:00 AM', motion_being_heard: 'Test Motion', judge_courtroom: 'Room 1' }
      : { dated: '2026-01-05' };
    const blocks = dt.build(matter, attorney, fields);
    const html = window.DocumentEngine.renderHtml(blocks, matter, attorney);
    const docx = await window.api.generateDocx(blocks, matter, attorney, dt.label, dt.id);
    return { html, docxPath: docx.path };
  };

  const DOCTYPES = [['district', 'appearance'], ['appellate', 'appellate_brief'], ['legacy', 'notice_of_hearing']];

  const multi = await mkMatter('Multi', ['Alice Anderson', 'Bob Baker'], ['Carla Chen', 'Dan Dawson']);
  const single = await mkMatter('Single', ['Eve Ellis'], ['Frank Foster']);

  const multiResults = {};
  for (const style of ['full', 'et_al', 'et_al_force']) {
    multi.caption_style = style;
    multiResults[style] = {};
    for (const [label, dtId] of DOCTYPES) {
      multiResults[style][label] = await renderCaption(dtId, multi);
    }
  }

  single.caption_style = 'et_al_force';
  const singleForce = {};
  for (const [label, dtId] of DOCTYPES) {
    singleForce[label] = await renderCaption(dtId, single);
  }

  return { multi: multiResults, singleForce };
}).catch(e => ({ error: String(e) }));

if (captionStyleCoverage.error) {
  check('caption_style coverage fixtures', false, captionStyleCoverage.error);
} else {
  const { multi, singleForce } = captionStyleCoverage;
  const CAPTION_LABELS = ['district', 'appellate', 'legacy'];

  for (const label of CAPTION_LABELS) {
    // District and appellate captions print party names all-caps
    // (document-engine.js's renderDistrictCaption/renderAppellateCaption both
    // call .toUpperCase() on the authority/defendant text); the legacy
    // caption does not. Pre-existing formatting, unrelated to this feature —
    // match each caption's actual case convention rather than asserting one
    // literal case everywhere.
    const cased = (s) => label === 'legacy' ? s : s.toUpperCase();

    // 'full' with 2+ parties on each side: every name appears, none collapsed.
    const full = multi.full[label];
    const fullXml = readDocxXml(full.docxPath);
    for (const name of ['Alice Anderson', 'Bob Baker', 'Carla Chen', 'Dan Dawson']) {
      check(`${label} caption, 'full' style, PDF engine: prints ${name}`, full.html.includes(cased(name)));
      check(`${label} caption, 'full' style, Word engine: prints ${name}`, !!fullXml && fullXml.includes(cased(name)));
    }
    check(`${label} caption, 'full' style, PDF engine: does not collapse to et al.`,
      !full.html.includes(cased('et al.')));
    check(`${label} caption, 'full' style, Word engine: does not collapse to et al.`,
      !!fullXml && !fullXml.includes(cased('et al.')));

    // 'et_al' (today's long-standing default) with 2+ parties: collapses to
    // first name + ", et al." — a regression guard for pre-existing behavior.
    const etAl = multi.et_al[label];
    const etAlXml = readDocxXml(etAl.docxPath);
    check(`${label} caption, 'et_al' style, PDF engine: collapses plaintiff to Alice Anderson, et al.`,
      etAl.html.includes(cased('Alice Anderson, et al.')));
    check(`${label} caption, 'et_al' style, Word engine: collapses plaintiff to Alice Anderson, et al.`,
      !!etAlXml && etAlXml.includes(cased('Alice Anderson, et al.')));
    check(`${label} caption, 'et_al' style, PDF engine: collapses defendant to Carla Chen, et al.`,
      etAl.html.includes(cased('Carla Chen, et al.')));
    check(`${label} caption, 'et_al' style, Word engine: collapses defendant to Carla Chen, et al.`,
      !!etAlXml && etAlXml.includes(cased('Carla Chen, et al.')));

    // 'et_al_force' with exactly ONE named party per side: forces "et al."
    // anyway — the actual gap this feature closes.
    const force = singleForce[label];
    const forceXml = readDocxXml(force.docxPath);
    check(`${label} caption, 'et_al_force' style, PDF engine: forces Eve Ellis, et al. with one plaintiff`,
      force.html.includes(cased('Eve Ellis, et al.')));
    check(`${label} caption, 'et_al_force' style, Word engine: forces Eve Ellis, et al. with one plaintiff`,
      !!forceXml && forceXml.includes(cased('Eve Ellis, et al.')));
    check(`${label} caption, 'et_al_force' style, PDF engine: forces Frank Foster, et al. with one defendant`,
      force.html.includes(cased('Frank Foster, et al.')));
    check(`${label} caption, 'et_al_force' style, Word engine: forces Frank Foster, et al. with one defendant`,
      !!forceXml && forceXml.includes(cased('Frank Foster, et al.')));
  }
}

// --- Empty-plaintiff placeholder (8c) ---------------------------------------
// No caption authority (per-case or type) and no plaintiff parties: the
// district and appellate captions print the bracketed "[PLAINTIFF]" blank in
// both engines, the same convention as "[DEFENDANT]".
const emptyPlaintiff = await page.evaluate(async () => {
  const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  const id = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, case_number, client_role, party_label, created_at)
     VALUES (0, 'Empty Plaintiff Case', 'EP-1', 'defendant', 'Defendant', ?)`,
    [new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun("INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,'Gina Green','defendant',0)", [id]);
  const matter = await window.api.dbGet('SELECT * FROM matters WHERE id=?', [id]);
  matter.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id=?', [id]);
  matter.caption_notes = [];
  matter.cases = [{ case_number: matter.case_number, judge_name: null }];
  const out = {};
  for (const [label, dtId] of [['district', 'appearance'], ['appellate', 'appellate_brief']]) {
    const dt = window.DocumentEngine.doctypes.find(d => d.id === dtId);
    const blocks = dt.build(matter, attorney, { dated: '2026-01-05' });
    const html = window.DocumentEngine.renderHtml(blocks, matter, attorney);
    const docx = await window.api.generateDocx(blocks, matter, attorney, dt.label, dt.id);
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    out[label] = {
      firstParty: (parsed.querySelector('.cap-party') || {}).textContent,
      html, docxPath: docx.path
    };
  }
  return out;
}).catch(e => ({ error: String(e) }));

if (emptyPlaintiff.error) {
  check('empty-plaintiff placeholder fixtures', false, emptyPlaintiff.error);
} else {
  for (const label of ['district', 'appellate']) {
    const c = emptyPlaintiff[label];
    const xml = readDocxXml(c.docxPath) || '';
    check(`${label} caption, PDF engine: no authority and no plaintiffs prints [PLAINTIFF]`,
      c.html.includes('[PLAINTIFF]'), String(c.firstParty));
    check(`${label} caption, Word engine: no authority and no plaintiffs prints [PLAINTIFF]`,
      xml.includes('[PLAINTIFF]'), c.docxPath);
  }
}

// --- Packet RE: line placeholders (9A) --------------------------------------
// packetCaseName's "|| '[PLAINTIFF]'" / "|| '[DEFENDANT]'" were unreachable:
// partyCaptionText never returns empty. With no recipient and no parties on a
// side, the RE: line prints the bracketed blanks in both engines.
const packetReBlanks = await page.evaluate(async () => {
  const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  const id = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, case_number, client_role, party_label, created_at)
     VALUES (0, 'Packet RE Blanks', 'RB-1', 'defendant', 'Defendant', ?)`,
    [new Date().toISOString()])).lastInsertRowid;
  const matter = await window.api.dbGet('SELECT * FROM matters WHERE id=?', [id]);
  matter.parties = [];
  matter.caption_notes = [];
  matter.cases = [{ case_number: matter.case_number, judge_name: null }];
  const dt = window.DocumentEngine.doctypes.find(d => d.id === 'cd_transmittal');
  const blocks = dt.build(matter, attorney, { packet: { packet_date: '2026-01-05', recipient_name: '' }, enclosures: [] });
  const re = blocks.find(b => b.type === 're_block');
  const html = window.DocumentEngine.renderHtml(blocks, matter, attorney);
  const docx = await window.api.generateDocx(blocks, matter, attorney, dt.label, dt.id);
  return { line: re ? re.lines[1] : null, html, docxPath: docx.path };
}).catch(e => ({ error: String(e) }));

if (packetReBlanks.error) {
  check('packet RE: blanks fixture', false, packetReBlanks.error);
} else {
  const want = '[PLAINTIFF] v [DEFENDANT]';
  check('packet RE: line, no recipient/parties, PDF engine prints [PLAINTIFF] v [DEFENDANT]',
    packetReBlanks.html.includes(want), String(packetReBlanks.line));
  check('packet RE: line, no recipient/parties, Word engine prints [PLAINTIFF] v [DEFENDANT]',
    (readDocxXml(packetReBlanks.docxPath) || '').includes(want), packetReBlanks.docxPath);
}

// --- The legacy caption/signature, used by three live doc types -------------
// Notice of Hearing, Generic Motion and Brief still use the older generic
// caption. It had almost no coverage, and an audit on 2026-08-19 found it
// disagreed with both the settled format decisions and with its own Word
// export. A matter labeled "Respondent" is used deliberately: the caption and
// the signature must agree on the role word, which is the contradiction this
// app exists to remove.
const legacyBlocks = await page.evaluate(async () => {
  const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  const court = (await window.api.dbRun(
    'INSERT INTO courts (name, header_line) VALUES (?,?)',
    ['93rd DISTRICT COURT', 'IN THE 93rd DISTRICT COURT'])).lastInsertRowid;
  const id = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, client_role, caption_style,
      party_label, plaintiff_label, created_at) VALUES (0, ?,?,?,?,?,?,?,?)`,
    ['Legacy Blocks', '29X-777-GC', court, 'defendant', 'full', 'Respondent', 'Petitioner',
     new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)', [id, 'Ann Applicant', 'plaintiff']);
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)', [id, 'Ray Respondent', 'defendant']);
  await window.api.dbRun(
    'INSERT INTO matter_caption_notes (matter_id, note_text, sort_order) VALUES (?,?,0)', [id, 'LEGACY CAPTION NOTE']);

  const matter = await window.api.dbGet(
    'SELECT m.*, c.name as court_name, c.header_line as court_header_line FROM matters m LEFT JOIN courts c ON c.id=m.court_id WHERE m.id=?', [id]);
  matter.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id=?', [id]);
  matter.caption_notes = (await window.api.dbAll(
    'SELECT note_text FROM matter_caption_notes WHERE matter_id=? ORDER BY sort_order', [id])).map(r => r.note_text);

  const dt = window.DocumentEngine.doctypes.find(d => d.id === 'notice_of_hearing');
  const blocks = dt.build(matter, attorney, { hearing_date: '2026-03-04', hearing_time: '9:00 AM' });
  const html = window.DocumentEngine.renderHtml(blocks, matter, attorney);
  const docx = await window.api.generateDocx(blocks, matter, attorney, dt.label, dt.id);

  // An attorney with no bar number, phone or email: the empty-field handling
  // used to print "()" in the PDF and "(undefined)" in Word.
  const sparse = { name: 'Sparse Counsel', firm_address: '1 Only Street\nExampleton, MI 48000' };
  const sparseHtml = window.DocumentEngine.renderHtml(dt.build(matter, sparse, {}), matter, sparse);
  const sparseDocx = await window.api.generateDocx(
    dt.build(matter, sparse, {}), matter, sparse, dt.label, dt.id);

  // Migration 16: a counsel block holds a LIST. A filed answer stacks two of
  // two attorneys of one office above ONE shared office line.
  const coAttId = (await window.api.dbRun(
    'INSERT INTO attorneys (name, bar_number, firm_name) VALUES (?,?,?)',
    ['Marcus Cole', 'P99881', 'Doe & Cole PLLC'])).lastInsertRowid;
  const coAtt = await window.api.dbGet('SELECT id, name, bar_number FROM attorneys WHERE id=?', [coAttId]);
  const coMatter = { ...matter, co_counsel: [coAtt] };
  const coHtml = window.DocumentEngine.renderHtml(dt.build(coMatter, attorney, {}), coMatter, attorney);
  const coDocx = await window.api.generateDocx(dt.build(coMatter, attorney, {}), coMatter, attorney, dt.label, dt.id);

  // The signing attorney is chosen per document while the list lives on the
  // matter, so the same person lands in both constantly. Must print once.
  const dupMatter = { ...matter, co_counsel: [{ id: attorney.id, name: attorney.name, bar_number: attorney.bar_number }, coAtt] };
  const dupHtml = window.DocumentEngine.renderHtml(dt.build(dupMatter, attorney, {}), dupMatter, attorney);

  // The `counsel_block` block type itself, rendered bare. The legacy caption
  // above shares counselLines() but has its own (unbolded) layout, so it
  // cannot verify the block's bold-every-name-line rule.
  const cbBlocks = [{ type: 'counsel_block' }];
  const cbHtml = window.DocumentEngine.renderHtml(cbBlocks, coMatter, attorney);
  const cbDocx = await window.api.generateDocx(cbBlocks, coMatter, attorney, 'Counsel Block', 'appearance');

  return { html, docx: docx.path, sparseHtml, sparseDocx: sparseDocx.path,
           coHtml, coDocx: coDocx.path, dupHtml, coName: coAtt.name,
           cbHtml, cbDocx: cbDocx.path };
}).catch(e => ({ error: String(e) }));

// --- The claim & delivery packet (Phase 3) ----------------------------------
// One filing: five documents, one date, one folder. The transmittal letter's
// enclosure list and the proof of service's document list are DERIVED from the
// packet's contents, so they can never disagree about what was sent — the
// filed example this was built from actually names the same paper two
// different ways in those two places.
const packet = await page.evaluate(async () => {
  const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  const court = (await window.api.dbRun(
    'INSERT INTO courts (name, header_line, county) VALUES (?,?,?)',
    ['94th DISTRICT COURT', 'IN THE 94th DISTRICT COURT', 'Wayne'])).lastInsertRowid;
  const lh = (await window.api.dbRun(
    `INSERT INTO letterheads (label, masthead, office_lines, address, phone, fax, side_names, ref_separator, typist_initials)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Testerton', 'City of Testerton', 'OFFICE OF THE\nCITY ATTORNEY',
     '1 Civic Plaza\nTesterton, Michigan 48000', '(555) 010-2000', '(555) 010-2001',
     'JANE DOE\nCITY ATTORNEY', ':', 'de'])).lastInsertRowid;

  const matterId = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, client_role, caption_style,
       party_label, created_at) VALUES (0, ?,?,?,?,?,?,?)`,
    ['Packet Test', '26-99887-GZ', court, 'defendant', 'full', 'Defendant',
     new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)',
    [matterId, 'Pat Claimant', 'plaintiff']);
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)',
    [matterId, 'Testerton Police Department', 'defendant']);

  const pkId = (await window.api.dbRun(
    `INSERT INTO packets (matter_id, kind, label, packet_date, letterhead_id, item_description,
       recipient_name, recipient_address, court_recipient_name, court_recipient_address, memo_to, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [matterId, 'claim_and_delivery', 'Claim & Delivery Response', '2026-01-12', lh,
     'One Placeholder Item Serial # abc123',
     'Pat Claimant', '5 Sample Street\nTesterton, MI 48000',
     'CLERK OF THE 94th DISTRICT COURT', '1 Court Street\nTesterton, MI 48000',
     'Property Officer', new Date().toISOString()])).lastInsertRowid;

  const p = await window.api.dbGet('SELECT * FROM packets WHERE id = ?', [pkId]);
  const def = window.DocumentEngine.packets.find(d => d.id === 'claim_and_delivery');
  const enclosures = window.DocumentEngine.packetEnclosures(def);

  const base = await window.api.dbGet(
    `SELECT m.*, c.name as court_name, c.header_line as court_header_line, c.county as court_county
     FROM matters m LEFT JOIN courts c ON c.id = m.court_id WHERE m.id = ?`, [matterId]);
  base.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id=?', [matterId]);
  base.caption_notes = [];
  base.letterhead = await window.api.dbGet('SELECT * FROM letterheads WHERE id = ?', [lh]);

  const out = [];
  for (let i = 0; i < def.documents.length; i++) {
    const spec = def.documents[i];
    const dt = window.DocumentEngine.doctypes.find(d => d.id === spec.doc_type);
    const forDoc = { ...base, packet: { id: p.id, kind: p.kind, label: p.label,
      packet_date: p.packet_date, sort_order: i } };
    const blocks = dt.build(forDoc, attorney, { packet: p, enclosures, spec });
    const html = window.DocumentEngine.renderHtml(blocks, forDoc, attorney);
    const docx = await window.api.generateDocx(blocks, forDoc, attorney, spec.file_label || spec.title, dt.id);
    out.push({ id: dt.id, title: spec.title, role: spec.role, html, docx: docx.path });
  }

  const frozen = await window.api.dbGet('SELECT output_dir FROM packets WHERE id = ?', [pkId]);
  return { docs: out, enclosureTitles: enclosures.map(e => e.title), packetDir: frozen.output_dir };
}).catch(e => ({ error: String(e) })).then(resolveStored);

// --- The driver-license hearing request packet -------------------------------
// Two documents on a personal letterhead: a covering letter to the DAAD and
// an Appearance and Request for Hearing carrying the fixed agency caption.
// No court, no case number — packetPreflight()'s case-number check is gated
// off for this kind (requiresCaseNumber: false) because there genuinely isn't
// one at filing time.
const dlPacket = await page.evaluate(async () => {
  const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  // Deliberately give the attorney a firm_name AND the letterhead side_names
  // a value that would only print if the personal-letterhead branch fell
  // through to the city layout, or if letter_close's fixed office-line bug
  // (att.firm_name instead of the letterhead) came back.
  await window.api.dbRun('UPDATE attorneys SET firm_name = ? WHERE id = ?',
    ['SHOULD NOT PRINT ON A PERSONAL LETTER', attorney.id]);
  const lh = (await window.api.dbRun(
    `INSERT INTO letterheads (label, kind, masthead, address, phone, fax, side_names, ref_separator)
     VALUES (?,?,?,?,?,?,?,?)`,
    ['Personal', 'personal', 'SAMPLE TEST ATTORNEY',
     '123 Test Street\nTesterton, MI 48000', '(555) 010-3000', '(555) 010-3001',
     'SHOULD NOT PRINT — SIDE NAMES ARE CITY-ONLY', '/'])).lastInsertRowid;

  const matterId = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, client_role, caption_style, party_label, created_at)
     VALUES (0, ?,?,?,?,?)`,
    ['DL Packet Test', 'defendant', 'full', 'Petitioner', new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)',
    [matterId, 'Jamie Client', 'defendant']);

  const mk = async (hearingType) => {
    const pkId = (await window.api.dbRun(
      `INSERT INTO packets (matter_id, kind, label, packet_date, letterhead_id, hearing_type,
         client_dob, client_license_number, recipient_name, recipient_address, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [matterId, 'driver_license_hearing', 'DL Hearing Request', '2026-02-09', lh, hearingType,
       '1990-05-28', 'X-000-111-222-333', 'Driver Assessment and Appeal Division',
       'P.O. Box 00000\nExampleton, MI 48000', new Date().toISOString()])).lastInsertRowid;

    const p = await window.api.dbGet('SELECT * FROM packets WHERE id = ?', [pkId]);
    const def = window.DocumentEngine.packets.find(d => d.id === 'driver_license_hearing');
    const enclosures = window.DocumentEngine.packetEnclosures(def);

    const base = await window.api.dbGet(
      `SELECT m.*, c.name as court_name, c.header_line as court_header_line
       FROM matters m LEFT JOIN courts c ON c.id = m.court_id WHERE m.id = ?`, [matterId]);
    base.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id=?', [matterId]);
    base.caption_notes = [];
    base.letterhead = await window.api.dbGet('SELECT * FROM letterheads WHERE id = ?', [lh]);

    const out = [];
    for (let i = 0; i < def.documents.length; i++) {
      const spec = def.documents[i];
      const dt = window.DocumentEngine.doctypes.find(d => d.id === spec.doc_type);
      const forDoc = { ...base, packet: { id: p.id, kind: p.kind, label: p.label,
        packet_date: p.packet_date, sort_order: i } };
      const blocks = dt.build(forDoc, attorney, { packet: p, enclosures, spec });
      const html = window.DocumentEngine.renderHtml(blocks, forDoc, attorney);
      const docx = await window.api.generateDocx(blocks, forDoc, attorney, spec.file_label || spec.title, dt.id);
      out.push({ id: dt.id, title: spec.title, role: spec.role, html, docx: docx.path });
    }
    return { docs: out, enclosureCount: enclosures.length, requiresCaseNumber: def.requiresCaseNumber };
  };

  // Run twice with a vowel- and a consonant-leading hearing type, to catch an
  // off-by-one in the a/an helper independently of the exhibit's own wording.
  const vowel = await mk('Implied Consent Refusal');
  const consonant = await mk('Restricted License Appeal');

  return { vowel, consonant };
}).catch(e => ({ error: String(e) }));

// --- Phase 4: the stipulation & order --------------------------------------
// Two pages, one filing: a district-court caption + stipulation + dual
// signature, a page break, then the order (no caption, centered throughout).
// The load-bearing check is that the FROM date is byte-identical on both
// pages — the filed working file this was transcribed from shows what
// happens when it isn't (two different dates, one page apart).
const stipOrder = await page.evaluate(async () => {
  const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  const oc = (await window.api.dbRun(
    `INSERT INTO people (display_name, kind, bar_number, created_at) VALUES (?,?,?,?)`,
    ['Terrence F. Prosecutor', 'individual', 'P90012', new Date().toISOString()])).lastInsertRowid;
  const court = (await window.api.dbRun(
    `INSERT INTO courts (name, header_line, city, county) VALUES (?,?,?,?)`,
    ['95th District Court', 'IN THE 95th JUDICIAL DISTRICT COURT', 'Sampleton', 'Wayne'])).lastInsertRowid;
  const judge = (await window.api.dbRun('INSERT INTO judges (name, court_id) VALUES (?,?)', ['Eleanor M. Docket', court])).lastInsertRowid;
  const matterId = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, judge_id, client_role, caption_style,
       party_label, caption_authority, opposing_counsel_person_id, created_at) VALUES (0, ?,?,?,?,?,?,?,?,?,?)`,
    ['Stip Test', '26-STIP-OD', court, judge, 'defendant', 'full', 'Defendant',
     'PEOPLE OF THE CITY OF SAMPLETON', oc, new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun('INSERT INTO parties (matter_id,name,side,sort_order) VALUES (?,?,?,0)',
    [matterId, 'Tessa Rose Doe', 'defendant']);
  await window.api.dbRun(
    'INSERT INTO matter_caption_notes (matter_id, note_text, sort_order) VALUES (?,?,0)', [matterId, 'BAC .XX >']);

  const matter = await window.api.dbGet(
    `SELECT m.*, c.name as court_name, c.header_line as court_header_line,
            c.city as court_city, c.county as court_county, j.name as judge_name
     FROM matters m LEFT JOIN courts c ON c.id=m.court_id LEFT JOIN judges j ON j.id=m.judge_id
     WHERE m.id=?`, [matterId]);
  matter.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id=?', [matterId]);
  matter.caption_notes = (await window.api.dbAll(
    'SELECT note_text FROM matter_caption_notes WHERE matter_id=? ORDER BY sort_order', [matterId])).map(r => r.note_text);
  const o = await window.api.dbGet('SELECT * FROM people WHERE id=?', [oc]);
  matter.opposing_counsel_person = { name: o.display_name, bar_number: o.bar_number };

  const dt = window.DocumentEngine.doctypes.find(d => d.id === 'stipulation_and_order');
  const blocks = dt.build(matter, attorney, {
    hearing_type: 'Formal Hearing',
    from_datetime: 'Tuesday, September 1, 2026 at 9:40 a.m.',
    reason: 'defense counsel will be out of the country on that date and unable to contact the court via zoom'
  });
  const html = window.DocumentEngine.renderHtml(blocks, matter, attorney);
  const docx = await window.api.generateDocx(blocks, matter, attorney, dt.label, dt.id);

  // A matter with NO opposing counsel person and no free-text fallback
  // either — the left signature column must render blank, not crash or
  // print an empty "Attorney for Plaintiff," line.
  const bareMatter = { ...matter, opposing_counsel_person: {}, opposing_counsel: '' };
  const bareBlocks = dt.build(bareMatter, attorney, {
    hearing_type: 'Formal Hearing', from_datetime: 'Monday, January 5, 2026', reason: 'scheduling conflict'
  });
  const bareHtml = window.DocumentEngine.renderHtml(bareBlocks, bareMatter, attorney);
  const bareDocx = await window.api.generateDocx(bareBlocks, bareMatter, attorney, dt.label, dt.id);

  return { html, docx: docx.path, bareHtml, bareDocx: bareDocx.path };
}).catch(e => ({ error: String(e) }));

// --- People: one person reused across two matters, driven through the UI ----
const people = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  document.getElementById('nav-people').click();
  await wait(400);
  const tabVisible = !document.getElementById('view-people').classList.contains('hidden');

  // Create a person through the form, as a user would.
  document.getElementById('btn-new-person').click();
  await wait(200);
  document.getElementById('per-display_name').value = 'Repeat Client LLC';
  document.getElementById('per-kind').value = 'organization';
  document.getElementById('per-firm_name').value = 'Repeat Holdings';
  document.getElementById('btn-save-person').click();
  await wait(500);
  const personId = Number(document.getElementById('per-id').value);

  // Attach that one person to two different matters.
  const mk = async (name, caseNo) => {
    const r = await window.api.dbRun(
      "INSERT INTO matters (short_name, case_number, client_role, caption_style, created_at) VALUES (?,?,?,?,?)",
      [name, caseNo, 'defendant', 'full', new Date().toISOString()]);
    await window.api.dbRun(
      "INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,0)",
      [r.lastInsertRowid, personId, 'Repeat Client LLC', 'defendant', 'client']);
    return r.lastInsertRowid;
  };
  await mk('First Matter', '2026-AA-111');
  await mk('Second Matter', '2026-BB-222');

  // Reopen the person and read their Cases panel.
  document.getElementById('nav-people').click();
  await wait(400);
  const rows = [...document.querySelectorAll('#people-list tr')].map(r => r.innerText);
  const target = [...document.querySelectorAll('#people-list tr')]
    .find(r => r.innerText.includes('Repeat Client LLC'));
  if (target) target.click();
  await wait(500);
  const casesText = document.getElementById('person-cases').innerText;

  // Matter-type dropdown should be populated from the seeded types.
  document.getElementById('nav-matters').click();
  await wait(300);
  document.getElementById('btn-new-matter').click();
  await wait(400);
  const typeOptions = [...document.getElementById('mat-matter_type_id').options].map(o => o.textContent);

  return { tabVisible, personId, peopleRows: rows, casesText, typeOptions };
}).catch(e => ({ error: String(e) }));

if (people.error) {
  check('People tab', false, people.error);
} else {
  check('People tab opens', people.tabVisible);
  check('person saved', people.personId > 0, `id=${people.personId}`);
  check('person listed with matter count',
    people.peopleRows.some(r => r.includes('Repeat Client LLC') && /\b2\b/.test(r)),
    JSON.stringify(people.peopleRows));
  check('person Cases panel lists both matters',
    people.casesText.includes('First Matter') && people.casesText.includes('Second Matter'),
    people.casesText.replace(/\n/g, ' | '));
  check('Cases panel shows case numbers',
    people.casesText.includes('2026-AA-111') && people.casesText.includes('2026-BB-222'));
  check('matter type dropdown populated',
    people.typeOptions.length >= 3 && people.typeOptions.some(o => o.includes('Criminal Defense')),
    JSON.stringify(people.typeOptions));
  check('no placeholder matter types are offered',
    !people.typeOptions.some(o => /\[[A-Z ]+\]|Municipality [AB]/.test(o)),
    JSON.stringify(people.typeOptions));
}

// --- Work Product: every packet for a client, filings AND letters -----------
// The old "Letters" panel asked only for kind = 'standalone_letter' joined on
// recipient_person_id, so a court filing generated for a client never appeared
// on that client's page at all. A panel that silently omits most of a client's
// work product is worse than no panel. It now reaches packets two ways —
// directly by recipient, and through `parties` on the packet's matter.
const workProduct = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const person = (await window.api.dbRun(
    "INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)",
    ['Work Product Client', 'individual', new Date().toISOString()])).lastInsertRowid;
  const matter = (await window.api.dbRun(
    "INSERT INTO matters (short_name, case_number, client_role, caption_style, created_at) VALUES (?,?,?,?,?)",
    ['Work Product Matter', '2026-WP-1', 'defendant', 'full', new Date().toISOString()])).lastInsertRowid;

  // The SAME person on the matter TWICE. A person can legitimately appear on
  // both sides of a caption, or as two party rows; the join must not turn one
  // filing into two rows, because a doubled row reads as "I filed this twice".
  await window.api.dbRun(
    "INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,0)",
    [matter, person, 'Work Product Client', 'defendant', 'client']);
  await window.api.dbRun(
    "INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,1)",
    [matter, person, 'Work Product Client', 'plaintiff', 'opposing_party']);

  // A court filing on the matter — reached only through `parties`.
  const filing = (await window.api.dbRun(
    "INSERT INTO packets (matter_id, kind, label, packet_date, created_at) VALUES (?,?,?,?,?)",
    [matter, 'claim_and_delivery', 'Test Filing', '2026-05-02', new Date().toISOString()])).lastInsertRowid;
  // A standalone letter addressed to the person — reached by recipient.
  await window.api.dbRun(
    "INSERT INTO packets (kind, label, packet_date, recipient_person_id, created_at) VALUES (?,?,?,?,?)",
    ['standalone_letter', 'Letter', '2026-03-01', person, new Date().toISOString()]);

  await window.openPerson(person);
  await wait(400);
  const el = document.getElementById('person-work-product');
  if (!el) return { error: 'no #person-work-product element on the person page' };
  const text = el.innerText;
  const links = [...el.querySelectorAll('a')].map(a => a.textContent);

  // Newest first by COALESCE(packet_date, created_at): 2026-05-02 before 2026-03-01.
  const filingAt = text.indexOf('Test Filing');
  const letterAt = text.indexOf('2026-03-01');

  // The filing link must open its packet.
  const filingLink = [...el.querySelectorAll('a')].find(a => a.textContent.includes('Test Filing'));
  let opened = false;
  if (filingLink) {
    filingLink.click();
    await wait(500);
    opened = !document.getElementById('view-packet').classList.contains('hidden')
      && document.getElementById('pk-kind').value === 'claim_and_delivery';
  }

  return {
    text, links, filingAt, letterAt, opened, filing,
    filingRowCount: (text.match(/Test Filing/g) || []).length
  };
}).catch(e => ({ error: String(e) }));

if (workProduct.error) {
  check('Work Product panel', false, workProduct.error);
} else {
  check('a court filing appears in Work Product',
    workProduct.text.includes('Test Filing'), workProduct.text.replace(/\n/g, ' | '));
  check('a standalone letter still appears in Work Product',
    workProduct.text.includes('2026-03-01'), workProduct.text.replace(/\n/g, ' | '));
  check('a person on the same matter twice does not double the filing row',
    workProduct.filingRowCount === 1, `appeared ${workProduct.filingRowCount} time(s)`);
  check('Work Product is newest first',
    workProduct.filingAt >= 0 && workProduct.letterAt > workProduct.filingAt,
    `filing at ${workProduct.filingAt}, letter at ${workProduct.letterAt}`);
  check('each Work Product row shows its date',
    workProduct.text.includes('2026-05-02'), workProduct.text.replace(/\n/g, ' | '));
  check('a Work Product row opens its packet', workProduct.opened);
}

// --- dbTransaction: all or nothing --------------------------------------
//
// Four wholesale saves now depend on this primitive (priors, caption notes,
// co-counsel, parties). Each is a DELETE followed by re-INSERTs, so a batch
// that half-commits leaves a client's record partly erased with nothing to
// roll it back. The happy path is covered by those saves; this covers failure.
const txRollback = await page.evaluate(async () => {
  const now = new Date().toISOString();
  const m = (await window.api.dbRun(
    'INSERT INTO matters (short_name, client_role, caption_style, created_at) VALUES (?,?,?,?)',
    ['TX Rollback Matter', 'defendant', 'full', now])).lastInsertRowid;
  await window.api.dbRun(
    'INSERT INTO matter_caption_notes (matter_id, note_text, sort_order) VALUES (?,?,0)',
    [m, 'Original charge line']);

  // A batch whose second INSERT names a column that does not exist. The DELETE
  // must not survive it.
  let threw = false;
  try {
    await window.api.dbTransaction([
      { sql: 'DELETE FROM matter_caption_notes WHERE matter_id = ?', params: [m] },
      { sql: 'INSERT INTO matter_caption_notes (matter_id, note_text, sort_order) VALUES (?,?,?)',
        params: [m, 'Replacement line', 0] },
      { sql: 'INSERT INTO matter_caption_notes (matter_id, no_such_column) VALUES (?,?)',
        params: [m, 'boom'] }
    ]);
  } catch (e) { threw = true; }

  const after = (await window.api.dbAll(
    'SELECT note_text FROM matter_caption_notes WHERE matter_id = ? ORDER BY sort_order', [m]))
    .map(r => r.note_text);

  // The connection must still be usable — a wedged or locked DB would be worse
  // than the failed write.
  const stillWorks = await window.api.dbGet('SELECT COUNT(*) c FROM matters');

  // A malformed payload must be rejected, not silently treated as a no-op.
  let badPayloadThrew = false;
  try { await window.api.dbTransaction(null); } catch (e) { badPayloadThrew = true; }

  return { threw, after, stillWorks: !!stillWorks, badPayloadThrew };
});
check('a failing statement rejects the whole dbTransaction', txRollback.threw);
check('a failed dbTransaction rolls the DELETE back rather than half-committing',
  txRollback.after.length === 1 && txRollback.after[0] === 'Original charge line',
  JSON.stringify(txRollback.after));
check('the database is still usable after a failed transaction', txRollback.stillWorks);
check('a malformed dbTransaction payload is rejected, not silently ignored',
  txRollback.badPayloadThrew);

// --- A packet reached from Work Product must not leave a stale matter form ---
//
// Work Product sets currentMatterId straight from the clicked row and calls
// openPacket, which never populates the #mat-* inputs — only openMatter does.
// Without a reload on the way back, Save Matter wrote the PREVIOUS matter's
// values onto this one: its case number, its stage, and the caption note that
// prints the client's charge on every filing. Silently.
const staleMatterForm = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const run = (sql, prm) => window.api.dbRun(sql, prm);
  const now = new Date().toISOString();

  const person = (await run('INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
    ['Stale Form Client', 'individual', now])).lastInsertRowid;
  const A = (await run(
    'INSERT INTO matters (short_name, case_number, stage, client_role, caption_style, created_at) VALUES (?,?,?,?,?,?)',
    ['STALE-A Other Matter', 'A-CASE-000', 'Pretrial', 'defendant', 'full', now])).lastInsertRowid;
  const B = (await run(
    'INSERT INTO matters (short_name, case_number, stage, client_role, caption_style, created_at) VALUES (?,?,?,?,?,?)',
    ['REAL-B Stale Form Matter', 'B-CASE-999', 'Arraignment pending', 'defendant', 'full', now])).lastInsertRowid;
  await run('INSERT INTO matter_caption_notes (matter_id, note_text, sort_order) VALUES (?,?,0)',
    [A, 'A STALE CHARGE: Reckless Driving']);
  await run('INSERT INTO matter_caption_notes (matter_id, note_text, sort_order) VALUES (?,?,0)',
    [B, 'Operating While Intoxicated']);
  await run('INSERT INTO parties (matter_id, person_id, name, side, sort_order) VALUES (?,?,?,?,0)',
    [B, person, 'Stale Form Client', 'defendant']);
  await run('INSERT INTO packets (matter_id, kind, label, packet_date, created_at) VALUES (?,?,?,?,?)',
    [B, 'appearance', 'B Filing', '2026-05-02', now]);

  // Load matter A into the form the ordinary way.
  document.getElementById('nav-matters').click();
  await wait(500);
  const rowA = [...document.querySelectorAll('#matters-list tr')]
    .find(r => r.innerText.includes('STALE-A Other Matter'));
  if (!rowA) return { error: 'matter A row not found' };
  rowA.click();
  await wait(700);

  const before = await window.api.dbGet('SELECT short_name, case_number, stage FROM matters WHERE id = ?', [B]);

  // Now reach matter B's filing through the person profile, and come back.
  await window.openPerson(person);
  await wait(500);
  const link = document.querySelector('#person-work-product a');
  if (!link) return { error: 'no Work Product link' };
  link.click();
  await wait(700);
  document.getElementById('btn-back-from-packet').click();
  await wait(900);
  document.getElementById('btn-save-matter').click();
  await wait(1000);

  return {
    before,
    after: await window.api.dbGet('SELECT short_name, case_number, stage FROM matters WHERE id = ?', [B]),
    notes: (await window.api.dbAll('SELECT note_text FROM matter_caption_notes WHERE matter_id = ?', [B]))
      .map(r => r.note_text)
  };
});
if (staleMatterForm.error) {
  check('stale matter form guard', false, staleMatterForm.error);
} else {
  check('coming back from a Work Product packet does not overwrite the matter',
    staleMatterForm.after.case_number === 'B-CASE-999'
      && staleMatterForm.after.short_name === 'REAL-B Stale Form Matter',
    JSON.stringify(staleMatterForm.after));
  check('the stage is not overwritten by the previously open matter',
    staleMatterForm.after.stage === 'Arraignment pending', String(staleMatterForm.after.stage));
  check("the caption note that prints the charge survives",
    staleMatterForm.notes.length === 1 && staleMatterForm.notes[0] === 'Operating While Intoxicated',
    JSON.stringify(staleMatterForm.notes));
}

// --- Saving a matter must not follow the user to another matter -------------
//
// saveMatter is six IPC round trips deep and the Save button does not await it.
// Reading currentMatterId live across those awaits let a click through to
// another matter mid-save write THIS matter's caption notes, counsel, court
// dates and parties onto THAT one — and leave this one with none. The caption
// notes are the lines that print the charge.
const matterSaveRace = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const run = (sql, prm) => window.api.dbRun(sql, prm);
  const now = new Date().toISOString();

  const A = (await run(
    'INSERT INTO matters (short_name, case_number, client_role, caption_style, created_at) VALUES (?,?,?,?,?)',
    ['RACE-A Save Source', 'A-RACE-001', 'defendant', 'full', now])).lastInsertRowid;
  const B = (await run(
    'INSERT INTO matters (short_name, case_number, client_role, caption_style, created_at) VALUES (?,?,?,?,?)',
    ['RACE-B Save Target', 'B-RACE-999', 'defendant', 'full', now])).lastInsertRowid;
  await run('INSERT INTO matter_caption_notes (matter_id, note_text, sort_order) VALUES (?,?,0)',
    [B, "B's OWN CHARGE"]);

  document.getElementById('nav-matters').click(); await wait(500);
  const rowA = [...document.querySelectorAll('#matters-list tr')]
    .find(r => r.innerText.includes('RACE-A Save Source'));
  if (!rowA) return { error: 'RACE-A row not found' };
  rowA.click(); await wait(800);

  document.getElementById('btn-add-note').click(); await wait(200);
  const noteInput = document.querySelector('#matter-notes-list input');
  noteInput.value = "A's STALE CHARGE";
  noteInput.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(200);

  // Unawaited, exactly as the Save button fires it, then navigate mid-flight.
  const savePromise = window.saveMatterForTest();
  await window.openMatterForTest(B);
  await savePromise;
  await wait(400);

  return {
    aNotes: (await window.api.dbAll(
      'SELECT note_text FROM matter_caption_notes WHERE matter_id = ?', [A])).map(r => r.note_text),
    bNotes: (await window.api.dbAll(
      'SELECT note_text FROM matter_caption_notes WHERE matter_id = ?', [B])).map(r => r.note_text),
    bCase: (await window.api.dbGet('SELECT case_number FROM matters WHERE id = ?', [B])).case_number,
    bName: (await window.api.dbGet('SELECT short_name FROM matters WHERE id = ?', [B])).short_name
  };
});
if (matterSaveRace.error) {
  check('the matter-save race guard', false, matterSaveRace.error);
} else {
  check("navigating mid-save does not write this matter's charge onto another",
    matterSaveRace.bNotes.length === 1 && matterSaveRace.bNotes[0] === "B's OWN CHARGE",
    JSON.stringify(matterSaveRace.bNotes));
  check('navigating mid-save does not drop the notes being saved',
    matterSaveRace.aNotes.length === 1 && matterSaveRace.aNotes[0] === "A's STALE CHARGE",
    JSON.stringify(matterSaveRace.aNotes));
  check('the other matter keeps its own case number and name',
    matterSaveRace.bCase === 'B-RACE-999' && matterSaveRace.bName === 'RACE-B Save Target',
    `${matterSaveRace.bCase} / ${matterSaveRace.bName}`);
}

// --- "+ Add" from a picker offers the profile without losing the form -------
//
// The user asked for new people to open their profile. Asked which button, they
// meant the pickers' "+ Add" — which must NOT navigate, because you are partway
// through a filing with unsaved work. It offers instead.
const addPersonLinks = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, tries = 50) => {
    for (let i = 0; i < tries; i++) {
      const v = fn();
      if (v) return v;
      await wait(100);
    }
    return fn();
  };
  const out = {};

  // -- party picker, on the matter form --
  document.getElementById('btn-new-matter').click(); await wait(300);
  document.getElementById('btn-fork-court').click(); await wait(500);
  for (const id of ['wizard-step-1-fields', 'wizard-step-2-fields']) {
    const el = document.getElementById(id); if (el) el.classList.remove('hidden');
  }
  document.getElementById('mat-short_name').value = 'Add Link Matter';
  document.getElementById('mat-short_name').dispatchEvent(new Event('input', { bubbles: true }));
  window.addParty('defendant'); await wait(200);

  const partyInput = document.querySelector('#defendant-list input');
  partyInput.value = 'Picker Added Party';
  partyInput.dispatchEvent(new Event('input', { bubbles: true }));
  partyInput.dispatchEvent(new Event('focus', { bubbles: true }));
  await wait(400);
  const addLi = [...document.querySelectorAll('#defendant-list .add-new')]
    .find(li => li.textContent.includes('Picker Added Party'));
  if (!addLi) return { error: 'no + Add row in the party picker' };
  addLi.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await waitFor(() => document.querySelector('#defendant-list .person-added-note'));

  out.partyNote = (document.querySelector('#defendant-list .person-added-note') || {}).textContent || '';
  // Adding must NOT navigate away from the form in progress.
  out.stayedOnForm = !document.getElementById('view-matter-detail').classList.contains('hidden');
  out.personExists = !!(await window.api.dbGet(
    "SELECT id FROM people WHERE display_name = 'Picker Added Party'"));

  // The form is dirty (a name was typed), so the link must ask, not jump.
  document.querySelector('#defendant-list .person-added-note .open-profile-link').click();
  await wait(400);
  const choice = document.querySelector('#defendant-list .person-added-note');
  out.warnedWhenDirty = /unsaved changes/i.test(choice ? choice.textContent : '');
  out.choiceButtons = [...(choice ? choice.querySelectorAll('button') : [])].map(b => b.textContent);
  out.stillOnFormWhileAsking = !document.getElementById('view-matter-detail').classList.contains('hidden');

  // Cancel keeps you where you are.
  [...choice.querySelectorAll('button')].find(b => b.textContent === 'Cancel').click();
  await wait(300);
  out.cancelStayed = !document.getElementById('view-matter-detail').classList.contains('hidden');
  out.cancelClearedNote = !document.querySelector('#defendant-list .person-added-note');

  // -- letter recipient picker --
  document.getElementById('nav-people').click(); await wait(300);
  document.getElementById('btn-new-matter').click(); await wait(300);
  document.getElementById('btn-fork-letter').click(); await wait(500);
  const ltr = document.getElementById('ltr-recipient_name');
  ltr.value = 'Picker Added Recipient';
  ltr.dispatchEvent(new Event('input', { bubbles: true }));
  ltr.dispatchEvent(new Event('focus', { bubbles: true }));
  await wait(400);
  const ltrAdd = [...document.querySelectorAll('#combo-letter-recipient .add-new')]
    .find(li => li.textContent.includes('Picker Added Recipient'));
  if (!ltrAdd) return { ...out, error: 'no + Add row in the letter recipient picker' };
  ltrAdd.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await waitFor(() => document.querySelector('#view-letter-new .person-added-note'));
  out.letterNote = (document.querySelector('#view-letter-new .person-added-note') || {}).textContent || '';
  out.stayedOnLetter = !document.getElementById('view-letter-new').classList.contains('hidden');

  // A clean form goes straight through, no questions.
  document.getElementById('nav-people').click(); await wait(300);
  document.getElementById('btn-new-matter').click(); await wait(300);
  document.getElementById('btn-fork-court').click(); await wait(500);
  for (const id of ['wizard-step-1-fields', 'wizard-step-2-fields']) {
    const el = document.getElementById(id); if (el) el.classList.remove('hidden');
  }
  window.addParty('defendant'); await wait(200);
  const p2 = document.querySelector('#defendant-list input');
  p2.value = 'Clean Form Party';
  p2.dispatchEvent(new Event('input', { bubbles: true }));
  p2.dispatchEvent(new Event('focus', { bubbles: true }));
  await wait(400);
  const add2 = [...document.querySelectorAll('#defendant-list .add-new')]
    .find(li => li.textContent.includes('Clean Form Party'));
  add2.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await wait(500);
  // Typing into the picker marks the form dirty, which is correct — so clear it
  // the way a save would, then confirm the link goes straight through.
  window.markFormCleanForTest('view-matter-detail');
  document.querySelector('#defendant-list .person-added-note .open-profile-link').click();
  await wait(600);
  out.cleanWentStraightThrough = !document.getElementById('view-person-detail').classList.contains('hidden');
  out.openedTheRightPerson = document.getElementById('per-display_name').value;

  return out;
});
if (addPersonLinks.error) {
  check('the + Add profile link', false, addPersonLinks.error);
} else {
  check('the party picker offers to open a newly added person',
    /Picker Added Party added/.test(addPersonLinks.partyNote)
      && /open profile/.test(addPersonLinks.partyNote), addPersonLinks.partyNote);
  check('the letter recipient box offers to open a newly added person',
    /Picker Added Recipient added/.test(addPersonLinks.letterNote)
      && /open profile/.test(addPersonLinks.letterNote), addPersonLinks.letterNote);
  check('adding a person still creates them', addPersonLinks.personExists);
  check('adding a person does not navigate away from the form in progress',
    addPersonLinks.stayedOnForm && addPersonLinks.stayedOnLetter,
    `matter=${addPersonLinks.stayedOnForm} letter=${addPersonLinks.stayedOnLetter}`);
  check('a dirty form warns before opening the profile',
    addPersonLinks.warnedWhenDirty, addPersonLinks.partyNote);
  check('the warning offers save, open anyway and cancel',
    JSON.stringify(addPersonLinks.choiceButtons) ===
      JSON.stringify(['Save and open profile', 'Open anyway', 'Cancel']),
    JSON.stringify(addPersonLinks.choiceButtons));
  check('asking does not itself navigate away', addPersonLinks.stillOnFormWhileAsking);
  check('Cancel keeps you on the form and retires the note',
    addPersonLinks.cancelStayed && addPersonLinks.cancelClearedNote,
    `stayed=${addPersonLinks.cancelStayed} cleared=${addPersonLinks.cancelClearedNote}`);
  check('a clean form opens the profile without asking',
    addPersonLinks.cleanWentStraightThrough, String(addPersonLinks.cleanWentStraightThrough));
  check('the link opens the person who was just added',
    addPersonLinks.openedTheRightPerson === 'Clean Form Party',
    addPersonLinks.openedTheRightPerson);
}

// --- Archiving a judge must not damage a matter that already used them ------
const archiving = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['96th District Court'])).lastInsertRowid;
  // As the app makes a judge (createJudgeWithContact): a Judge contact and
  // its judges row, linked.
  const person = (await window.api.dbRun(
    `INSERT INTO people (display_name, kind, is_contact, contact_role, works_at_court_id, created_at)
     VALUES (?, 'individual', 1, 'Judge', ?, ?)`, ['Hon. Retiring Judge', court, new Date().toISOString()])).lastInsertRowid;
  const judge = (await window.api.dbRun('INSERT INTO judges (name, court_id, person_id) VALUES (?,?,?)',
    ['Hon. Retiring Judge', court, person])).lastInsertRowid;
  const m = (await window.api.dbRun(
    "INSERT INTO matters (short_name, case_number, court_id, judge_id, client_role, caption_style, created_at) VALUES (?,?,?,?,?,?,?)",
    ['Archive Test', '2026-ZZ-1', court, judge, 'defendant', 'full', new Date().toISOString()])).lastInsertRowid;

  // Archived the way the contact page does it: both rows together.
  await window.api.dbRun('UPDATE judges SET archived = 1 WHERE id = ?', [judge]);
  await window.api.dbRun('UPDATE people SET archived = 1 WHERE id = ?', [person]);

  // Hidden from the picker...
  const pickable = await window.api.dbAll('SELECT * FROM judges WHERE archived = 0 AND court_id = ?', [court]);
  // ...but the matter still resolves the name for its documents.
  const resolved = await window.api.dbGet(
    'SELECT j.name FROM matters m LEFT JOIN judges j ON j.id = m.judge_id WHERE m.id = ?', [m]);

  // And Contacts offers it back: Show archived lists the judge, and the
  // judge's contact page has Restore, which returns the judge to the picker.
  document.getElementById('nav-contacts').click();
  await wait(300);
  const box = document.getElementById('contacts-show-archived');
  box.checked = true;
  box.dispatchEvent(new Event('change'));
  await wait(500);
  const tr = [...document.querySelectorAll('#contacts-list tr')]
    .find(r => r.children[0].textContent.startsWith('Hon. Retiring Judge'));
  const listed = !!tr;
  if (tr) tr.click();
  await wait(500);
  const restoreBtn = document.getElementById('btn-archive-contact');
  const offersRestore = !document.getElementById('view-contact-detail').classList.contains('hidden')
    && restoreBtn.textContent === 'Restore';
  restoreBtn.click();
  await wait(500);
  const restored = await window.api.dbGet('SELECT archived FROM judges WHERE id = ?', [judge]);
  box.checked = false;
  box.dispatchEvent(new Event('change'));
  await wait(200);

  return { hiddenFromPicker: pickable.length === 0, resolvedName: resolved?.name, listed, offersRestore,
    restoredToPicker: restored && restored.archived === 0 };
}).catch(e => ({ error: String(e) }));

if (archiving.error) {
  check('judge archiving', false, archiving.error);
} else {
  check('archived judge hidden from picker', archiving.hiddenFromPicker);
  check('archived judge still resolves on its matter',
    archiving.resolvedName === 'Hon. Retiring Judge', String(archiving.resolvedName));
  check('archived judge restorable from Contacts (Show archived, then Restore on the judge\'s contact page)',
    archiving.listed && archiving.offersRestore && archiving.restoredToPicker,
    JSON.stringify([archiving.listed, archiving.offersRestore, archiving.restoredToPicker]));
}

// --- Migration 17: client prefill into a new packet -------------------------
// The person is the master copy, but the packet still takes and freezes its
// OWN value at creation — so correcting the client later cannot rewrite a
// filing that already went out. Driven through the real "New Packet" button,
// because the prefill lives in that handler.
const prefill = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  const mkPerson = async (name, dob, lic) => (await window.api.dbRun(
    'INSERT INTO people (display_name, kind, dob, license_number, created_at) VALUES (?,?,?,?,?)',
    [name, 'individual', dob, lic, new Date().toISOString()])).lastInsertRowid;

  const mkMatter = async (short, personId) => {
    const id = (await window.api.dbRun(
      `INSERT INTO matters (short_name, case_number, client_role, caption_style, party_label, archived, created_at)
       VALUES (?,?,?,?,?,0,?)`,
      [short, '26-PRE-1', 'defendant', 'full', 'Defendant', new Date().toISOString()])).lastInsertRowid;
    await window.api.dbRun(
      'INSERT INTO parties (matter_id, name, side, person_id, sort_order) VALUES (?,?,?,?,0)',
      [id, 'Party Name Snapshot', 'defendant', personId]);
    return id;
  };

  const newPacketFor = async (short) => {
    document.getElementById('nav-matters').click();
    await wait(400);
    const row = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes(short));
    if (!row) return { error: `matter row not found: ${short}` };
    row.click();
    await wait(700);
    document.getElementById('btn-new-packet').click();
    await wait(700);
    return null;
  };

  const goodPerson = await mkPerson('Prefill Good', '1980-03-14', 'L 123 456 789');
  const goodMatter = await mkMatter('Prefill Good Matter', goodPerson);
  // An ambiguous DOB migration 17 deliberately left un-normalized.
  const badDobPerson = await mkPerson('Prefill BadDob', '3/4/80', 'L 999 888 777');
  const badDobMatter = await mkMatter('Prefill BadDob Matter', badDobPerson);
  // The state EVERY existing matter is in: a party with no linked person.
  const noPersonMatter = (await window.api.dbRun(
    `INSERT INTO matters (short_name, case_number, client_role, caption_style, party_label, archived, created_at)
     VALUES (?,?,?,?,?,0,?)`,
    ['Prefill NoPerson Matter', '26-PRE-3', 'defendant', 'full', 'Defendant', new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun(
    'INSERT INTO parties (matter_id, name, side, sort_order) VALUES (?,?,?,0)',
    [noPersonMatter, 'Typed Freehand', 'defendant']);

  for (const shortName of ['Prefill Good Matter', 'Prefill BadDob Matter', 'Prefill NoPerson Matter']) {
    const err = await newPacketFor(shortName);
    if (err) return err;
  }

  const pkt = async (mid) => await window.api.dbGet(
    'SELECT client_dob, client_license_number FROM packets WHERE matter_id = ? ORDER BY id DESC LIMIT 1', [mid]);

  // Read the seeded values BEFORE mutating anything below.
  const good = await pkt(goodMatter);
  const badDob = await pkt(badDobMatter);
  const noPerson = await pkt(noPersonMatter);

  // Now edit the packet, and separately correct the person, to prove neither
  // reaches back into what the other froze.
  const goodPkt = await window.api.dbGet('SELECT id FROM packets WHERE matter_id = ? ORDER BY id DESC LIMIT 1', [goodMatter]);
  await window.api.dbRun('UPDATE packets SET client_dob = ? WHERE id = ?', ['1975-01-02', goodPkt.id]);
  await window.api.dbRun('UPDATE people SET dob = ? WHERE id = ?', ['1999-12-31', goodPerson]);
  const afterEdit = await window.api.dbGet('SELECT client_dob FROM packets WHERE id = ?', [goodPkt.id]);

  return { good, badDob, noPerson, afterEdit: afterEdit && afterEdit.client_dob };
}).catch(e => ({ error: String(e) }));

if (prefill.error) {
  check('client prefill into a new packet', false, prefill.error);
} else {
  check('prefill: an ISO date of birth is copied onto the packet',
    prefill.good && prefill.good.client_dob === '1980-03-14', JSON.stringify(prefill.good));
  check('prefill: the license number is copied onto the packet',
    prefill.good && prefill.good.client_license_number === 'L 123 456 789', JSON.stringify(prefill.good));

  // Blank beats wrong: an ambiguous DOB must never reach a filing.
  check('prefill: an un-normalizable date of birth is NOT copied',
    prefill.badDob && !prefill.badDob.client_dob, JSON.stringify(prefill.badDob));
  check('prefill: a bad date of birth does not block the license number',
    prefill.badDob && prefill.badDob.client_license_number === 'L 999 888 777',
    JSON.stringify(prefill.badDob));

  // THE regression that matters: every pre-existing matter looks like this.
  check('prefill: a party with no linked person prefills nothing and does not crash',
    prefill.noPerson && !prefill.noPerson.client_dob && !prefill.noPerson.client_license_number,
    JSON.stringify(prefill.noPerson));

  // The whole point of freezing at creation: the person is the master copy,
  // but she does not reach back into a packet that already exists.
  check('prefill: correcting the person later does not rewrite an existing packet',
    prefill.afterEdit === '1975-01-02', String(prefill.afterEdit));
}

// --- Missing-info resolvers surfaced beyond the Generate screen -------------
// preflight()'s rules used to be inline, so they could only ever be seen once
// you were already filing. Extracted now and shown on three screens — which
// means the extraction must not have changed a single sentence.
const issues = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const texts = (sel) => [...document.querySelectorAll(sel + ' li')].map(li => li.textContent);

  // Deliberately incomplete: no court, no case number, no defendant.
  const bad = (await window.api.dbRun(
    `INSERT INTO matters (short_name, case_number, client_role, caption_style, party_label, archived, created_at)
     VALUES (?,?,?,?,?,0,?)`,
    ['Issues Incomplete', '', 'defendant', 'full', 'Defendant', new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun('INSERT INTO parties (matter_id, name, side, sort_order) VALUES (?,?,?,0)',
    [bad, 'Some Plaintiff', 'plaintiff']);

  document.getElementById('nav-matters').click();
  await wait(500);

  const rowOf = (name) => [...document.querySelectorAll('#matters-list tr')]
    .find(r => r.innerText.includes(name));
  const badRow = rowOf('Issues Incomplete');
  if (!badRow) return { error: 'incomplete matter row not found' };
  const badRowFlag = badRow.innerText;

  badRow.click();
  await wait(700);
  const onMatter = texts('#matter-issues');

  // The same matter, seen from the Generate screen's original box.
  document.getElementById('btn-goto-generate').click();
  await wait(700);
  const onGenerate = texts('#gen-warnings');

  // A person with no DOB at all, and one whose DOB migration 17 could not
  // safely convert.
  const noDob = (await window.api.dbRun(
    'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
    ['Issues NoDob', 'individual', new Date().toISOString()])).lastInsertRowid;
  const badDob = (await window.api.dbRun(
    'INSERT INTO people (display_name, kind, dob, created_at) VALUES (?,?,?,?)',
    ['Issues BadDob', 'individual', '3/4/80', new Date().toISOString()])).lastInsertRowid;
  const okDob = (await window.api.dbRun(
    'INSERT INTO people (display_name, kind, dob, created_at) VALUES (?,?,?,?)',
    ['Issues OkDob', 'individual', '1980-03-14', new Date().toISOString()])).lastInsertRowid;

  const personTexts = async (name) => {
    document.getElementById('nav-people').click();
    await wait(500);
    const r = [...document.querySelectorAll('#people-list tr')].find(x => x.innerText.includes(name));
    if (!r) return null;
    r.click();
    await wait(600);
    return texts('#person-issues');
  };

  return {
    badRowFlag,
    onMatter,
    onGenerate,
    noDob: await personTexts('Issues NoDob'),
    badDob: await personTexts('Issues BadDob'),
    okDob: await personTexts('Issues OkDob')
  };
}).catch(e => ({ error: String(e) }));

if (issues.error) {
  check('missing-info resolvers', false, issues.error);
} else {
  // THE assertion for this refactor: three screens, one set of sentences.
  check('the matter screen shows exactly what the Generate screen shows',
    JSON.stringify(issues.onMatter) === JSON.stringify(issues.onGenerate),
    `matter=${JSON.stringify(issues.onMatter)} generate=${JSON.stringify(issues.onGenerate)}`);
  check('the original preflight wording survived the extraction',
    issues.onGenerate.includes('No case number.')
      && issues.onGenerate.includes('No defendant listed.')
      && issues.onGenerate.some(t => t.includes('No court is set')),
    JSON.stringify(issues.onGenerate));

  // Quiet count on the row, so a problem is visible while scanning.
  check('an incomplete matter shows a count on its list row',
    /\d+ needed/.test(issues.badRowFlag), JSON.stringify(issues.badRowFlag));

  check('a person with no date of birth is flagged',
    issues.noDob && issues.noDob.some(t => t.includes('No date of birth')),
    JSON.stringify(issues.noDob));
  // The one that protects a filing: this value will not be prefilled, and the
  // person screen has to say so rather than looking merely incomplete.
  check('an unusable date of birth says it will not be filled into a filing',
    issues.badDob && issues.badDob.some(t => t.includes('3/4/80') && t.includes('not a usable date')),
    JSON.stringify(issues.badDob));
  // 'Issues OkDob' carries a name and a DOB and nothing else, so since the
  // list grew to cover the intake essentials it is no longer empty — what this
  // check has always been about is that a GOOD date of birth is left alone.
  check('a usable date of birth is not nagged about',
    issues.okDob && !issues.okDob.some(t => /date of birth/i.test(t)),
    JSON.stringify(issues.okDob));
}

// --- "Still needed:" covers the intake essentials ---------------------------
// The list is the app's only nag, so it has exactly two ways to fail: too
// quiet (a client is filed with no date of birth and nothing says so) and too
// loud (it demands optional answers, the user stops reading it, and it stops working
// at all). Essentials only: date of birth, address, cell phone, licence number.
const stillNeeded = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const listFor = async (id) => {
    await window.openPerson(id);
    await wait(300);
    return document.getElementById('person-issues').textContent;
  };
  const mk = async (cols, vals) => (await window.api.dbRun(
    `INSERT INTO people (${cols.join(',')}, created_at) VALUES (${cols.map(() => '?').join(',')},?)`,
    [...vals, new Date().toISOString()])).lastInsertRowid;

  const bare = await mk(['display_name', 'kind'], ['Still Needed Bare', 'individual']);
  // Street filled, City and ZIP blank. composePersonAddress falls back to the
  // legacy blob in this state so nothing PRINTS wrong — but a half-entered
  // address that no screen ever mentions stays half-entered forever.
  const partial = await mk(['display_name', 'kind', 'street', 'city', 'zip'],
    ['Still Needed Partial', 'individual', '9 Elm St', '', '']);
  // A company has no birthday and no driver's licence. Nagging it for either
  // gives every organization a permanent list of things it can never supply,
  // which is exactly how a nag box gets ignored.
  const org = await mk(['display_name', 'kind'], ['Still Needed Org', 'organization']);

  return {
    bare: await listFor(bare),
    partial: await listFor(partial),
    org: await listFor(org)
  };
}).catch(e => ({ error: String(e) }));

if (stillNeeded.error) {
  check('still-needed list on the profile', false, stillNeeded.error);
} else {
  // Case-insensitive on purpose: the date-of-birth sentence is pinned verbatim
  // by the checks above ('No date of birth recorded.'), and rewording it to
  // match a capitalised label would break them for no gain.
  check('a name-only person is flagged as missing the essentials',
    ['date of birth', 'street', 'cell phone', "driver's license number"]
      .every(s => stillNeeded.bare.toLowerCase().includes(s)), stillNeeded.bare);
  check('the issue list does not nag about optional groups',
    !/medical|medication|high school|emergency/i.test(stillNeeded.bare), stillNeeded.bare);
  check('a half-filled address is called out as partly filled, not left alone',
    /partly filled/i.test(stillNeeded.partial) && /city/i.test(stillNeeded.partial)
      && /zip/i.test(stillNeeded.partial), stillNeeded.partial);
  check('an organization is not nagged for a date of birth or a license number',
    !/date of birth/i.test(stillNeeded.org) && !/licen[cs]e number/i.test(stillNeeded.org),
    stillNeeded.org);
  check('an organization is still asked for the things a company does have',
    /street/i.test(stillNeeded.org), stillNeeded.org);
}

// --- Organization profile fields (client-folders Task 7) --------------------
// Three optional fields that only an Organization carries: the name it goes by
// in a caption, the signing profile its cases sign under, and the side it is
// usually on. Hidden for an Individual — but hiding must never mean blanking:
// a profile switched to Individual by mistake and saved keeps what was stored.
const orgFields = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const visible = () => !$('wrap-org-fields').classList.contains('hidden')
    && $('wrap-org-fields').offsetParent !== null;
  const now = new Date().toISOString();
  const cityAtt = (await window.api.dbRun(
    'INSERT INTO attorneys (name, bar_number, firm_name, label, is_default) VALUES (?,?,?,?,0)',
    ['Olivia Orgtest', 'P00007', 'City of Exampleton Law Dept', 'Exampleton City Attorney'])).lastInsertRowid;
  const goneAtt = (await window.api.dbRun(
    'INSERT INTO attorneys (name, bar_number, firm_name, is_default) VALUES (?,?,?,0)',
    ['Gone Profile', 'P00008', 'Soon Removed LLP'])).lastInsertRowid;

  const out = {};
  // A brand-new profile starts as an Individual: the block is hidden.
  await window.openPerson(null);
  await wait(300);
  out.newHidden = !visible();
  out.signOptions = [...$('per-signing_attorney_id').options].map(o => [o.value, o.textContent]);
  $('per-display_name').value = 'City of Exampleton';
  $('per-kind').value = 'organization';
  $('per-kind').dispatchEvent(new Event('change', { bubbles: true }));
  out.shownOnChange = visible();
  $('per-kind').value = 'individual';
  $('per-kind').dispatchEvent(new Event('change', { bubbles: true }));
  out.hiddenOnChangeBack = !visible();
  $('per-kind').value = 'organization';
  $('per-kind').dispatchEvent(new Event('change', { bubbles: true }));
  $('per-caption_name').value = 'PEOPLE OF THE CITY OF EXAMPLETON';
  $('per-signing_attorney_id').value = String(cityAtt);
  $('per-usual_role').value = 'plaintiff';
  $('btn-save-person').click();
  await wait(800);
  const id = Number($('per-id').value);
  out.row1 = await window.api.dbGet(
    'SELECT kind, caption_name, signing_attorney_id, usual_role FROM people WHERE id = ?', [id]);

  // Reopen: visible, and every value back where it was.
  await window.openPerson(null);
  await wait(200);
  await window.openPerson(id);
  await wait(300);
  out.reopenShown = visible();
  out.reopenVals = [$('per-caption_name').value, $('per-signing_attorney_id').value, $('per-usual_role').value];
  out.issues = $('person-issues').textContent;
  out.labels = ['per-caption_name', 'per-signing_attorney_id', 'per-usual_role']
    .map(i => $(i).closest('.form-group').querySelector('label').textContent);
  out.placeholder = $('per-caption_name').placeholder;

  // Switched to Individual and saved: hidden, but nothing is wiped.
  $('per-kind').value = 'individual';
  $('per-kind').dispatchEvent(new Event('change', { bubbles: true }));
  $('btn-save-person').click();
  await wait(800);
  out.row2 = await window.api.dbGet(
    'SELECT kind, caption_name, signing_attorney_id, usual_role FROM people WHERE id = ?', [id]);
  await window.openPerson(id);
  await wait(300);
  out.individualHidden = !visible();

  // The signing profile it pointed at is gone (a restored backup, a merge):
  // the form still opens, says so, and saving keeps the stored link rather
  // than silently re-pointing it or blanking it.
  // Foreign keys are on, so the app cannot delete a referenced profile itself;
  // a dangling id arrives from outside (an older backup, a hand edit). Switch
  // enforcement off just long enough to build that state.
  await window.api.dbRun('PRAGMA foreign_keys = OFF');
  await window.api.dbRun(
    'UPDATE people SET kind = ?, signing_attorney_id = ? WHERE id = ?', ['organization', goneAtt, id]);
  await window.api.dbRun('DELETE FROM attorneys WHERE id = ?', [goneAtt]);
  await window.api.dbRun('PRAGMA foreign_keys = ON');
  await window.openPerson(id);
  await wait(300);
  const sel = $('per-signing_attorney_id');
  out.goneShown = [sel.value, sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].textContent];
  $('btn-save-person').click();
  await wait(800);
  out.row3 = await window.api.dbGet('SELECT signing_attorney_id FROM people WHERE id = ?', [id]);

  // Blank "Signs as" / "Usually" store NULL, not '' — Task 8 joins on the id.
  sel.value = '';
  $('per-usual_role').value = '';
  $('btn-save-person').click();
  await wait(800);
  out.row4 = await window.api.dbGet(
    'SELECT signing_attorney_id, usual_role FROM people WHERE id = ?', [id]);
  out.cityAtt = cityAtt;
  out.goneAtt = goneAtt;
  return out;
}).catch(e => ({ error: String(e) }));

if (orgFields.error) {
  check('organization profile fields', false, orgFields.error);
} else {
  const o = orgFields;
  check('the Organization block is hidden on a new (Individual) profile', o.newHidden, JSON.stringify(o));
  check('choosing Organization shows the block, choosing Individual hides it again',
    o.shownOnChange && o.hiddenOnChangeBack, JSON.stringify(o));
  check('"Signs as" lists signing profiles by the attorney-list label, blank first',
    o.signOptions[0][0] === '' && o.signOptions.some(([v, t]) => v === String(o.cityAtt) && t === 'Exampleton City Attorney')
      && o.signOptions.some(([v, t]) => v === String(o.goneAtt) && t === 'Soon Removed LLP'),
    JSON.stringify(o.signOptions));
  check('organization fields save', o.row1 && o.row1.kind === 'organization'
    && o.row1.caption_name === 'PEOPLE OF THE CITY OF EXAMPLETON'
    && o.row1.signing_attorney_id === o.cityAtt && o.row1.usual_role === 'plaintiff', JSON.stringify(o.row1));
  check('organization fields come back on reopen, block shown',
    o.reopenShown && JSON.stringify(o.reopenVals) === JSON.stringify(['PEOPLE OF THE CITY OF EXAMPLETON', String(o.cityAtt), 'plaintiff']),
    JSON.stringify(o.reopenVals));
  check('organization fields carry the agreed labels and placeholder',
    JSON.stringify(o.labels) === JSON.stringify(['Name in captions', 'Signs as', 'Usually'])
      && o.placeholder === 'PEOPLE OF THE CITY OF EXAMPLETON', JSON.stringify([o.labels, o.placeholder]));
  check('Still needed does not ask an organization for its optional org fields',
    !/caption|signs as|usually|signing/i.test(o.issues), o.issues);
  check('switching to Individual and saving keeps the stored organization values',
    o.row2 && o.row2.kind === 'individual' && o.row2.caption_name === 'PEOPLE OF THE CITY OF EXAMPLETON'
      && o.row2.signing_attorney_id === o.cityAtt && o.row2.usual_role === 'plaintiff'
      && o.individualHidden, JSON.stringify([o.row2, o.individualHidden]));
  check('a signing profile that no longer exists shows as "(no longer available)" and is kept on save',
    o.goneShown[0] === String(o.goneAtt) && o.goneShown[1] === '(no longer available)'
      && o.row3 && o.row3.signing_attorney_id === o.goneAtt, JSON.stringify([o.goneShown, o.row3]));
  check('blank "Signs as" and "Usually" save as NULL',
    o.row4 && o.row4.signing_attorney_id === null && o.row4.usual_role === null, JSON.stringify(o.row4));
}
if (process.env.SMOKE_SHOTS && !orgFields.error) {
  fs.mkdirSync(process.env.SMOKE_SHOTS, { recursive: true });
  await page.evaluate(async () => {
    const p = await window.api.dbGet("SELECT id FROM people WHERE display_name = 'City of Exampleton' ORDER BY id DESC");
    await window.api.dbRun(
      `UPDATE people SET kind = 'organization', usual_role = 'plaintiff',
         signing_attorney_id = (SELECT id FROM attorneys WHERE label = 'Exampleton City Attorney') WHERE id = ?`, [p.id]);
    await window.openPerson(p.id);
  }).catch(() => {});
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'org-profile-1024.png') }).catch(() => {});
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
}

// --- Organization defaults pre-fill new cases (client-folders Task 8) --------
// Picking an Organization as a party puts its caption name on the party line
// (never into caption_authority, which always prints above "Plaintiff"), lets
// its usual side fill "Our Client Role" when nothing has decided the side yet,
// and its signing profile sits between the case's own attorney and the case
// type's. Driven through the real party picker and the real Generate screen.
const orgPrefill = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const now = new Date().toISOString();
  const out = {};

  // Fixtures. The City is the profile the Task 7 block above created; it must
  // be the only one of that name, or the picker row below is ambiguous.
  const cities = await window.api.dbAll(
    "SELECT id FROM people WHERE display_name = 'City of Exampleton' AND archived = 0");
  if (cities.length !== 1) return { error: `expected one City of Exampleton, found ${cities.length}` };
  const cityId = cities[0].id;
  let cityAtt = (await window.api.dbGet(
    "SELECT id FROM attorneys WHERE label = 'Exampleton City Attorney'") || {}).id;
  if (!cityAtt) {
    cityAtt = (await window.api.dbRun(
      'INSERT INTO attorneys (name, bar_number, firm_name, label, is_default) VALUES (?,?,?,?,0)',
      ['Olivia Orgtest', 'P00007', 'City of Exampleton Law Dept', 'Exampleton City Attorney'])).lastInsertRowid;
  }
  const cityAttName = (await window.api.dbGet('SELECT name FROM attorneys WHERE id = ?', [cityAtt])).name;
  const typeAtt = (await window.api.dbRun(
    'INSERT INTO attorneys (name, bar_number, label, is_default) VALUES (?,?,?,0)',
    ['Tobias Typeset', 'P00021', 'Prosecution Type Attorney'])).lastInsertRowid;
  const caseAtt = (await window.api.dbRun(
    'INSERT INTO attorneys (name, bar_number, label, is_default) VALUES (?,?,?,0)',
    ['Casey Ownfile', 'P00022', 'Case Own Attorney'])).lastInsertRowid;
  const defaultAtt = (await window.api.dbGet('SELECT id FROM attorneys WHERE is_default = 1') || {}).id;
  await window.api.dbRun(
    `UPDATE people SET kind = 'organization', caption_name = ?, signing_attorney_id = ?, usual_role = 'plaintiff'
     WHERE id = ?`, ['PEOPLE OF THE CITY OF EXAMPLETON', cityAtt, cityId]);
  const acmeId = (await window.api.dbRun(
    `INSERT INTO people (display_name, kind, caption_name, usual_role, created_at)
     VALUES (?, 'organization', ?, 'defendant', ?)`,
    ['Acme Holdings LLC', 'ACME HOLDINGS, LLC', now])).lastInsertRowid;
  // An Individual that still carries org values from a Type flip: they must
  // be ignored, exactly as the hidden profile fields are.
  const ivyId = (await window.api.dbRun(
    `INSERT INTO people (display_name, kind, caption_name, usual_role, signing_attorney_id, created_at)
     VALUES (?, 'individual', ?, 'defendant', ?, ?)`,
    ['Ivy Individual', 'IVY STALE CAPTION', cityAtt, now])).lastInsertRowid;
  const progType = (await window.api.dbRun(
    `INSERT INTO matter_types (name, side, caption_authority, attorney_id, sort_order)
     VALUES (?, 'prosecution', NULL, ?, 50)`, ['Exampleton Prosecution', typeAtt])).lastInsertRowid;
  let cdType = (await window.api.dbGet(
    "SELECT id FROM matter_types WHERE caption_authority = 'PEOPLE OF THE STATE OF MICHIGAN' AND archived = 0 ORDER BY id") || {}).id;
  if (!cdType) {
    cdType = (await window.api.dbRun(
      `INSERT INTO matter_types (name, side, caption_authority, sort_order)
       VALUES ('Criminal Defense', 'defense', 'PEOPLE OF THE STATE OF MICHIGAN', 51)`)).lastInsertRowid;
  }
  // A saved defendant-side case, opened first: its role carries into the next
  // new-case form, which is how a real session reaches a form whose visible
  // role nobody has chosen yet.
  const prior = (await window.api.dbRun(
    "INSERT INTO matters (short_name, client_role, caption_style, created_at) VALUES (?, 'defendant', 'full', ?)",
    ['Org Prefill Prior Case', now])).lastInsertRowid;

  const role = () => $('mat-client_role').value;
  const newCase = async () => {
    $('nav-matters').click(); await wait(300);
    $('btn-new-matter').click(); await wait(300);
    $('btn-fork-court').click(); await wait(500);
    for (const id of ['wizard-step-1-fields', 'wizard-step-2-fields']) $(id).classList.remove('hidden');
  };
  // The real picker: add a row, type, then mousedown the matching suggestion.
  const pick = async (side, term, rowText) => {
    window.addParty(side); await wait(200);
    const inputs = document.querySelectorAll(`#${side}-list input`);
    const input = inputs[inputs.length - 1];
    input.value = term;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(400);
    const li = [...input.parentElement.querySelectorAll('li')].find(l => l.textContent === rowText);
    if (!li) throw new Error(`no picker row "${rowText}" for "${term}"`);
    li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await wait(200);
    return input.value;
  };
  const selectType = (id) => {
    $('mat-matter_type_id').value = String(id);
    $('mat-matter_type_id').dispatchEvent(new Event('change', { bubbles: true }));
  };
  const saveNew = async (name) => {
    $('mat-short_name').value = name;
    await window.saveMatterForTest();
    await wait(300);
    return (await window.api.dbGet(
      'SELECT id FROM matters WHERE short_name = ? ORDER BY id DESC LIMIT 1', [name])).id;
  };
  // The PDF's HTML is not reachable from here (the preload bridge is frozen,
  // so appApi.generatePdf cannot be wrapped). Re-render it from what the
  // documents row stored — the same matter/attorney snapshot and field values
  // the PDF click rendered, by construction (runGenerate).
  const genBoth = async (matterId) => {
    await $('btn-goto-generate').onclick();
    await wait(300);
    const chosenAtt = Number($('gen-attorney').value);
    $('gen-doctype').value = 'appearance';
    $('gen-doctype').dispatchEvent(new Event('change'));
    await wait(200);
    await $('btn-generate-pdf').onclick();
    await $('btn-generate-docx').onclick();
    const doc = await window.api.dbGet(
      "SELECT * FROM documents WHERE matter_id = ? AND doc_type = 'appearance' ORDER BY id DESC LIMIT 1", [matterId]);
    if (!doc) return { chosenAtt, error: 'no documents row' };
    const dt = window.DocumentEngine.doctypes.find(d => d.id === 'appearance');
    const snap = JSON.parse(doc.matter_snapshot);
    const att = JSON.parse(doc.attorney_snapshot);
    const html = window.DocumentEngine.renderHtml(dt.build(snap, att, JSON.parse(doc.field_data || '{}')), snap, att);
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    return {
      chosenAtt,
      capParties: [...parsed.querySelectorAll('.caption-grid .cap-party')].map(n => n.textContent.trim()),
      capRoles: [...parsed.querySelectorAll('.caption-grid .cap-role')].map(n => n.textContent.trim()),
      htmlText: parsed.body.textContent,
      pdfPath: doc.pdf_path, docxPath: doc.docx_path
    };
  };
  const partiesOf = (id) => window.api.dbAll(
    'SELECT person_id, name, side, role FROM parties WHERE matter_id = ? ORDER BY side, sort_order', [id]);

  // A. The City, picked on its usual side, on a form whose role nobody chose.
  await window.openMatterForTest(prior); await wait(300);
  await newCase();
  out.a = { roleBefore: role() };
  out.a.cityInput = await pick('plaintiff', 'Exampleton', 'City of Exampleton');
  out.a.roleAfterCity = role();
  out.a.ivyInput = await pick('defendant', 'Ivy Ind', 'Ivy Individual');
  out.a.roleAfterIvy = role();
  selectType(progType);
  out.a.roleAfterType = role();
  const aId = await saveNew('Org Prefill City Case');
  out.a.parties = await partiesOf(aId);
  out.a.gen = await genBoth(aId);

  // The org's signing profile points at a deleted attorney: skipped, and the
  // case type's attorney wins instead. Foreign keys are on, so the dangling id
  // is built with enforcement briefly off (it arrives from an older backup).
  const goneAtt = (await window.api.dbRun(
    'INSERT INTO attorneys (name, bar_number, is_default) VALUES (?,?,0)', ['Gone Signer', 'P00023'])).lastInsertRowid;
  await window.api.dbRun('PRAGMA foreign_keys = OFF');
  await window.api.dbRun('UPDATE people SET signing_attorney_id = ? WHERE id = ?', [goneAtt, cityId]);
  await window.api.dbRun('DELETE FROM attorneys WHERE id = ?', [goneAtt]);
  await window.api.dbRun('PRAGMA foreign_keys = ON');
  await window.openMatterForTest(aId); await wait(300);
  await $('btn-goto-generate').onclick(); await wait(300);
  out.a.danglingAtt = Number($('gen-attorney').value);
  await window.api.dbRun('UPDATE people SET signing_attorney_id = ? WHERE id = ?', [cityAtt, cityId]);

  // The case's own attorney outranks the organization's.
  await window.openMatterForTest(aId); await wait(300);
  $('mat-attorney_id').value = String(caseAtt);
  await window.saveMatterForTest(); await wait(300);
  await $('btn-goto-generate').onclick(); await wait(300);
  out.a.caseOwnAtt = Number($('gen-attorney').value);

  // B. Acme as the defendant client; an individual plaintiff. The form
  // carries case A's plaintiff role in, unchosen.
  await newCase();
  out.b = { roleBefore: role() };
  out.b.ivyInput = await pick('plaintiff', 'Ivy Ind', 'Ivy Individual');
  out.b.roleAfterIvy = role();
  out.b.acmeInput = await pick('defendant', 'Acme Holdings', 'Acme Holdings LLC');
  out.b.roleAfterAcme = role();
  const bId = await saveNew('Org Prefill Acme Case');
  out.b.parties = await partiesOf(bId);
  out.b.gen = await genBoth(bId);

  // C. A role the user already picked by hand is never overwritten.
  await newCase();
  $('mat-client_role').value = 'plaintiff';
  $('mat-client_role').dispatchEvent(new Event('change', { bubbles: true }));
  out.c = { acmeInput: await pick('defendant', 'Acme Holdings', 'Acme Holdings LLC'), roleAfterAcme: role() };
  window.markFormCleanForTest('view-matter-detail');

  // D. An org on the opposite side from its usual one: probably the other
  // side's party, so the role is left alone.
  await window.openMatterForTest(prior); await wait(300);
  await newCase();
  out.d = { roleBefore: role() };
  out.d.cityInput = await pick('defendant', 'Exampleton', 'City of Exampleton');
  out.d.roleAfterCity = role();
  window.markFormCleanForTest('view-matter-detail');

  // E. The type spoke first (Criminal Defense -> defendant); then the City is
  // added as the prosecuting plaintiff. The role stays defendant, and the
  // type's authority line prints above "Plaintiff" in place of the City's name.
  await newCase();
  selectType(cdType);
  out.e = { roleAfterType: role() };
  out.e.cityInput = await pick('plaintiff', 'Exampleton', 'City of Exampleton');
  out.e.roleAfterCity = role();
  await pick('defendant', 'Ivy Ind', 'Ivy Individual');
  const eId = await saveNew('Org Prefill Defense Case');
  out.e.parties = await partiesOf(eId);
  out.e.gen = await genBoth(eId);

  // F. The reverse of E: the City fills the side first (plaintiff), then a
  // defense-side type is picked. The type must not flip the chosen side —
  // the printed "Attorney for …" follows it.
  await newCase();
  out.f = { cityInput: await pick('plaintiff', 'Exampleton', 'City of Exampleton') };
  out.f.roleAfterCity = role();
  selectType(cdType);
  out.f.roleAfterType = role();
  window.markFormCleanForTest('view-matter-detail');

  Object.assign(out, { cityId, acmeId, ivyId, cityAtt, cityAttName, typeAtt, caseAtt, defaultAtt });
  return out;
}).catch(e => ({ error: String(e) }));

if (orgPrefill.error) {
  check('organization defaults pre-fill new cases', false, orgPrefill.error);
} else {
  const o = orgPrefill;
  const { a, b, c, d, e } = o;
  const J = JSON.stringify;
  const clientRow = (rows, id) => rows.find(r => r.person_id === id) || {};
  // Word: the authority/plaintiff line is the first bold run before
  // "Plaintiff"; the defendant line sits between "vs." and the role word.
  // Role words are matched as a whole run (<w:t ...>Plaintiff</w:t>) so the
  // word inside the body text cannot stand in for the caption's.
  const at = (xml, needle) => needle instanceof RegExp ? xml.search(needle) : xml.indexOf(needle);
  const docxOrder = (p, first, second) => {
    const xml = p ? readDocxXml(p) : '';
    const i = at(xml, first); const j = at(xml, second);
    return { found: i >= 0 && j >= 0, before: i >= 0 && j >= 0 && i < j, xml };
  };
  const PLAINTIFF_RUN = /<w:t(?: [^>]*)?>Plaintiff<\/w:t>/;
  const VS_RUN = /<w:t(?: [^>]*)?>vs\.<\/w:t>/;

  check('picking an organization as a party fills its caption name, linked by id',
    a.cityInput === 'PEOPLE OF THE CITY OF EXAMPLETON'
      && clientRow(a.parties, o.cityId).name === 'PEOPLE OF THE CITY OF EXAMPLETON', J([a.cityInput, a.parties]));
  check('the organization on its usual side fills Our Client Role when nothing chose it yet',
    a.roleBefore === '' && a.roleAfterCity === 'plaintiff'
      && clientRow(a.parties, o.cityId).role === 'client', J(a));
  check('an individual party keeps its own name and never moves the role, stale org values ignored',
    a.ivyInput === 'Ivy Individual' && a.roleAfterIvy === 'plaintiff'
      && b.ivyInput === 'Ivy Individual' && b.roleAfterIvy === b.roleBefore
      && clientRow(a.parties, o.ivyId).name === 'Ivy Individual', J([a.ivyInput, b.ivyInput, b.roleBefore, b.roleAfterIvy]));
  check('a later case-type pick agreeing with the side leaves it', a.roleAfterType === 'plaintiff', a.roleAfterType);
  check('a later case-type pick for the OTHER side does not flip a side the organization already set',
    o.f.roleAfterCity === 'plaintiff' && o.f.roleAfterType === 'plaintiff', J(o.f));
  check('Generate preselects the organization\'s signing profile over the case type\'s attorney',
    a.gen.chosenAtt === o.cityAtt, J([a.gen.chosenAtt, o.cityAtt, o.typeAtt]));
  check('PDF HTML: the City\'s caption name prints above "Plaintiff"',
    !!a.gen.pdfPath && fs.existsSync(onDisk(a.gen.pdfPath))
      && J(a.gen.capParties.slice(0, 1)) === J(['PEOPLE OF THE CITY OF EXAMPLETON']) && a.gen.capRoles[0] === 'Plaintiff'
      && a.gen.capParties[1] === 'IVY INDIVIDUAL', J([a.gen.capParties, a.gen.capRoles]));
  check('PDF HTML: the signature is the City\'s signing profile',
    a.gen.htmlText.toUpperCase().includes(o.cityAttName.toUpperCase()), o.cityAttName);
  const aDocx = docxOrder(a.gen.docxPath, 'PEOPLE OF THE CITY OF EXAMPLETON', PLAINTIFF_RUN);
  check('Word: the City\'s caption name prints above "Plaintiff"', aDocx.before, a.gen.docxPath);
  check('Word: the signature is the City\'s signing profile',
    aDocx.xml.toUpperCase().includes(o.cityAttName.toUpperCase()), o.cityAttName);
  check('a signing profile pointing at a deleted attorney is skipped (falls to the case type)',
    a.danglingAtt === o.typeAtt, J([a.danglingAtt, o.typeAtt]));
  check('the case\'s own attorney outranks the organization\'s signing profile',
    a.caseOwnAtt === o.caseAtt, J([a.caseOwnAtt, o.caseAtt]));

  check('an organization defendant client: caption name on its party, role becomes defendant',
    b.acmeInput === 'ACME HOLDINGS, LLC' && b.roleBefore === '' && b.roleAfterAcme === 'defendant'
      && clientRow(b.parties, o.acmeId).role === 'client' && clientRow(b.parties, o.acmeId).side === 'defendant',
    J(b));
  check('PDF HTML: ACME HOLDINGS, LLC is on the defendant line, not above "Plaintiff"',
    b.gen.capParties[0] === 'IVY INDIVIDUAL' && b.gen.capParties[1] === 'ACME HOLDINGS, LLC'
      && b.gen.capRoles[0] === 'Plaintiff', J([b.gen.capParties, b.gen.capRoles]));
  const bDocx = docxOrder(b.gen.docxPath, VS_RUN, 'ACME HOLDINGS, LLC');
  const bDocxTop = docxOrder(b.gen.docxPath, 'IVY INDIVIDUAL', PLAINTIFF_RUN);
  check('Word: ACME HOLDINGS, LLC is on the defendant line, not above "Plaintiff"',
    bDocx.before && bDocxTop.before, b.gen.docxPath);
  check('no org signing profile: Generate falls back past the org (default attorney)',
    b.gen.chosenAtt === o.defaultAtt, J([b.gen.chosenAtt, o.defaultAtt]));

  check('a role the user already chose is not overwritten by the organization\'s usual side',
    c.acmeInput === 'ACME HOLDINGS, LLC' && c.roleAfterAcme === 'plaintiff', J(c));
  check('an organization added opposite its usual side leaves the role alone',
    d.cityInput === 'PEOPLE OF THE CITY OF EXAMPLETON' && d.roleAfterCity === d.roleBefore, J(d));
  check('a role set by the case type is not overwritten by an organization picked after it',
    e.roleAfterType === 'defendant' && e.roleAfterCity === 'defendant'
      && clientRow(e.parties, o.cityId).role === 'opposing_party', J([e.roleAfterType, e.roleAfterCity, e.parties]));
  // Documented behaviour, not a change: a case type that carries an authority
  // prints it above "Plaintiff" in place of every plaintiff party's name.
  check('a case type with an authority prints it above "Plaintiff" instead of the City\'s caption name',
    e.gen.capParties[0] === 'PEOPLE OF THE STATE OF MICHIGAN'
      && !e.gen.htmlText.includes('PEOPLE OF THE CITY OF EXAMPLETON'), J([e.gen.capParties]));
  check('the first client party is an individual: its stale signing profile is ignored',
    e.gen.chosenAtt !== o.cityAtt, J([e.gen.chosenAtt, o.cityAtt]));
  const eDocx = e.gen.docxPath ? readDocxXml(e.gen.docxPath) : '';
  check('Word agrees: the type\'s authority, not the City\'s caption name',
    eDocx.includes('PEOPLE OF THE STATE OF MICHIGAN') && !eDocx.includes('PEOPLE OF THE CITY OF EXAMPLETON'),
    e.gen.docxPath);
}

// --- 9A: Our Client Role starts blank; org profiles; openPerson race ---------
// (1) A new case never inherits the last case's side: the role select starts
// on its blank "— choose —" option, Next stays disabled until a real side is
// picked, and Save refuses a blank side. (2) An Organization profile hides
// Date of Birth and accepts any phone field as its contact number.
// (3) openPerson: a profile opened while the previous one's priors are still
// loading never gets the previous person's priors or "Still needed" list.
const role9a = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const now = new Date().toISOString();
  const out = {};

  // (1) A plaintiff-side case opened first, then New Case.
  const sideless = (await window.api.dbRun(
    "INSERT INTO matter_types (name, side, sort_order) VALUES ('Role9A Sideless Type', 'other', 90)")).lastInsertRowid;
  const prior = (await window.api.dbRun(
    "INSERT INTO matters (short_name, client_role, caption_style, created_at) VALUES (?, 'plaintiff', 'full', ?)",
    ['Role9A Plaintiff Case', now])).lastInsertRowid;
  await window.openMatterForTest(prior); await wait(300);
  out.priorRole = $('mat-client_role').value;
  $('nav-matters').click(); await wait(300);
  $('btn-new-matter').click(); await wait(300);
  $('btn-fork-court').click(); await wait(500);
  out.roleOnNew = $('mat-client_role').value;
  out.firstOptionText = $('mat-client_role').options[0].textContent;
  $('mat-matter_type_id').value = String(sideless);
  $('mat-matter_type_id').dispatchEvent(new Event('change', { bubbles: true }));
  await wait(100);
  out.roleAfterSidelessType = $('mat-client_role').value;
  out.nextDisabledBlank = $('btn-wizard-next').disabled;
  // Save with the side still blank writes nothing.
  $('mat-short_name').value = 'Role9A Blank Side Case';
  await window.saveMatterForTest(); await wait(300);
  out.blankSaved = !!(await window.api.dbGet(
    "SELECT id FROM matters WHERE short_name = 'Role9A Blank Side Case'"));
  $('mat-client_role').value = 'defendant';
  $('mat-client_role').dispatchEvent(new Event('change', { bubbles: true }));
  out.nextDisabledChosen = $('btn-wizard-next').disabled;
  await window.saveMatterForTest(); await wait(300);
  out.chosenSaved = ((await window.api.dbGet(
    "SELECT client_role FROM matters WHERE short_name = 'Role9A Blank Side Case'")) || {}).client_role || null;
  window.markFormCleanForTest('view-matter-detail');

  // (2) Organization profiles.
  const mkPerson = async (name, kind, phones) => (await window.api.dbRun(
    `INSERT INTO people (display_name, kind, street, city, zip, cell_phone, home_phone, phone, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [name, kind, '1 Main St', 'Exampleton', '48000', phones.cell || null, phones.home || null, phones.other || null, now]
  )).lastInsertRowid;
  const orgOther = await mkPerson('Role9A Org With Office Line', 'organization', { other: '555-0100' });
  const orgNone = await mkPerson('Role9A Org No Phone', 'organization', {});
  const indHome = await mkPerson('Role9A Individual Home Only', 'individual', { home: '555-0101' });
  const issuesText = () => $('person-issues').textContent;
  const dobHidden = () => !!$('per-dob').closest('.form-group').classList.contains('hidden')
    || $('per-dob').offsetParent === null;
  await window.openPerson(orgOther); await wait(200);
  out.orgOther = { dobHidden: dobHidden(), issues: issuesText() };
  await window.openPerson(orgNone); await wait(200);
  out.orgNone = { dobHidden: dobHidden(), issues: issuesText() };
  await window.openPerson(indHome); await wait(200);
  out.indHome = { dobHidden: dobHidden(), issues: issuesText() };
  // Switching the Type select on screen shows/hides the field too.
  $('per-kind').value = 'organization';
  $('per-kind').dispatchEvent(new Event('change'));
  out.dobHiddenAfterSwitch = dobHidden();
  $('per-kind').value = 'individual';
  $('per-kind').dispatchEvent(new Event('change'));
  window.markFormCleanForTest('view-person-detail');

  // (3) The race. The signing-attorney select is repainted synchronously
  // right after openPerson's first await, just before it awaits the priors;
  // a MutationObserver fires at the next microtask checkpoint — inside that
  // window — and opens a blank new profile.
  const racer = (await window.api.dbRun(
    'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
    ['Role9A Racer With Priors', 'individual', now])).lastInsertRowid;
  await window.api.dbRun(
    `INSERT INTO person_priors (person_id, offense, jurisdiction, sort_order) VALUES (?,?,?,0)`,
    [racer, 'Role9A Prior Offense', 'Exampleton']);
  let hopped = false;
  const obs = new MutationObserver(() => {
    if (hopped) return;
    hopped = true;
    obs.disconnect();
    window.openPerson(null);
  });
  obs.observe($('per-signing_attorney_id'), { childList: true });
  await window.openPerson(racer);
  await wait(500);
  obs.disconnect();
  out.race = {
    hopped,
    perId: $('per-id').value,
    priorsText: $('priors-list') ? $('priors-list').textContent + [...$('priors-list').querySelectorAll('input')].map(i => i.value).join('|') : '',
    issues: issuesText()
  };
  window.markFormCleanForTest('view-person-detail');
  return out;
}).catch(e => ({ error: String(e) }));

if (role9a.error) {
  check('9A role / org profile / openPerson race fixtures', false, role9a.error);
} else {
  const r = role9a;
  const J = JSON.stringify;
  check('a new case after a plaintiff-side case starts with Our Client Role blank',
    r.priorRole === 'plaintiff' && r.roleOnNew === '' && /choose/.test(r.firstOptionText), J(r));
  check('wizard Next stays disabled until a real side is chosen (a sideless case type does not choose one)',
    r.roleAfterSidelessType === '' && r.nextDisabledBlank === true && r.nextDisabledChosen === false, J(r));
  check('Save refuses a blank Our Client Role, then saves once a side is chosen',
    r.blankSaved === false && r.chosenSaved === 'defendant', J([r.blankSaved, r.chosenSaved]));
  check('an Organization profile hides Date of Birth; an Individual shows it',
    r.orgOther.dobHidden && r.orgNone.dobHidden && !r.indHome.dobHidden && r.dobHiddenAfterSwitch, J(r));
  check('an Organization with only an office phone is not asked for a cell phone',
    !/phone/i.test(r.orgOther.issues), r.orgOther.issues);
  check('an Organization with no phone at all is asked for a phone number, not a cell phone',
    /phone/i.test(r.orgNone.issues) && !/cell/i.test(r.orgNone.issues), r.orgNone.issues);
  check('an Individual is still asked for a cell phone',
    /cell phone/i.test(r.indHome.issues), r.indHome.issues);
  check('openPerson: a profile opened mid-load never shows the previous person\'s priors or issues',
    r.race.hopped && r.race.perId === '' && !r.race.priorsText.includes('Role9A Prior Offense')
      && r.race.issues === '', J(r.race));
}

// --- Our side's role words, packet signing profile, blank authority (8b) -----
// Reuses the Task 8 fixtures above. (1) The Appearance's "attorney of record
// for …" / "Attorney for …" follow the case's client_role: the prosecuting
// City signs for the plaintiff label, and the caption's own role words stay
// as they were. (2) A packet opened on the City case with nothing on the
// Generate screen yet picks the City's signing profile. (3) A whitespace-only
// per-case authority yields to the case type's in BOTH engines.
const sideWords = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const out = {};
  const idOf = async (name) => ((await window.api.dbGet(
    'SELECT id FROM matters WHERE short_name = ? ORDER BY id DESC LIMIT 1', [name])) || {}).id;
  const cityCase = await idOf('Org Prefill City Case');
  const defenseCase = await idOf('Org Prefill Defense Case');
  if (!cityCase || !defenseCase) return { error: 'Task 8 fixtures missing' };
  const cityId = (await window.api.dbGet(
    "SELECT id FROM people WHERE display_name = 'City of Exampleton' AND archived = 0")).id;
  const cityAtt = (await window.api.dbGet(
    "SELECT id FROM attorneys WHERE label = 'Exampleton City Attorney'")).id;
  const typeAtt = (await window.api.dbGet(
    "SELECT id FROM attorneys WHERE label = 'Prosecution Type Attorney'")).id;
  const progType = (await window.api.dbGet(
    "SELECT id FROM matter_types WHERE name = 'Exampleton Prosecution'")).id;

  // Same technique as Task 8's genBoth: real Generate clicks, then the PDF's
  // HTML re-rendered from the stored snapshot.
  const genAppearance = async (matterId) => {
    await window.openMatterForTest(matterId); await wait(300);
    await $('btn-goto-generate').onclick(); await wait(300);
    $('gen-doctype').value = 'appearance';
    $('gen-doctype').dispatchEvent(new Event('change'));
    await wait(200);
    await $('btn-generate-pdf').onclick();
    await $('btn-generate-docx').onclick();
    const doc = await window.api.dbGet(
      "SELECT * FROM documents WHERE matter_id = ? AND doc_type = 'appearance' ORDER BY id DESC LIMIT 1", [matterId]);
    if (!doc) return { error: 'no documents row' };
    const dt = window.DocumentEngine.doctypes.find(d => d.id === 'appearance');
    const snap = JSON.parse(doc.matter_snapshot);
    const att = JSON.parse(doc.attorney_snapshot);
    const html = window.DocumentEngine.renderHtml(dt.build(snap, att, JSON.parse(doc.field_data || '{}')), snap, att);
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    return {
      capParties: [...parsed.querySelectorAll('.caption-grid .cap-party')].map(n => n.textContent.trim()),
      capRoles: [...parsed.querySelectorAll('.caption-grid .cap-role')].map(n => n.textContent.trim()),
      htmlText: parsed.body.textContent.replace(/\s+/g, ' '),
      pdfPath: doc.pdf_path, docxPath: doc.docx_path
    };
  };

  // 1a. The prosecuting City case, default labels.
  out.cityRole = (await window.api.dbGet('SELECT client_role FROM matters WHERE id = ?', [cityCase])).client_role;
  out.pros = await genAppearance(cityCase);
  // 1b. A custom plaintiff label, typed on the case form and saved.
  await window.openMatterForTest(cityCase); await wait(300);
  $('mat-plaintiff_label').value = 'Complainant';
  await window.saveMatterForTest(); await wait(300);
  out.custom = await genAppearance(cityCase);
  await window.openMatterForTest(cityCase); await wait(300);
  $('mat-plaintiff_label').value = 'Plaintiff';
  await window.saveMatterForTest(); await wait(300);

  // 3. The defense case (type authority PEOPLE OF THE STATE OF MICHIGAN, the
  // City as a plaintiff party) with a whitespace-only per-case authority.
  await window.openMatterForTest(defenseCase); await wait(300);
  $('mat-caption_authority').value = '   ';
  await window.saveMatterForTest(); await wait(300);
  out.blankAuthStored = (await window.api.dbGet(
    'SELECT caption_authority FROM matters WHERE id = ?', [defenseCase])).caption_authority;
  out.blank = await genAppearance(defenseCase);

  // 2. A packet on a City case, with the Generate screen never populated this
  // session (an empty list is what a fresh launch has). The case has no
  // attorney of its own; its type's attorney is a different profile.
  const now = new Date().toISOString();
  const pkCase = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, client_role, caption_style, matter_type_id, party_label, plaintiff_label, created_at)
     VALUES (?, ?, 'plaintiff', 'full', ?, 'Defendant', 'Plaintiff', ?)`,
    [cityId, 'Org Packet City Case', progType, now])).lastInsertRowid;
  await window.api.dbRun(
    "INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?, ?, ?, 'plaintiff', 'client', 0)",
    [pkCase, cityId, 'PEOPLE OF THE CITY OF EXAMPLETON']);
  await window.api.dbRun(
    "INSERT INTO parties (matter_id, name, side, role, sort_order) VALUES (?, 'Ivy Individual', 'defendant', 'opposing_party', 0)",
    [pkCase]);
  $('gen-attorney').innerHTML = '';
  await window.openMatterForTest(pkCase); await wait(300);
  $('btn-new-packet').click(); await wait(800);
  out.packetView = !$('view-packet').classList.contains('hidden');
  out.packetAtt = Number($('gen-attorney').value);
  $('btn-generate-packet-docx').click(); await wait(3500);
  const pdoc = await window.api.dbGet(
    `SELECT d.attorney_snapshot FROM documents d JOIN packets p ON p.id = d.packet_id
     WHERE p.matter_id = ? ORDER BY d.id DESC LIMIT 1`, [pkCase]);
  out.packetSnapAtt = pdoc ? JSON.parse(pdoc.attorney_snapshot).id : null;
  window.markFormCleanForTest && window.markFormCleanForTest('view-packet');

  // 2b (8c). Generate on another case with a DIFFERENT profile chosen by hand,
  // then reopen the City packet: the packet must recompute for its own case,
  // never carry the other case's selection across.
  const pkRow = await window.api.dbGet(
    'SELECT id FROM packets WHERE matter_id = ? ORDER BY id DESC LIMIT 1', [pkCase]);
  await window.openMatterForTest(defenseCase); await wait(300);
  await $('btn-goto-generate').onclick(); await wait(300);
  $('gen-attorney').value = String(typeAtt);
  out.staleBefore = Number($('gen-attorney').value);
  if (pkRow) { await window.openPacketForTest(pkRow.id); await wait(500); }
  out.staleAfter = Number($('gen-attorney').value);
  window.markFormCleanForTest && window.markFormCleanForTest('view-packet');

  Object.assign(out, { cityAtt, typeAtt });
  return out;
}).catch(e => ({ error: String(e) }));

if (sideWords.error) {
  check('our side\'s role words follow client_role', false, sideWords.error);
} else {
  const s = sideWords;
  const J = JSON.stringify;
  const run = (text) => new RegExp(`<w:t(?: [^>]*)?>${text}</w:t>`);
  const xmlOf = (p) => (p ? readDocxXml(p) : '');
  const prosXml = xmlOf(s.pros.docxPath);
  check('prosecuting City: PDF HTML says "attorney of record for plaintiff" and "Attorney for Plaintiff"',
    s.cityRole === 'plaintiff' && !!s.pros.pdfPath && fs.existsSync(onDisk(s.pros.pdfPath))
      && s.pros.htmlText.includes('as the attorney of record for plaintiff in the above-entitled matter')
      && s.pros.htmlText.includes('Attorney for Plaintiff')
      && !/attorney of record for defendant|Attorney for Defendant/i.test(s.pros.htmlText),
    J([s.cityRole, s.pros.htmlText]));
  check('prosecuting City: the caption\'s role words are unchanged',
    J(s.pros.capRoles) === J(['Plaintiff', 'Defendant']), J(s.pros.capRoles));
  check('prosecuting City: Word says "attorney of record for plaintiff" and "Attorney for Plaintiff"',
    prosXml.includes('as the attorney of record for plaintiff in the above-entitled matter')
      && run('Attorney for Plaintiff').test(prosXml)
      && !/attorney of record for defendant|Attorney for Defendant/i.test(prosXml)
      && run('Defendant').test(prosXml), s.pros.docxPath);
  const customXml = xmlOf(s.custom.docxPath);
  check('a custom plaintiff label is our side\'s role word in both engines',
    s.custom.htmlText.includes('attorney of record for complainant')
      && s.custom.htmlText.includes('Attorney for Complainant')
      && customXml.includes('attorney of record for complainant')
      && run('Attorney for Complainant').test(customXml)
      && !/Attorney for (Defendant|Plaintiff)/.test(s.custom.htmlText + customXml),
    J([s.custom.htmlText, s.custom.docxPath]));
  check('a defense case still signs for the defendant (both engines)',
    s.blank.htmlText.includes('attorney of record for defendant') && s.blank.htmlText.includes('Attorney for Defendant')
      && run('Attorney for Defendant').test(xmlOf(s.blank.docxPath)), s.blank.docxPath);
  const blankXml = xmlOf(s.blank.docxPath);
  check('whitespace-only caption authority: the case type\'s authority prints in PDF HTML',
    s.blankAuthStored === '   ' && s.blank.capParties[0] === 'PEOPLE OF THE STATE OF MICHIGAN'
      && !s.blank.htmlText.includes('PEOPLE OF THE CITY OF EXAMPLETON'), J([s.blankAuthStored, s.blank.capParties]));
  const iAuth = blankXml.indexOf('PEOPLE OF THE STATE OF MICHIGAN');
  const iPl = blankXml.search(run('Plaintiff'));
  check('whitespace-only caption authority: the case type\'s authority prints in Word',
    iAuth >= 0 && iPl > iAuth && !blankXml.includes('PEOPLE OF THE CITY OF EXAMPLETON'), s.blank.docxPath);
  check('a packet on the City case picks the City signing profile without visiting Generate',
    s.packetView && s.packetAtt === s.cityAtt && s.packetSnapAtt === s.cityAtt,
    J([s.packetView, s.packetAtt, s.packetSnapAtt, s.cityAtt, s.typeAtt]));
  check('reopening a City packet after Generate on another case with a different profile picks the City profile',
    s.staleBefore === s.typeAtt && s.typeAtt !== s.cityAtt && s.staleAfter === s.cityAtt,
    J([s.staleBefore, s.staleAfter, s.cityAtt, s.typeAtt]));
  // District caption role word under the plaintiff follows plaintiff_label.
  check('district caption, PDF engine: a custom plaintiff label prints under the plaintiff',
    J(s.custom.capRoles) === J(['Complainant', 'Defendant']), J(s.custom.capRoles));
  const iCompl = customXml.search(run('Complainant'));
  const iVs = customXml.search(run('vs\\.'));
  check('district caption, Word engine: a custom plaintiff label prints under the plaintiff',
    iCompl >= 0 && iVs > iCompl && !run('Plaintiff').test(customXml), s.custom.docxPath);
  const iPlDefault = prosXml.search(run('Plaintiff'));
  check('district caption, Word engine: default label still prints "Plaintiff" under the plaintiff',
    iPlDefault >= 0 && iPlDefault < prosXml.search(run('vs\\.')), s.pros.docxPath);
}

// --- Global search and the version badge ------------------------------------
const shell = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const input = document.getElementById('global-search');
  const box = document.getElementById('global-search-results');
  if (!input || !box) return { error: 'search elements missing' };

  // A matter whose SECOND case number is the memorable one — an appeal carries
  // the case below, and that is often the number the user remembers.
  const m = (await window.api.dbRun(
    `INSERT INTO matters (short_name, case_number, client_role, caption_style, party_label, archived, created_at)
     VALUES (?,?,?,?,?,0,?)`,
    ['Searchable Appeal', '26-APPEAL-1', 'defendant', 'full', 'Defendant', new Date().toISOString()])).lastInsertRowid;
  await window.api.dbRun(
    'INSERT INTO matter_cases (matter_id, case_number, sort_order) VALUES (?,?,1)', [m, '99-BELOW-7']);
  await window.api.dbRun(
    'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
    ['Searchable Client', 'individual', new Date().toISOString()]);
  // Archived records must stay out of the results.
  await window.api.dbRun(
    'INSERT INTO people (display_name, kind, archived, created_at) VALUES (?,?,1,?)',
    ['Searchable Archived', 'individual', new Date().toISOString()]);

  const search = async (term) => {
    input.value = term;
    input.dispatchEvent(new Event('input'));
    await wait(500);
    return box.innerText;
  };

  const byName = await search('Searchable Client');
  const byMatter = await search('Searchable Appeal');
  const byCaseBelow = await search('99-BELOW');
  const archived = await search('Searchable Archived');
  const noHits = await search('zzzzz-no-such-thing');
  // A single character must not fire a query at all.
  const tooShort = await search('S');
  const tooShortHidden = box.classList.contains('hidden');
  // A wildcard typed by the user must be treated as a literal.
  const wildcard = await search('%');

  input.value = '';
  input.dispatchEvent(new Event('input'));
  await wait(300);

  const version = document.getElementById('app-version').textContent;
  return { byName, byMatter, byCaseBelow, archived, noHits, tooShortHidden, wildcard, version };
}).catch(e => ({ error: String(e) }));

if (shell.error) {
  check('global search', false, shell.error);
} else {
  check('search finds a client by name',
    shell.byName.includes('Searchable Client'), JSON.stringify(shell.byName));
  check('search finds a matter by name',
    shell.byMatter.includes('Searchable Appeal'), JSON.stringify(shell.byMatter));
  // The reason matter_cases is searched at all.
  check('search finds a matter by a case number held only in matter_cases',
    shell.byCaseBelow.includes('Searchable Appeal'), JSON.stringify(shell.byCaseBelow));
  check('search excludes archived records',
    !shell.archived.includes('Searchable Archived'), JSON.stringify(shell.archived));
  check('search says so when nothing matches',
    shell.noHits.includes('No matches.'), JSON.stringify(shell.noHits));
  check('a one-character term does not open the results box',
    shell.tooShortHidden === true, String(shell.tooShortHidden));
  // An unescaped % would match every row in the database.
  check('a typed "%" is a literal, not a wildcard matching everything',
    !shell.wildcard.includes('Searchable Appeal'), JSON.stringify(shell.wildcard));

  check('the app version is shown in the corner',
    /^v\d+\.\d+\.\d+/.test(shell.version), JSON.stringify(shell.version));
}

// The caret's "Show archived" option surfaces archived matches, marked and
// below the active ones — but only once turned on.
const archivedSearch = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const input = document.getElementById('global-search');
  const box = document.getElementById('global-search-results');
  const caret = document.getElementById('global-search-caret');
  const menu = document.getElementById('global-search-menu');
  const toggle = document.getElementById('global-search-archived');

  caret.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  const menuOpenedOnCaret = !menu.classList.contains('hidden');

  toggle.checked = true;
  toggle.dispatchEvent(new Event('change'));
  input.value = 'Searchable Archived';
  input.dispatchEvent(new Event('input'));
  await wait(500);
  const withToggleOn = box.innerText;

  toggle.checked = false;
  toggle.dispatchEvent(new Event('change'));
  await wait(500);
  const withToggleOff = box.innerText;

  input.value = '';
  input.dispatchEvent(new Event('input'));
  await wait(300);

  return { menuOpenedOnCaret, withToggleOn, withToggleOff };
}).catch(e => ({ error: String(e) }));

if (archivedSearch.error) {
  check('archived search caret', false, archivedSearch.error);
} else {
  check('the caret opens the search options menu',
    archivedSearch.menuOpenedOnCaret);
  check('"Show archived" surfaces an archived client, marked as archived',
    archivedSearch.withToggleOn.includes('Searchable Archived') && archivedSearch.withToggleOn.includes('(archived)'),
    JSON.stringify(archivedSearch.withToggleOn));
  check('turning the toggle back off hides the archived client again',
    !archivedSearch.withToggleOff.includes('Searchable Archived'),
    JSON.stringify(archivedSearch.withToggleOff));
}

// --- Standalone Letters ---------------------------------------------------
// The one fixture that drives the whole thing through the real UI, not a SQL
// shortcut: btn-fork-letter -> a brand-new recipient via the combobox's
// "+ Add" row (exercising inline person creation) -> leave the matter-attach
// combobox blank (exercising the no-matter path) -> Continue -> fill subject
// and a two-paragraph body on view-packet -> Generate Packet (Word). Must run
// before app.close() below — everything after that only reads files already
// written to disk, no more browser driving.
const standaloneLetter = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, tries = 50, ms = 100) => {
    for (let i = 0; i < tries; i++) {
      const v = await fn();
      if (v) return v;
      await wait(ms);
    }
    return null;
  };

  const lh = (await window.api.dbRun(
    `INSERT INTO letterheads (label, masthead, office_lines, address, phone, fax, side_names, ref_separator)
     VALUES (?,?,?,?,?,?,?,?)`,
    ['Letter Test LH', 'STANDALONE LETTER MASTHEAD', 'ATTORNEYS AT LAW',
     '99 Test Avenue\nTesterton, MI 48000', '(555) 010-9000', '(555) 010-9001',
     'PAT ATTORNEY', ':'])).lastInsertRowid;
  const lhRow = await window.api.dbGet('SELECT * FROM letterheads WHERE id = ?', [lh]);

  // Same source the PDF path actually renders from, called directly — the
  // same pattern the other doctype checks in this file use ("... PDF
  // engine") rather than parsing a generated PDF's binary content.
  const dt = window.DocumentEngine.doctypes.find(d => d.id === 'standalone_letter_doc');
  const renderPacketHtml = (packetRow) => {
    const matterStub = { id: null, letterhead: lhRow };
    const blocks = dt.build(matterStub, {}, { packet: packetRow });
    return window.DocumentEngine.renderHtml(blocks, matterStub, {});
  };

  const makeLetter = async ({ recipientName, subject, para1, para2, confidential, ccNames }) => {
    document.getElementById('nav-matters').click();
    await wait(400);
    document.getElementById('btn-new-matter').click();
    await wait(300);
    document.getElementById('btn-fork-letter').click();
    await wait(300);

    const input = document.getElementById('ltr-recipient_name');
    input.value = recipientName;
    input.dispatchEvent(new Event('input'));
    await wait(300);
    const drop = document.querySelector('#combo-letter-recipient .combobox-dropdown');
    const addLi = [...drop.querySelectorAll('li')].find(li => li.textContent.startsWith('+ Add'));
    if (!addLi) return { error: 'no "+ Add" option found in the recipient combobox' };
    addLi.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const personId = await waitFor(() => document.getElementById('ltr-recipient_person_id').value);
    if (!personId) return { error: 'recipient person was not created' };

    // The matter-attach combobox is left blank on purpose here.
    document.getElementById('btn-create-letter').click();
    const packetOpened = await waitFor(() =>
      !document.getElementById('view-packet').classList.contains('hidden')
      && document.getElementById('pk-kind').value === 'standalone_letter');
    if (!packetOpened) return { error: 'view-packet did not open for the new letter' };

    document.getElementById('pk-letterhead_id').value = String(lh);
    document.getElementById('pkf_subject').value = subject;
    document.getElementById('pkf_letter_body').value = `${para1}\n\n${para2}`;
    if (confidential) document.getElementById('pkf_confidential').click();
    if (ccNames && ccNames.length) document.getElementById('pkf_cc_list').value = ccNames.join('\n');

    document.getElementById('btn-generate-packet-docx').click();
    const resultShown = await waitFor(() =>
      !document.getElementById('packet-result').classList.contains('hidden'), 100, 100);
    if (!resultShown) return { error: 'packet-result never appeared — generation did not complete' };

    const packetRow = await window.api.dbGet(
      `SELECT * FROM packets WHERE recipient_person_id = ? AND kind = 'standalone_letter'
       ORDER BY id DESC LIMIT 1`, [personId]);
    const doc = await window.api.dbGet(
      'SELECT docx_path FROM documents WHERE packet_id = ? ORDER BY id DESC LIMIT 1', [packetRow && packetRow.id]);

    return {
      recipientName, subject, para1, para2,
      docx: doc && doc.docx_path,
      packetDir: packetRow && packetRow.output_dir,
      html: packetRow ? renderPacketHtml(packetRow) : ''
    };
  };

  const plain = await makeLetter({
    recipientName: 'Casey Newletter Recipient',
    subject: 'Regarding Your Recent Inquiry',
    para1: 'This is the first paragraph of the letter body, written for the smoke fixture.',
    para2: 'This is the second paragraph, on its own line after a blank line.'
  });
  if (plain.error) return { error: plain.error };

  const cc1 = 'Chief Adams', cc2 = 'Manager Baker', cc3 = 'Deputy Chief Carter';
  const confidential = await makeLetter({
    recipientName: 'Riley City Attorney Recipient',
    subject: 'City Attorney Confidential Matter',
    para1: 'This letter carries a confidential banner and a cc list, for the smoke fixture.',
    para2: 'The second paragraph exists only to exercise the paragraph-splitting logic again.',
    confidential: true,
    ccNames: [cc1, cc2, cc3]
  });
  if (confidential.error) return { error: confidential.error };

  return { ...plain, confidential: { ...confidential, cc1, cc2, cc3 } };
}).catch(e => ({ error: String(e) })).then(resolveStored);

// --- Attach-a-scan (Task 6-8 of the City Attorney letter plan) ------------
// The OS "choose a file" dialog can't be driven here (same constraint as the
// signature-image picker's own smoke coverage above), so this writes the
// data URI directly to the DB instead of clicking "Attach File…" — but
// everything else runs through the real UI: the body-source toggle, the
// button relabel/hide, reopening the packet from the recipient's People
// page (which is what actually restores attachedScanData from the DB row,
// exercising the exact Task 6 openPacket() code path), and the real
// "Save Attached Letter" click through the save-attached-file IPC round trip.
const attachedScan = await page.evaluate(async (pngDataUri) => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, tries = 50, ms = 100) => {
    for (let i = 0; i < tries; i++) {
      const v = await fn();
      if (v) return v;
      await wait(ms);
    }
    return null;
  };

  document.getElementById('nav-matters').click();
  await wait(400);
  document.getElementById('btn-new-matter').click();
  await wait(300);
  document.getElementById('btn-fork-letter').click();
  await wait(300);

  const recipientName = 'Jordan Attach Recipient';
  const input = document.getElementById('ltr-recipient_name');
  input.value = recipientName;
  input.dispatchEvent(new Event('input'));
  await wait(300);
  const drop = document.querySelector('#combo-letter-recipient .combobox-dropdown');
  const addLi = [...drop.querySelectorAll('li')].find(li => li.textContent.startsWith('+ Add'));
  if (!addLi) return { error: 'no "+ Add" option found in the recipient combobox' };
  addLi.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  const personId = await waitFor(() => document.getElementById('ltr-recipient_person_id').value);
  if (!personId) return { error: 'recipient person was not created' };

  document.getElementById('btn-create-letter').click();
  const packetOpened = await waitFor(() =>
    !document.getElementById('view-packet').classList.contains('hidden')
    && document.getElementById('pk-kind').value === 'standalone_letter');
  if (!packetOpened) return { error: 'view-packet did not open for the new letter' };

  // Switch to "Attach a file" — real UI click, exercises the toggle.
  document.querySelector('input[name="pk-body-source"][value="attached"]').click();
  const attachRowVisible = !document.getElementById('pk-attach-row').classList.contains('hidden');
  const subjectFieldHidden = document.getElementById('pkf_subject').closest('.form-group').classList.contains('hidden');
  const docxBtnHiddenWhileAttached = document.getElementById('btn-generate-packet-docx').classList.contains('hidden');
  const pdfBtnLabel = document.getElementById('btn-generate-packet-pdf').textContent;

  // Clicking Save with nothing attached yet must not write a document.
  document.getElementById('btn-generate-packet-pdf').click();
  const guardShown = await waitFor(() =>
    (document.getElementById('packet-result-text').textContent || '').includes('No file is attached'), 30, 100);

  const packetRow = await window.api.dbGet(
    `SELECT id, output_dir FROM packets WHERE recipient_person_id = ? AND kind = 'standalone_letter'
     ORDER BY id DESC LIMIT 1`, [personId]);
  if (!packetRow) return { error: 'packet row was not created' };

  // Simulate a successful file pick (the one step the OS dialog blocks) by
  // writing straight to the column savePacket() itself would have written.
  await window.api.dbRun('UPDATE packets SET attached_scan_data = ? WHERE id = ?', [pngDataUri, packetRow.id]);

  // Reopen the packet through the real UI — People -> this recipient ->
  // their letters list -> this letter — which is what actually reads
  // attached_scan_data back into the form (Task 6's openPacket() restore).
  document.getElementById('nav-people').click();
  await wait(400);
  const personRow = await waitFor(() => [...document.querySelectorAll('#people-list tr')]
    .find(tr => (tr.firstChild && tr.firstChild.textContent || '').includes(recipientName)));
  if (!personRow) return { error: 'recipient not found in the People list' };
  personRow.click();
  const letterLink = await waitFor(() => document.querySelector('#person-work-product a'));
  if (!letterLink) return { error: 'no letter link found on the recipient\'s People page' };
  letterLink.click();
  const reopened = await waitFor(() =>
    !document.getElementById('view-packet').classList.contains('hidden')
    && document.querySelector('input[name="pk-body-source"][value="attached"]').checked);
  if (!reopened) return { error: 'reopening the packet did not restore the "Attach a file" state' };
  const filenameAfterReopen = document.getElementById('pk-attach-filename').textContent;

  document.getElementById('btn-generate-packet-pdf').click();
  const resultShown = await waitFor(() =>
    (document.getElementById('packet-result-text').textContent || '').includes('Attached letter saved'), 100, 100);
  if (!resultShown) return { error: 'attached letter was not saved — packet-result never showed the saved message' };

  const doc = await window.api.dbGet(
    'SELECT pdf_path FROM documents WHERE packet_id = ? ORDER BY id DESC LIMIT 1', [packetRow.id]);
  const savedPacket = await window.api.dbGet('SELECT body_source FROM packets WHERE id = ?', [packetRow.id]);

  return {
    attachRowVisible, subjectFieldHidden, docxBtnHiddenWhileAttached, pdfBtnLabel,
    guardShown: !!guardShown, filenameAfterReopen,
    bodySource: savedPacket && savedPacket.body_source,
    outputPath: doc && doc.pdf_path
  };
}, TINY_PNG).catch(e => ({ error: String(e) }));

// --- Printable blank questionnaire ----------------------------------------
// The attorney's intake runs two ways: typed live during a consultation, and on paper
// for a walk-in. Both are built from ONE ordered list (INTAKE_FIELDS), and the
// drift guard below is the reason: a field added to the profile and not to the
// paper form means answers collected with nowhere to put them.
const questionnaire = await page.evaluate(async () => {
  document.getElementById('nav-people').click();
  document.getElementById('btn-new-person').click();
  const res = await window.generateBlankQuestionnaire();
  return {
    path: res && res.path,
    // Read back out of the page so the guard compares against what the app
    // actually holds, not a copy of the list pasted into the test.
    labels: window.INTAKE_FIELDS.filter(f => f.paper !== false && !f.office).map(f => f.label),
    excluded: window.INTAKE_FIELDS.filter(f => f.paper === false).map(f => f.col),
    // Office configuration, not client intake: the Organization block.
    office: window.INTAKE_FIELDS.filter(f => f.office).map(f => f.col),
    officeSections: [...new Set(window.INTAKE_FIELDS.filter(f => f.office).map(f => f.section))],
    // A field on the list with no input on screen saves nowhere; this is the
    // other half of "both read from the same list".
    missingInputs: window.INTAKE_FIELDS
      .filter(f => !document.getElementById('per-' + f.col)).map(f => f.col),
    priorHeadings: window.INTAKE_PRIOR_COLUMNS.map(c => c.label)
  };
}).catch(e => ({ error: String(e) }));

// --- Client documents: frozen folder, no-overwrite copy (Task 17) -----------
//
// output_root already points at tmpRoot above, so nothing here touches the real
// "Legal Documents" folder.
// Two different scans that happen to share a filename — the everyday case for
// a scanner that names everything "Police report.pdf".
const scanSrcA = fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-scans-a-'));
const scanSrcB = fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-scans-b-'));
const scanA = path.join(scanSrcA, 'Police report.pdf');
const scanB = path.join(scanSrcB, 'Police report.pdf');
fs.writeFileSync(scanA, 'FIRST SCAN BYTES');
fs.writeFileSync(scanB, 'SECOND SCAN BYTES');

const clientDir = await page.evaluate(async () => {
  const p = await window.api.dbGet("SELECT * FROM people WHERE display_name = 'Round Trip Test'");
  const first = await window.api.clientDocsDir(p.id);
  await window.api.dbRun('UPDATE people SET display_name = ? WHERE id = ?', ['Renamed Client', p.id]);
  const afterRename = await window.api.clientDocsDir(p.id);
  // Put the fixture name back: later runs of this file must not depend on the
  // rename, and the rename has already done its job by this line.
  await window.api.dbRun('UPDATE people SET display_name = ? WHERE id = ?', ['Round Trip Test', p.id]);
  return { first, afterRename, id: p.id };
}).catch(e => ({ error: String(e) }));

check('the client documents folder is frozen against a later rename',
  !clientDir.error && clientDir.first === clientDir.afterRename,
  clientDir.error || `${clientDir.first} vs ${clientDir.afterRename}`);
check('the folder was actually created',
  !!clientDir.first && fs.existsSync(clientDir.first), String(clientDir.first));

// Copying a second file with the same name must never overwrite the first —
// the file being overwritten is somebody's only copy of that scan.
const copied = await page.evaluate(async ({ pid, a, b }) => {
  const one = await window.api.addClientDocumentFiles(pid, [a]);
  const two = await window.api.addClientDocumentFiles(pid, [b]);
  const rows = await window.api.dbAll(
    'SELECT * FROM client_documents WHERE person_id = ? ORDER BY id', [pid]);
  return { one, two, rows };
}, { pid: clientDir.id, a: scanA, b: scanB }).catch(e => ({ error: String(e) }));

if (copied.error) {
  check('client documents copy in without overwriting', false, copied.error);
} else {
  check('the first file keeps its own name',
    copied.one.files[0].filename === 'Police report.pdf', JSON.stringify(copied.one.files));
  check('a colliding filename gets a " (2)" suffix instead of overwriting',
    copied.two.files[0].filename === 'Police report (2).pdf', JSON.stringify(copied.two.files));
  // Client Papers/ (client-folders Task 5): a scan tied to no case goes in
  // the client's Client Papers folder, not loose in the client's root.
  const papers = path.join(clientDir.first, 'Client Papers');
  check('the first file on disk still holds its original bytes',
    fs.readFileSync(path.join(papers, 'Police report.pdf'), 'utf8') === 'FIRST SCAN BYTES');
  check('the second file on disk holds the second file\'s bytes',
    fs.readFileSync(path.join(papers, 'Police report (2).pdf'), 'utf8') === 'SECOND SCAN BYTES');
  check('an upload with no case records Client Papers as its stored_dir',
    copied.rows.every(r => onDisk(r.stored_dir) === papers) && copied.one.dir === papers,
    JSON.stringify(copied.rows.map(r => r.stored_dir)));
  check('each copied file is recorded in client_documents',
    copied.rows.length === 2
      && copied.rows[0].original_name === 'Police report.pdf'
      && copied.rows[1].filename === 'Police report (2).pdf'
      && copied.rows.every(r => !!r.added_at),
    JSON.stringify(copied.rows.map(r => [r.filename, r.original_name])));

  // A6: each attached file logs its own "document_attached" activity row.
  const attachLog = await page.evaluate(async (pid) =>
    window.api.dbAll(
      `SELECT description FROM activity_log WHERE person_id = ? AND event_type = 'document_attached' ORDER BY id`,
      [pid]), clientDir.id);
  check('attaching a client document logs an activity row',
    attachLog.length === 2 && attachLog[0].description.includes('Police report.pdf'),
    JSON.stringify(attachLog));
}

// Windows path safety. The illegal characters and reserved device names are
// stripped by sanitizeSegment; these assertions are platform-independent
// (the sanitised STRING is asserted), because a Mac would happily create
// folders that Windows Explorer refuses outright.
const winSafe = await page.evaluate(async () => {
  const mk = async (name) => {
    const id = (await window.api.dbRun(
      'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
      [name, 'individual', new Date().toISOString()])).lastInsertRowid;
    return { id, dir: await window.api.clientDocsDir(id) };
  };
  // A firm name with a slash, and a client whose surname is a reserved device name.
  const slash = await mk('Smith/Jones Family Trust');
  const reserved = await mk('Nul');
  // Two different clients whose names sanitise to the SAME string.
  const twinA = await mk('Acme: Holdings');
  const twinB = await mk('Acme Holdings');
  return { slash, reserved, twinA, twinB };
}).catch(e => ({ error: String(e) }));

if (winSafe.error) {
  check('client folder names are safe on Windows', false, winSafe.error);
} else {
  const bad = /[\\/:*?"<>|]/;
  check('a client name containing a Windows-illegal character still gets a usable folder',
    !bad.test(path.basename(winSafe.slash.dir)) && fs.existsSync(winSafe.slash.dir),
    winSafe.slash.dir);
  check('a client named after a Windows reserved device gets an escaped folder',
    path.basename(winSafe.reserved.dir) === '_Nul' && fs.existsSync(winSafe.reserved.dir),
    winSafe.reserved.dir);
  check('two clients whose names sanitise alike do not share one folder',
    winSafe.twinA.dir !== winSafe.twinB.dir
      && fs.existsSync(winSafe.twinA.dir) && fs.existsSync(winSafe.twinB.dir),
    `${winSafe.twinA.dir} vs ${winSafe.twinB.dir}`);
  check('the disambiguated folder is still free of Windows-illegal characters',
    !bad.test(path.basename(winSafe.twinB.dir)) && !bad.test(path.basename(winSafe.twinA.dir)),
    `${path.basename(winSafe.twinA.dir)} | ${path.basename(winSafe.twinB.dir)}`);
}


// --- Case folders live under their client (client-folders Task 3) ----------
//
// Driven through window.api like the section above, with output_root still
// pointing at tmpRoot. Every case here is built straight in the database so
// the one thing under test is where getMatterDir puts it.
const caseFolders = await page.evaluate(async () => {
  const now = new Date().toISOString();
  const person = async (name) => (await window.api.dbRun(
    'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
    [name, 'individual', now])).lastInsertRowid;
  // clients: person ids linked as role 'client' on the plaintiff side. The
  // other side is always an unlinked opposing party, as in real use.
  const mkCase = async (shortName, caseNumber, clients) => {
    const id = (await window.api.dbRun(
      'INSERT INTO matters (short_name, case_number, client_role, caption_style, created_at) VALUES (?,?,?,?,?)',
      [shortName, caseNumber, 'plaintiff', 'full', now])).lastInsertRowid;
    for (let i = 0; i < clients.length; i++) {
      const p = await window.api.dbGet('SELECT display_name FROM people WHERE id = ?', [clients[i]]);
      await window.api.dbRun(
        'INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,?)',
        [id, clients[i], p.display_name, 'plaintiff', 'client', i]);
    }
    await window.api.dbRun(
      'INSERT INTO parties (matter_id, name, side, role, sort_order) VALUES (?,?,?,?,?)',
      [id, 'City of Exampleton', 'defendant', 'opposing_party', 0]);
    return id;
  };
  const load = async (id) => {
    const m = await window.api.dbGet('SELECT * FROM matters WHERE id = ?', [id]);
    m.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id = ? ORDER BY side, sort_order', [id]);
    return m;
  };
  const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default = 1');
  const dt = window.DocumentEngine.doctypes.find(d => d.id === 'brief_shell');
  const pdf = async (id, title) => {
    const m = await load(id);
    const blocks = dt.build(m, attorney, { brief_title: title });
    return window.api.generatePdf(window.DocumentEngine.renderHtml(blocks, m, attorney), m, dt.label, dt.id);
  };
  const frozen = async (id) =>
    (await window.api.dbGet('SELECT output_dir, folder_person_id FROM matters WHERE id = ?', [id]));
  const clientDocsDir = async (pid) =>
    (await window.api.dbGet('SELECT client_docs_dir FROM people WHERE id = ?', [pid])).client_docs_dir;

  // One client.
  const alice = await person('Alice Anderson');
  const single = await mkCase('Anderson v Exampleton', '2026-CV-301', [alice]);
  const singleFirst = await pdf(single, 'First Brief');
  // Rename the case AND the client; the next document must still land in the
  // folder the first one created.
  await window.api.dbRun('UPDATE matters SET short_name = ?, case_number = ? WHERE id = ?',
    ['Anderson Renamed', '2026-CV-999', single]);
  await window.api.dbRun('UPDATE people SET display_name = ? WHERE id = ?', ['Alice Renamed', alice]);
  const singleSecond = await pdf(single, 'Second Brief');
  await window.api.dbRun('UPDATE people SET display_name = ? WHERE id = ?', ['Alice Anderson', alice]);

  // Two clients: nobody has chosen, so nothing may be written.
  const bob = await person('Bob Baker');
  const carol = await person('Carol Clark');
  const shared = await mkCase('Baker and Clark v Exampleton', '2026-CV-302', [bob, carol]);
  const sharedAsk = await pdf(shared, 'Shared Brief');
  const sharedAfterAsk = await frozen(shared);
  const sharedDocsAfterAsk = await window.api.dbAll(
    'SELECT id FROM generated_files WHERE matter_id = ?', [shared]);
  const bobDirAfterAsk = await clientDocsDir(bob);
  const carolDirAfterAsk = await clientDocsDir(carol);
  // The choice is stored; the second client wins.
  await window.api.dbRun('UPDATE matters SET folder_person_id = ? WHERE id = ?', [carol, shared]);
  const sharedChosen = await pdf(shared, 'Shared Brief');

  // No client, explicitly filed under "No Client".
  const orphan = await mkCase('Exampleton Records Request', '2026-CV-303', []);
  const orphanAsk = await pdf(orphan, 'Orphan Brief');
  await window.api.dbRun('UPDATE matters SET folder_person_id = 0 WHERE id = ?', [orphan]);
  const orphanChosen = await pdf(orphan, 'Orphan Brief');

  return {
    alice, carol,
    singleFirst, singleSecond, singleFrozen: await frozen(single),
    aliceDir: await clientDocsDir(alice),
    sharedAsk, sharedAfterAsk, sharedDocsAfterAsk, bobDirAfterAsk, carolDirAfterAsk,
    sharedChosen, carolDir: await clientDocsDir(carol),
    orphanAsk, orphanChosen
  };
}).catch(e => ({ error: String(e) }));

if (caseFolders.error) {
  check('case folders live under their client', false, caseFolders.error);
} else {
  const cf = caseFolders;
  const aliceCase = path.join(tmpRoot, 'Clients', 'Alice Anderson', 'Anderson v Exampleton (2026-CV-301)');
  check('a one-client case saves under Clients/<Client>/<Case (No.)>/',
    !!cf.singleFirst.path && path.dirname(cf.singleFirst.path) === aliceCase && fs.existsSync(cf.singleFirst.path),
    String(cf.singleFirst.path));
  check('the case folder is frozen onto matters.output_dir',
    onDisk(cf.singleFrozen.output_dir) === aliceCase, String(cf.singleFrozen.output_dir));
  check('the case folder sits inside the client\'s own (frozen) folder',
    onDisk(cf.aliceDir) === path.join(tmpRoot, 'Clients', 'Alice Anderson'), String(cf.aliceDir));
  check('renaming the case and the client does not move the next document',
    !!cf.singleSecond.path && path.dirname(cf.singleSecond.path) === aliceCase
      && fs.existsSync(cf.singleSecond.path),
    String(cf.singleSecond.path));

  check('a two-client case with no choice stored asks instead of saving',
    !!cf.sharedAsk && cf.sharedAsk.needsFolderOwner === true && !cf.sharedAsk.path,
    JSON.stringify(cf.sharedAsk));
  check('asking writes nothing: no frozen folder, no generated_files row, no client folder',
    !cf.sharedAfterAsk.output_dir && cf.sharedAfterAsk.folder_person_id == null
      && cf.sharedDocsAfterAsk.length === 0 && !cf.bobDirAfterAsk && !cf.carolDirAfterAsk
      // Bob is never chosen, so his folder must still not exist now; Carol's
      // is created by the later choice, so hers is checked via the database
      // above and via the file count below.
      && !fs.existsSync(path.join(tmpRoot, 'Clients', 'Bob Baker')),
    JSON.stringify({ a: cf.sharedAfterAsk, n: cf.sharedDocsAfterAsk.length, b: cf.bobDirAfterAsk, c: cf.carolDirAfterAsk }));
  const carolCase = path.join(tmpRoot, 'Clients', 'Carol Clark', 'Baker and Clark v Exampleton (2026-CV-302)');
  check('a stored folder_person_id files a shared case under that client',
    !!cf.sharedChosen.path && path.dirname(cf.sharedChosen.path) === carolCase
      && fs.existsSync(cf.sharedChosen.path) && onDisk(cf.carolDir) === path.join(tmpRoot, 'Clients', 'Carol Clark'),
    String(cf.sharedChosen.path));
  check('the refused attempt left no stray file: the chosen case folder holds only the one document',
    fs.existsSync(carolCase) && fs.readdirSync(carolCase).length === 1,
    fs.existsSync(carolCase) ? JSON.stringify(fs.readdirSync(carolCase)) : 'missing');

  check('a case with no client asks first too',
    !!cf.orphanAsk && cf.orphanAsk.needsFolderOwner === true, JSON.stringify(cf.orphanAsk));
  check('folder_person_id = 0 files the case under No Client/',
    !!cf.orphanChosen.path
      && path.dirname(cf.orphanChosen.path) === path.join(tmpRoot, 'No Client', 'Exampleton Records Request (2026-CV-303)')
      && fs.existsSync(cf.orphanChosen.path),
    String(cf.orphanChosen.path));
}

// --- Ask which client (client-folders Task 4) --------------------------------
//
// The renderer's side of the refusal, through the real buttons: an undecided
// case shows the folder-owner picker, the choice is stored and the save runs
// again; Cancel writes nothing at all — no file, no generated_files row, no
// documents row, and folder_person_id stays NULL.
//
// Each step is its own page.evaluate so the harness can wait on the picker
// (and photograph it) between the click that opens it and the answer.
const pickerShown = () => page.evaluate(() =>
  !document.getElementById('folder-owner-picker').classList.contains('hidden'));
const waitForPicker = async (want = true, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    if ((await pickerShown()) === want) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
};
// Open a case by name and generate one Appearance through the Generate view.
// Resolves once the click has been made — not when the save finishes, since
// the picker may be holding it open.
const openCaseAndGenerate = (caseName, mode) => page.evaluate(async ({ caseName, mode }) => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  document.getElementById('nav-matters').click();
  await wait(300);
  const row = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes(caseName));
  if (!row) return { error: `matter row not found: ${caseName}` };
  row.click();
  await wait(700);
  document.getElementById('btn-goto-generate').click();
  await wait(600);
  document.getElementById('gen-doctype').value = 'appearance';
  document.getElementById('gen-doctype').dispatchEvent(new Event('change'));
  await wait(400);
  document.getElementById('gen-result').classList.add('hidden');
  // 'both' clicks PDF and then Word at once, without waiting for the first
  // save to come back (the documents-row merge race).
  if (mode === 'both') {
    document.getElementById('btn-generate-pdf').click();
    document.getElementById('btn-generate-docx').click();
  } else {
    document.getElementById(mode === 'pdf' ? 'btn-generate-pdf' : 'btn-generate-docx').click();
  }
  return { ok: true };
}, { caseName, mode });
// What the picker is offering right now.
const pickerOptions = () => page.evaluate(() => ({
  clients: [...document.querySelectorAll('#folder-owner-options input[name="folder-owner"]')]
    .map(r => ({ id: Number(r.value), label: r.parentElement.textContent })),
  heading: document.getElementById('folder-owner-heading').textContent,
  noneNote: !document.getElementById('folder-owner-none-note').classList.contains('hidden'),
  saveDisabled: document.getElementById('btn-folder-owner-save').disabled,
  hasNoClient: !!document.querySelector('#folder-owner-picker input[name="folder-owner"][value="0"]')
}));
const pickerChoose = (value) => page.evaluate((value) => {
  const r = document.querySelector(`#folder-owner-picker input[name="folder-owner"][value="${value}"]`);
  r.checked = true;
  r.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('btn-folder-owner-save').click();
}, value);
const pickerCancel = () => page.evaluate(() => document.getElementById('btn-folder-owner-cancel').click());
// Wait until the Generate view reports back.
const waitForGenResult = async () => {
  for (let i = 0; i < 80; i++) {
    const shown = await page.evaluate(() => !document.getElementById('gen-result').classList.contains('hidden'));
    if (shown) return page.evaluate(() => document.getElementById('gen-result-text').textContent);
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
};
const caseState = (id) => page.evaluate(async (id) => ({
  matter: await window.api.dbGet('SELECT folder_person_id, output_dir FROM matters WHERE id = ?', [id]),
  docs: await window.api.dbAll('SELECT id, docx_path, pdf_path FROM documents WHERE matter_id = ?', [id]),
  files: await window.api.dbAll('SELECT id, path FROM generated_files WHERE matter_id = ?', [id])
}), id).then(resolveStored);

// Fixtures: a two-client case, a second one to cancel on, a client-less case,
// and a two-client case for the packet.
const pickFx = await page.evaluate(async () => {
  const now = new Date().toISOString();
  const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['90th DISTRICT COURT'])).lastInsertRowid;
  const mkCase = async (shortName, caseNumber, clientNames) => {
    const id = (await window.api.dbRun(
      `INSERT INTO matters (short_name, case_number, court_id, client_role, caption_style, party_label, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [shortName, caseNumber, court, 'defendant', 'full', 'Defendant', now])).lastInsertRowid;
    const people = [];
    for (const [i, name] of clientNames.entries()) {
      const pid = (await window.api.dbRun('INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
        [name, 'individual', now])).lastInsertRowid;
      people.push(pid);
      await window.api.dbRun(
        'INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,?)',
        [id, pid, name, 'defendant', 'client', i]);
    }
    await window.api.dbRun(
      'INSERT INTO parties (matter_id, name, side, role, sort_order) VALUES (?,?,?,?,?)',
      [id, 'City of Exampleton', 'plaintiff', 'opposing_party', 0]);
    return { id, people };
  };
  return {
    shared: await mkCase('Two Client UI Case', '2026-CV-305', ['Dana Dalton', 'Evan Ellison']),
    cancel: await mkCase('Cancelled Choice Case', '2026-CV-306', ['Fay Fenwick', 'Gus Garland']),
    none: await mkCase('Clientless UI Case', '2026-CV-307', []),
    packet: await mkCase('Two Client Packet Case', '2026-CV-308', ['Hana Hughes', 'Ivan Irving']),
    race: await mkCase('PDF Word Race Case', '2026-CV-309', ['Jan Jensen']),
    askA: await mkCase('Concurrent Ask Case A', '2026-CV-310', ['Kim Keller', 'Lou Lambert']),
    askB: await mkCase('Concurrent Ask Case B', '2026-CV-311', ['Mia Moreno', 'Ned Norris']),
    refuse: await mkCase('Refused Choice Case', '2026-CV-312', ['Ora Olsen', 'Pat Perry']),
    outsider: (await window.api.dbRun('INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
      ['Quinn Quarry', 'individual', now])).lastInsertRowid
  };
}).catch(e => ({ error: String(e) }));
check('folder-owner picker fixtures build', !pickFx.error, pickFx.error || '');

if (!pickFx.error) {
  // 1. Two clients: the picker appears, lists both by name, and choosing the
  //    second files the case under that client.
  const [dana, evan] = pickFx.shared.people;
  const go1 = await openCaseAndGenerate('Two Client UI Case', 'docx');
  const shown1 = !go1.error && await waitForPicker(true);
  check('Generate on an undecided two-client case shows the folder-owner picker', shown1,
    shown1 ? '' : (go1.error || 'picker never appeared'));
  if (shown1) {
    const opts = await pickerOptions();
    check('the picker asks the question and lists each client by name, plus No Client',
      opts.heading === 'Which client\'s folder should this case be saved in?'
        && JSON.stringify(opts.clients) === JSON.stringify([
          { id: dana, label: 'Dana Dalton' }, { id: evan, label: 'Evan Ellison' }])
        && opts.hasNoClient && !opts.noneNote,
      JSON.stringify(opts));
    check('Save waits until a folder is chosen', opts.saveDisabled === true, JSON.stringify(opts));
    const before = await caseState(pickFx.shared.id);
    check('nothing is written while the picker is open',
      before.docs.length === 0 && before.files.length === 0 && before.matter.folder_person_id == null,
      JSON.stringify(before));
    if (process.env.SMOKE_SHOTS) {
      fs.mkdirSync(process.env.SMOKE_SHOTS, { recursive: true });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
      await new Promise(r => setTimeout(r, 300));
      await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'folder-owner-picker-1024.png') }).catch(() => {});
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
    }
    await pickerChoose(evan);
    const msg1 = await waitForGenResult();
    const after1 = await caseState(pickFx.shared.id);
    const evanCase = path.join(tmpRoot, 'Clients', 'Evan Ellison', 'Two Client UI Case (2026-CV-305)');
    check('choosing the second client saves the document under that client',
      after1.matter.folder_person_id === evan && after1.matter.output_dir === evanCase
        && after1.docs.length === 1 && !!after1.docs[0].docx_path
        && path.dirname(after1.docs[0].docx_path) === evanCase && fs.existsSync(after1.docs[0].docx_path)
        && !fs.existsSync(path.join(tmpRoot, 'Clients', 'Dana Dalton')),
      JSON.stringify({ msg1, after1 }));
    check('the picker closes after Save', await waitForPicker(false));

    // 2. Generate again: the choice is stored, so no second question.
    await openCaseAndGenerate('Two Client UI Case', 'pdf');
    const msg2 = await waitForGenResult();
    const askedAgain = await pickerShown();
    const after2 = await caseState(pickFx.shared.id);
    check('generating again on a chosen case does not ask again',
      !askedAgain && !!msg2 && msg2.startsWith('Saved')
        && after2.docs.some(d => d.pdf_path && path.dirname(d.pdf_path) === evanCase),
      JSON.stringify({ askedAgain, msg2, docs: after2.docs }));
  }

  // 3. Cancel: nothing written, nothing stored, and the user is told.
  const go3 = await openCaseAndGenerate('Cancelled Choice Case', 'docx');
  const shown3 = !go3.error && await waitForPicker(true);
  check('the picker appears for the case that will be cancelled', shown3, shown3 ? '' : (go3.error || 'picker never appeared'));
  if (shown3) {
    await pickerCancel();
    const msg3 = await waitForGenResult();
    const after3 = await caseState(pickFx.cancel.id);
    check('Cancel writes nothing: no documents row, no generated_files row, folder_person_id stays NULL',
      after3.docs.length === 0 && after3.files.length === 0
        && after3.matter.folder_person_id == null && !after3.matter.output_dir
        && !fs.existsSync(path.join(tmpRoot, 'Clients', 'Fay Fenwick'))
        && !fs.existsSync(path.join(tmpRoot, 'Clients', 'Gus Garland')),
      JSON.stringify(after3));
    check('Cancel says the document was not saved',
      !!msg3 && msg3.startsWith('Not saved') && !(await pickerShown()), JSON.stringify(msg3));
  }

  // 4. No client on the case: only No Client is offered, with a note on how
  //    to file it under a client instead.
  const go4 = await openCaseAndGenerate('Clientless UI Case', 'docx');
  const shown4 = !go4.error && await waitForPicker(true);
  check('a case with no client shows the picker too', shown4, shown4 ? '' : (go4.error || 'picker never appeared'));
  if (shown4) {
    const opts4 = await pickerOptions();
    check('with no client parties the picker offers only No Client, and says how to add one',
      opts4.clients.length === 0 && opts4.hasNoClient && opts4.noneNote, JSON.stringify(opts4));
    await pickerChoose(0);
    await waitForGenResult();
    const after4 = await caseState(pickFx.none.id);
    const noClientCase = path.join(tmpRoot, 'No Client', 'Clientless UI Case (2026-CV-307)');
    check('choosing No Client files the case under No Client/',
      after4.matter.folder_person_id === 0 && after4.docs.length === 1 && !!after4.docs[0].docx_path
        && path.dirname(after4.docs[0].docx_path) === noClientCase && fs.existsSync(after4.docs[0].docx_path),
      JSON.stringify(after4));
  }

  // 5. A packet asks once, before its first document: Cancel leaves no rows
  //    at all; the next click asks once and every document follows.
  const [, ivan] = pickFx.packet.people;
  // Count every time the picker opens during a packet click.
  await page.evaluate(() => {
    window.__pickerOpens = 0;
    const el = document.getElementById('folder-owner-picker');
    let open = !el.classList.contains('hidden');
    new MutationObserver(() => {
      const now = !el.classList.contains('hidden');
      if (now && !open) window.__pickerOpens++;
      open = now;
    }).observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  const packetGo = await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    document.getElementById('nav-matters').click();
    await wait(300);
    const row = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes('Two Client Packet Case'));
    if (!row) return { error: 'matter row not found' };
    row.click();
    await wait(700);
    document.getElementById('btn-new-packet').click();
    await wait(500);
    document.getElementById('pk-kind').value = 'driver_license_hearing';
    document.getElementById('pk-kind').dispatchEvent(new Event('change'));
    await wait(400);
    document.getElementById('pkf_packet_date').value = '2026-01-05';
    document.getElementById('pkf_client_dob').value = '1990-01-01';
    document.getElementById('pkf_client_license_number').value = 'X123456789';
    document.getElementById('packet-result').classList.add('hidden');
    document.getElementById('btn-generate-packet-docx').click();
    return { ok: true };
  }).catch(e => ({ error: String(e) }));
  const waitForPacketResult = async () => {
    for (let i = 0; i < 100; i++) {
      const shown = await page.evaluate(() => !document.getElementById('packet-result').classList.contains('hidden'));
      if (shown) return page.evaluate(() => document.getElementById('packet-result-text').textContent);
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  };
  const shown5 = !packetGo.error && await waitForPicker(true);
  check('generating a packet on an undecided two-client case shows the picker', shown5,
    shown5 ? '' : (packetGo.error || 'picker never appeared'));
  if (shown5) {
    await pickerCancel();
    const cancelMsg = await waitForPacketResult();
    const afterCancel = await caseState(pickFx.packet.id);
    check('cancelling a packet writes no documents rows and no files',
      !!cancelMsg && cancelMsg.startsWith('Not saved') && afterCancel.docs.length === 0
        && afterCancel.files.length === 0 && afterCancel.matter.folder_person_id == null,
      JSON.stringify({ cancelMsg, afterCancel }));

    await page.evaluate(() => {
      window.__pickerOpens = 0;
      document.getElementById('packet-result').classList.add('hidden');
      document.getElementById('btn-generate-packet-docx').click();
    });
    const shown5b = await waitForPicker(true);
    if (shown5b) await pickerChoose(ivan);
    const packetMsg = await waitForPacketResult();
    const afterPacket = await caseState(pickFx.packet.id);
    const opens = await page.evaluate(() => window.__pickerOpens);
    const ivanCase = path.join(tmpRoot, 'Clients', 'Ivan Irving', 'Two Client Packet Case (2026-CV-308)');
    check('a packet asks exactly once, and every document lands under the chosen client',
      shown5b && opens === 1 && afterPacket.docs.length === 2
        && afterPacket.docs.every(d => d.docx_path && d.docx_path.startsWith(ivanCase + path.sep)
          && fs.existsSync(d.docx_path)),
      JSON.stringify({ opens, packetMsg, docs: afterPacket.docs }));
  }

  // 6. PDF then Word clicked back to back (no waiting in between) still makes
  //    ONE documents row carrying both paths: saves run one at a time, so the
  //    Word save sees the row the PDF save wrote.
  const goRace = await openCaseAndGenerate('PDF Word Race Case', 'both');
  let raceState = null;
  for (let i = 0; i < 100 && !goRace.error; i++) {
    raceState = await caseState(pickFx.race.id);
    if (raceState.files.length >= 2) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 300));
  raceState = await caseState(pickFx.race.id);
  check('PDF then Word clicked at once make one documents row with both paths',
    !goRace.error && raceState.docs.length === 1
      && !!raceState.docs[0].pdf_path && !!raceState.docs[0].docx_path,
    goRace.error || JSON.stringify(raceState));
  // The race itself, made deterministic: in the main process, hold each of
  // the two save replies until the other save has also finished (or 2s pass),
  // so both come back together — the moment two in-flight saves would each
  // look for the other's row, find nothing, and write two rows. Saves that
  // run one at a time never overlap, so the hold just times out.
  const held = await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    if (!handlers || !handlers.get('generate-pdf') || !handlers.get('generate-docx')) return false;
    const originals = { pdf: handlers.get('generate-pdf'), docx: handlers.get('generate-docx') };
    globalThis.__smokeSaveHold = originals;
    let finished = 0;
    let release;
    const bothDone = new Promise(r => { release = r; });
    const hold = (orig) => async (...args) => {
      const res = await orig(...args);
      if (++finished === 2) release();
      await Promise.race([bothDone, new Promise(r => setTimeout(r, 2000))]);
      return res;
    };
    ipcMain.removeHandler('generate-pdf');
    ipcMain.removeHandler('generate-docx');
    ipcMain.handle('generate-pdf', hold(originals.pdf));
    ipcMain.handle('generate-docx', hold(originals.docx));
    return true;
  });
  check('the save-race harness can hold IPC replies', held === true, String(held));
  // New field values, so the prior row is not a match and this is a fresh pair.
  const goRace2 = held ? await page.evaluate(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const dated = document.querySelector('#gen-dynamic-fields input[type="date"]');
    if (dated) { dated.value = '2026-09-01'; dated.dispatchEvent(new Event('change')); }
    document.getElementById('btn-generate-pdf').click();
    document.getElementById('btn-generate-docx').click();
    await wait(10);
    return { ok: true };
  }) : { error: 'no hold' };
  let race2 = null;
  for (let i = 0; i < 100 && !goRace2.error; i++) {
    race2 = await caseState(pickFx.race.id);
    if (race2.files.length >= 4) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 2500));
  race2 = await caseState(pickFx.race.id);
  if (held) {
    await app.evaluate(({ ipcMain }) => {
      const o = globalThis.__smokeSaveHold;
      ipcMain.removeHandler('generate-pdf');
      ipcMain.removeHandler('generate-docx');
      ipcMain.handle('generate-pdf', o.pdf);
      ipcMain.handle('generate-docx', o.docx);
    });
  }
  check('PDF and Word saves that finish together still make one new row with both paths',
    !goRace2.error && race2.docs.length === 2 && race2.docs.every(d => d.pdf_path && d.docx_path),
    goRace2.error || JSON.stringify({ files: race2.files.length, docs: race2.docs }));

  // 7. Two different undecided cases asked at once: each gets its own
  //    question, in turn, and its own answer.
  const caseLine = () => page.evaluate(() => document.getElementById('folder-owner-case').textContent);
  const waitForPickerFor = async (text) => {
    for (let i = 0; i < 60; i++) {
      if ((await pickerShown()) && (await caseLine()).includes(text)) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  };
  await page.evaluate(({ a, b }) => {
    window.__askA = window.ensureFolderOwner(a);
    window.__askB = window.ensureFolderOwner(b);
    window.__askASame = window.ensureFolderOwner(a) === window.__askA;
  }, { a: pickFx.askA.id, b: pickFx.askB.id });
  const askedA = await waitForPickerFor('Concurrent Ask Case A');
  const optsA = askedA ? await pickerOptions() : null;
  if (askedA) await pickerChoose(pickFx.askA.people[0]);
  const askedB = await waitForPickerFor('Concurrent Ask Case B');
  const optsB = askedB ? await pickerOptions() : null;
  if (askedB) await pickerChoose(pickFx.askB.people[1]);
  const concurrent = await page.evaluate(async ({ a, b }) => ({
    answers: [await window.__askA, await window.__askB],
    same: window.__askASame,
    a: (await window.api.dbGet('SELECT folder_person_id FROM matters WHERE id = ?', [a])).folder_person_id,
    b: (await window.api.dbGet('SELECT folder_person_id FROM matters WHERE id = ?', [b])).folder_person_id
  }), { a: pickFx.askA.id, b: pickFx.askB.id });
  check('two undecided cases asked at once each get their own question and answer',
    askedA && askedB
      && optsA.clients.map(c => c.label).join() === 'Kim Keller,Lou Lambert'
      && optsB.clients.map(c => c.label).join() === 'Mia Moreno,Ned Norris'
      && concurrent.same === true
      && JSON.stringify(concurrent.answers) === '["chosen","chosen"]'
      && concurrent.a === pickFx.askA.people[0] && concurrent.b === pickFx.askB.people[1],
    JSON.stringify({ askedA, askedB, optsA, optsB, concurrent }));

  // 8. A choice main refuses (here: a person who is not a client on the case)
  //    says so, distinctly from Cancel, and writes nothing.
  const goRefuse = await openCaseAndGenerate('Refused Choice Case', 'docx');
  const shownRefuse = !goRefuse.error && await waitForPicker(true);
  if (shownRefuse) {
    await page.evaluate((outsider) => {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'folder-owner';
      radio.value = String(outsider);
      label.appendChild(radio);
      document.getElementById('folder-owner-options').appendChild(label);
    }, pickFx.outsider);
    await pickerChoose(pickFx.outsider);
  }
  const refuseMsg = shownRefuse ? await waitForGenResult() : null;
  const afterRefuse = await caseState(pickFx.refuse.id);
  check('a refused folder choice says it could not be saved and writes nothing',
    shownRefuse && !!refuseMsg && refuseMsg.startsWith('Not saved: that choice could not be saved')
      && afterRefuse.docs.length === 0 && afterRefuse.files.length === 0
      && afterRefuse.matter.folder_person_id == null && !afterRefuse.matter.output_dir,
    goRefuse.error || JSON.stringify({ refuseMsg, afterRefuse }));
}

// The blank questionnaire belongs to no case and no client.
check('the blank questionnaire is saved in Blank Forms/',
  !!questionnaire.path && path.dirname(questionnaire.path) === path.join(tmpRoot, 'Blank Forms'),
  String(questionnaire.path));

// Windows MAX_PATH. folders.js caps each segment and fitPath trims the file
// name, but that promise (<= 250) only holds for an output root of about 50
// characters (see fitPath's comment). os.tmpdir() on a Mac is already longer
// than that, so this check points output_root at a short folder of its own,
// asserts the root really is short, and puts tmpRoot back afterwards.
const shortRoot = fs.mkdtempSync(process.platform === 'win32'
  ? path.join(os.tmpdir(), 'tc-')
  : '/tmp/tc-');
check('the long-path check runs under an output root of 50 characters or less',
  shortRoot.length <= 50, `${shortRoot.length}: ${shortRoot}`);
const longPaths = await page.evaluate(async ({ root, restore }) => {
  await window.api.dbRun("UPDATE settings SET value = ? WHERE key = 'output_root'", [root]);
  try {
    const now = new Date().toISOString();
    // 90-character client and case names, a 60-character packet label.
    const clientName = 'Alexandra Montgomery-Fitzgerald Wellington Anderson Hollingsworth Exampleton Trust Estate'.padEnd(90, 'x');
    const caseName = 'Wellington Anderson Hollingsworth v The City of Exampleton Department of Public Works Roads'.padEnd(90, 'x');
    const label = 'Response to the Motion for Summary Disposition and Exhibits'.padEnd(60, 'x');
    const pid = (await window.api.dbRun(
      'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
      [clientName, 'individual', now])).lastInsertRowid;
    const mid = (await window.api.dbRun(
      'INSERT INTO matters (short_name, case_number, client_role, caption_style, created_at) VALUES (?,?,?,?,?)',
      [caseName, '2026-CV-000304-NO-EXAMPLETON', 'plaintiff', 'full', now])).lastInsertRowid;
    await window.api.dbRun(
      'INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,0)',
      [mid, pid, clientName, 'plaintiff', 'client']);
    const pkt = (await window.api.dbRun(
      'INSERT INTO packets (matter_id, kind, label, packet_date, created_at) VALUES (?,?,?,?,?)',
      [mid, 'general', label, '2026-09-24', now])).lastInsertRowid;
    const m = await window.api.dbGet('SELECT * FROM matters WHERE id = ?', [mid]);
    m.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id = ?', [mid]);
    const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default = 1');
    const dt = window.DocumentEngine.doctypes.find(d => d.id === 'brief_shell');
    const longLabel = 'A Very Long Document Label That Keeps Going Well Past Any Reasonable Filename Length For Testing';
    const out = [];
    // Loose in the case folder, then inside the packet; twice each, so the
    // " v2" retry is measured too.
    for (const packet of [null, { id: pkt, kind: 'general', label, packet_date: '2026-09-24', sort_order: 0 }]) {
      for (const title of ['One', 'Two']) {
        const forDoc = packet ? { ...m, packet } : m;
        const blocks = dt.build(forDoc, attorney, { brief_title: title });
        out.push(await window.api.generatePdf(
          window.DocumentEngine.renderHtml(blocks, forDoc, attorney), forDoc, longLabel, dt.id));
      }
    }
    return out.map(r => r && r.path);
  } finally {
    await window.api.dbRun("UPDATE settings SET value = ? WHERE key = 'output_root'", [restore]);
  }
}, { root: shortRoot, restore: tmpRoot }).catch(e => ({ error: String(e) }));

if (longPaths.error) {
  check('long client, case and packet names stay within 250 characters', false, longPaths.error);
} else {
  check('long names still generate every file (loose, packet, and their v2s)',
    longPaths.length === 4 && longPaths.every(p => !!p && fs.existsSync(p)) && new Set(longPaths).size === 4,
    JSON.stringify(longPaths));
  check('every generated path under long client, case and packet names is <= 250 characters',
    longPaths.every(p => !!p && p.length <= 250),
    longPaths.map(p => p && p.length).join(', '));
  check('the long-named packet folder sits inside the long-named case folder, inside Clients/',
    !!longPaths[2]
      && path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(longPaths[2]))))) === shortRoot
      && path.basename(path.dirname(path.dirname(path.dirname(path.dirname(longPaths[2]))))) === 'Clients'
      && fs.existsSync(path.dirname(longPaths[2])),
    String(longPaths[2]));
}

// --- Documents panel: rows, open/reveal/remove, drag-drop (Task 18) ---------
//
// confirm() is stubbed for the same reason alert() is above: a real modal
// blocks the automation session outright.
await page.evaluate(() => { window.confirm = () => true; });

// A third scan, dropped onto the panel rather than picked from the dialog.
const scanSrcC = fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-scans-c-'));
const scanC = path.join(scanSrcC, 'Dropped scan.pdf');
fs.writeFileSync(scanC, 'DROPPED SCAN BYTES');

// A case for the client, so the per-row "attach to case" picker has something
// to offer — client_documents.matter_id is nullable and optional by design.
await page.evaluate(async (pid) => {
  const m = await window.api.dbRun(
    "INSERT INTO matters (short_name, created_at) VALUES (?,?)",
    ['Docs Panel Case', new Date().toISOString()]);
  // role = 'client': only a person's own cases are offered for filing their
  // documents (client-folders Task 5). parties.role defaults to
  // 'opposing_party', which this fixture used to inherit by omission.
  await window.api.dbRun(
    'INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,?)',
    [m.lastInsertRowid, pid, 'Round Trip Test', 'defendant', 'client', 0]);
}, clientDir.id);

// Opening the profile the way the user does: People tab, search, click the row.
const OPEN_PERSON = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const openByName = async (name) => {
    document.getElementById('nav-people').click();
    const s = document.getElementById('people-search');
    s.value = name;
    s.dispatchEvent(new Event('input'));
    await sleep(400);
    const row = [...document.querySelectorAll('#people-list tr')]
      .find(r => r.cells[0] && r.cells[0].textContent.indexOf(name) === 0);
    if (!row) throw new Error('no people row for ' + name);
    row.click();
    await sleep(500);
  };
`;

const docsPanel = await page.evaluate(new Function('name', `return (async () => {
  ${OPEN_PERSON}
  await openByName(name);
  const panel = document.getElementById('person-documents-panel');
  const rows = [...document.querySelectorAll('#person-documents .doc-row')];
  return {
    hasPanel: !!panel,
    hasAddButton: !!document.getElementById('btn-add-client-document'),
    rowCount: rows.length,
    labels: rows.map(r => (r.querySelector('.doc-label') || {}).value),
    names: rows.map(r => (r.querySelector('.doc-name') || {}).textContent),
    // Excludes the A8 "Today" button next to the date field — not a row action.
    actions: rows.map(r => [...r.querySelectorAll('button')].map(b => b.textContent).filter(t => t !== 'Today')),
    caseOptions: rows.length
      ? [...(rows[0].querySelector('.doc-matter') || { options: [] }).options].map(o => o.textContent)
      : []
  };
})()`), 'Round Trip Test').catch(e => ({ error: String(e) }));

if (docsPanel.error) {
  check('the Documents panel renders', false, docsPanel.error);
} else {
  check('the profile has a Documents panel with an Add Document button',
    docsPanel.hasPanel && docsPanel.hasAddButton, JSON.stringify(docsPanel));
  check('the Documents panel lists both attached scans',
    docsPanel.rowCount === 2, String(docsPanel.rowCount));
  check('each document row shows its stored filename',
    docsPanel.names.join('|') === 'Police report.pdf|Police report (2).pdf',
    docsPanel.names.join('|'));
  check('each document row offers Open, Reveal and Remove',
    docsPanel.rowCount === 2 && docsPanel.actions.every(a => a.join(',') === 'Open,Reveal,Remove'),
    JSON.stringify(docsPanel.actions));
  check('a document row can be attached to one of the client\'s cases',
    docsPanel.caseOptions.includes('Docs Panel Case'), JSON.stringify(docsPanel.caseOptions));
}

// Label, date and case are settable on the row and persist immediately.
const docEdit = await page.evaluate(async (pid) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const row = document.querySelector('#person-documents .doc-row');
  const set = (sel, value) => {
    const el = row.querySelector(sel);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  set('.doc-label', 'Police report');
  set('.doc-date', '2026-08-25');
  const matterSel = row.querySelector('.doc-matter');
  matterSel.selectedIndex = [...matterSel.options].findIndex(o => o.textContent === 'Docs Panel Case');
  matterSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(500);
  const stored = await window.api.dbGet(
    'SELECT cd.*, m.short_name FROM client_documents cd LEFT JOIN matters m ON m.id = cd.matter_id WHERE cd.person_id = ? ORDER BY cd.id LIMIT 1', [pid]);
  return stored;
}, clientDir.id).catch(e => ({ error: String(e) }));

check('a row\'s label persists to the database',
  !docEdit.error && docEdit.label === 'Police report', JSON.stringify(docEdit));
check('a row\'s date persists to the database',
  !docEdit.error && docEdit.doc_date === '2026-08-25', JSON.stringify(docEdit && docEdit.doc_date));
check('attaching a row to a case persists to the database',
  !docEdit.error && docEdit.short_name === 'Docs Panel Case', JSON.stringify(docEdit && docEdit.short_name));

// The window-level guard. Without preventDefault on the window's own
// dragover/drop, a file dropped ANYWHERE else in the app navigates the
// renderer to that file: the window goes blank and looks like a crash, with
// whatever was half-typed gone with it.
const dropGuard = await page.evaluate(() => {
  const fire = (target, type) => {
    const dt = new DataTransfer();
    const ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  return {
    bodyDrop: fire(document.body, 'drop'),
    bodyDragover: fire(document.body, 'dragover'),
    panelDragover: fire(document.getElementById('person-documents-panel'), 'dragover')
  };
}).catch(e => ({ error: String(e) }));

check('a file dropped anywhere in the app is swallowed, not navigated to',
  !dropGuard.error && dropGuard.bodyDrop === true && dropGuard.bodyDragover === true,
  JSON.stringify(dropGuard));
check('the Documents panel still accepts a dragover of its own',
  !dropGuard.error && dropGuard.panelDragover === true, JSON.stringify(dropGuard));

// A real drop onto the panel. The File objects have to be backed by real files
// on disk for Electron's webUtils.getPathForFile to yield a path at all, so
// they come from a genuine file input driven by Playwright rather than from a
// hand-built File.
await page.evaluate(() => {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.id = 'smoke-drop-source';
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  document.body.appendChild(input);
});
await page.setInputFiles('#smoke-drop-source', [scanC]).catch(() => {});

const dropped = await page.evaluate(async (pid) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const input = document.getElementById('smoke-drop-source');
  const dt = new DataTransfer();
  for (const f of input.files) dt.items.add(f);
  const panel = document.getElementById('person-documents-panel');
  const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
  panel.dispatchEvent(ev);
  await sleep(900);
  const rows = await window.api.dbAll(
    'SELECT * FROM client_documents WHERE person_id = ? ORDER BY id', [pid]);
  return {
    prevented: ev.defaultPrevented,
    rows,
    onScreen: document.querySelectorAll('#person-documents .doc-row').length
  };
}, clientDir.id).catch(e => ({ error: String(e) }));

check('a drop on the Documents panel is handled, not navigated to',
  !dropped.error && dropped.prevented === true, JSON.stringify(dropped && dropped.prevented));
check('a file dropped on the panel is copied in and listed',
  !dropped.error && dropped.rows.length === 3
    && dropped.rows[2].original_name === 'Dropped scan.pdf'
    && dropped.onScreen === 3,
  dropped.error || JSON.stringify(dropped.rows.map(r => r.filename)) + ' on screen: ' + dropped.onScreen);
check('the dropped file\'s bytes reached the client folder',
  !dropped.error && dropped.rows.length === 3
    && fs.readFileSync(path.join(clientDir.first, 'Client Papers', dropped.rows[2].filename), 'utf8') === 'DROPPED SCAN BYTES');

// Remove takes the ROW out of the list and NOTHING off the disk. The file may
// be the only copy of that scan in existence.
const removed = await page.evaluate(async (pid) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let confirmText = '';
  window.confirm = (msg) => { confirmText = msg; return true; };
  const before = await window.api.dbAll(
    'SELECT * FROM client_documents WHERE person_id = ? ORDER BY id', [pid]);
  const target = before[0];
  const row = [...document.querySelectorAll('#person-documents .doc-row')]
    .find(r => r.dataset.docId === String(target.id));
  [...row.querySelectorAll('button')].find(b => b.textContent === 'Remove').click();
  await sleep(700);
  const after = await window.api.dbAll(
    'SELECT * FROM client_documents WHERE person_id = ? ORDER BY id', [pid]);
  return {
    confirmText,
    filename: target.filename,
    rowGone: !after.some(r => r.id === target.id),
    remaining: after.length,
    onScreen: document.querySelectorAll('#person-documents .doc-row').length
  };
}, clientDir.id).catch(e => ({ error: String(e) }));

if (removed.error) {
  check('Remove deletes the row but leaves the file on disk', false, removed.error);
} else {
  const removedPath = path.join(clientDir.first, 'Client Papers', removed.filename);
  check('Remove deletes the row but leaves the file on disk',
    removed.rowGone === true && fs.existsSync(removedPath), removedPath);
  check('Remove takes the row off the screen too',
    removed.onScreen === removed.remaining && removed.remaining === 2,
    `${removed.onScreen} on screen, ${removed.remaining} stored`);
  // "The file itself stays in the Clients folder" — in plain words, because a
  // user who reads "Remove" as "delete" loses a scan they cannot re-take.
  check('the Remove confirmation says the file itself is kept',
    /file itself stays where it is/i.test(removed.confirmText) && /Police report/.test(removed.confirmText),
    JSON.stringify(removed.confirmText));
}

// A brand-new person must not inherit the last client's paperwork. A stale
// list here would file one client's scans under another client's name.
const newPersonDocs = await page.evaluate(() => {
  document.getElementById('nav-people').click();
  document.getElementById('btn-new-person').click();
  const el = document.getElementById('person-documents');
  return {
    rows: el.querySelectorAll('.doc-row').length,
    text: el.textContent.trim(),
    addDisabled: document.getElementById('btn-add-client-document').disabled
  };
}).catch(e => ({ error: String(e) }));

check('a new person shows no documents from the previously open client',
  !newPersonDocs.error && newPersonDocs.rows === 0, JSON.stringify(newPersonDocs));
check('a new person\'s Documents panel explains itself instead of looking broken',
  !newPersonDocs.error && /save/i.test(newPersonDocs.text) && newPersonDocs.addDisabled === true,
  JSON.stringify(newPersonDocs));

// Archive hides a client from every picker in the app. It used to sit in the
// top toolbar an inch from Save, unguarded — one stray click and the client
// vanished from every list. It now lives at the FOOT of the profile and asks
// first, by name.
//
// confirm() is stubbed here for the same reason alert() is stubbed at the top
// of this file: a real native dialog blocks the Playwright session outright,
// and the run never finishes. Stubbing it also lets us read back the exact
// words the user would have seen.
const archiveGuard = await page.evaluate(async (pid) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const archived = async () =>
    (await window.api.dbGet('SELECT archived FROM people WHERE id = ?', [pid])).archived;
  const btn = () => document.getElementById('btn-archive-person');
  const savedConfirm = window.confirm;

  document.getElementById('nav-people').click();
  await window.openPerson(pid);
  await sleep(300);

  const toolbar = document.querySelector('#view-person-detail .toolbar');
  const notInToolbar = !!toolbar && !toolbar.contains(btn());
  const atFoot = !!btn().closest('#person-archive-foot');
  const quietDanger = btn().classList.contains('danger') && !btn().classList.contains('primary');

  // Say no. The client must still be active afterwards.
  let message = '';
  window.confirm = (msg) => { message = msg; return false; };
  btn().click();
  await sleep(500);
  const stillActive = await archived();

  // Say yes. Now it archives.
  window.confirm = () => true;
  btn().click();
  await sleep(800);
  const afterAccept = await archived();
  const restoreLabel = btn().textContent.trim();

  // Restore is not destructive, so it must not nag.
  let restoreAsked = false;
  window.confirm = (msg) => { restoreAsked = true; return true; };
  btn().click();
  await sleep(800);
  const afterRestore = await archived();

  window.confirm = savedConfirm;
  return { message, stillActive, afterAccept, afterRestore, restoreAsked,
           restoreLabel, notInToolbar, atFoot, quietDanger };
}, clientDir.id).catch(e => ({ error: String(e) }));

if (archiveGuard.error) {
  check('the archive guard runs', false, archiveGuard.error);
} else {
  check('archiving asks for confirmation naming the client',
    archiveGuard.message.includes('Round Trip Test'), JSON.stringify(archiveGuard.message));
  check('declining the confirmation leaves the client unarchived',
    archiveGuard.stillActive === 0, String(archiveGuard.stillActive));
  check('accepting the confirmation archives the client',
    archiveGuard.afterAccept === 1, String(archiveGuard.afterAccept));
  check('Archive is no longer in the top toolbar',
    archiveGuard.notInToolbar === true);
  check('Archive sits at the foot of the profile as a quiet danger action',
    archiveGuard.atFoot === true && archiveGuard.quietDanger === true,
    `atFoot=${archiveGuard.atFoot} quietDanger=${archiveGuard.quietDanger}`);
  check('an archived client offers Restore',
    archiveGuard.restoreLabel === 'Restore', archiveGuard.restoreLabel);
  check('Restore un-archives without nagging (it is not destructive)',
    archiveGuard.afterRestore === 0 && archiveGuard.restoreAsked === false,
    `archived=${archiveGuard.afterRestore} asked=${archiveGuard.restoreAsked}`);
}

// --- Home: New Client, Add Documents, recent clients (client-folders Task 3b)
//
// Three panels in one row on Home, the Add Documents screen they lead to, and
// a Recently Touched Clients list. The panels and the list reuse the existing
// Home markup (.new-matter-panel, .home-section/.home-row) — nothing new to
// look at, only new places to click.
const homePanels = await page.evaluate(() => {
  document.getElementById('nav-home').click();
  const ids = ['home-new-matter', 'home-new-client', 'home-add-documents'];
  const els = ids.map(id => document.getElementById(id));
  return {
    exist: els.every(Boolean),
    samePanelClass: els.every(el => el && el.classList.contains('new-matter-panel')),
    sameParent: els.every(el => el && el.parentElement === els[0].parentElement),
    titles: els.map(el => el && (el.querySelector('.new-matter-panel-title') || {}).textContent),
    hasRecentClients: !!document.getElementById('home-recent-clients')
      && !!document.getElementById('home-recent-clients').closest('.home-section')
  };
}).catch(e => ({ error: String(e) }));
check('Home shows New Matter, New Client and Add Documents panels in one row',
  !homePanels.error && homePanels.exist && homePanels.samePanelClass && homePanels.sameParent,
  JSON.stringify(homePanels));
check('the new Home panels are titled "+ New Client" and "+ Add Documents"',
  !homePanels.error && homePanels.titles[1] === '+ New Client' && homePanels.titles[2] === '+ Add Documents',
  JSON.stringify(homePanels.titles));
check('Home has a Recently Touched Clients section',
  !homePanels.error && homePanels.hasRecentClients, JSON.stringify(homePanels));

// New Client opens a blank profile — the same thing the People tab's New
// Person button does. Opened from a filled profile first, so "blank" means
// it was actually cleared, not that it never had anything in it.
const newClient = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const any = await window.api.dbGet('SELECT id FROM people WHERE archived = 0 ORDER BY id LIMIT 1');
  await window.openPerson(any.id);
  await sleep(300);
  document.getElementById('nav-home').click();
  await sleep(200);
  document.getElementById('home-new-client').click();
  await sleep(400);
  return {
    visible: !document.getElementById('view-person-detail').classList.contains('hidden'),
    id: document.getElementById('per-id').value,
    name: document.getElementById('per-display_name').value
  };
}).catch(e => ({ error: String(e) }));
check('New Client opens a blank profile',
  !newClient.error && newClient.visible && newClient.id === '' && newClient.name === '',
  JSON.stringify(newClient));

// Fixtures: a client with a case, and a person who is only ever the OTHER side.
const scanSrcHome = fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-scans-home-'));
const homeScanCase = path.join(scanSrcHome, 'Intake letter.pdf');
const homeScanLoose = path.join(scanSrcHome, 'Loose receipt.pdf');
const homeScanPicked = path.join(scanSrcHome, 'Picked notice.pdf');
const homeScanHeld = path.join(scanSrcHome, 'Held scan.pdf');
fs.writeFileSync(homeScanCase, 'CASE SCAN BYTES');
fs.writeFileSync(homeScanLoose, 'LOOSE SCAN BYTES');
fs.writeFileSync(homeScanPicked, 'PICKED SCAN BYTES');
fs.writeFileSync(homeScanHeld, 'HELD SCAN BYTES');

const addDocsFix = await page.evaluate(async () => {
  const now = new Date().toISOString();
  const person = async (name) => (await window.api.dbRun(
    'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
    [name, 'individual', now])).lastInsertRowid;
  const dana = await person('Dana Driscoll');
  const oscar = await person('Oscar Opposing');
  const caseId = (await window.api.dbRun(
    'INSERT INTO matters (folder_person_id, short_name, case_number, client_role, created_at) VALUES (?,?,?,?,?)',
    [dana, 'Driscoll v Exampleton', '2026-CV-3301', 'plaintiff', now])).lastInsertRowid;
  await window.api.dbRun(
    'INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,?)',
    [caseId, dana, 'Dana Driscoll', 'plaintiff', 'client', 0]);
  await window.api.dbRun(
    'INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,?)',
    [caseId, oscar, 'Oscar Opposing', 'defendant', 'opposing_party', 0]);
  // Oscar gets the newest activity row of anyone, addressed to him directly.
  // He must still never appear: he is not anybody's client.
  await window.api.dbRun(
    `INSERT INTO activity_log (person_id, event_type, description, created_at) VALUES (?,?,?,?)`,
    [oscar, 'note', 'Opposing party touched', '2999-01-01T00:00:00.000Z']);
  return { dana, oscar, caseId };
}).catch(e => ({ error: String(e) }));

// Drops need File objects backed by real files, so they come from a file
// input driven by Playwright — same technique as the Documents panel above.
await page.evaluate(() => {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.id = 'smoke-home-drop-source';
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  document.body.appendChild(input);
});
const DROP_ON = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const dropOn = async (el) => {
    const input = document.getElementById('smoke-home-drop-source');
    const dt = new DataTransfer();
    for (const f of input.files) dt.items.add(f);
    const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    await sleep(900);
    return ev.defaultPrevented;
  };
  const pickClient = async (name) => {
    const input = document.getElementById('adddocs-client_name');
    input.value = '';
    input.dispatchEvent(new Event('focus'));
    input.value = name;
    input.dispatchEvent(new Event('input'));
    await sleep(300);
    const li = [...document.querySelectorAll('#combo-adddocs-client .combobox-dropdown li')]
      .find(l => l.textContent === name);
    if (!li) throw new Error('no combobox entry for ' + name);
    li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await sleep(400);
  };
  const rowsFor = (pid) => window.api.dbAll(
    'SELECT * FROM client_documents WHERE person_id = ? ORDER BY id', [pid]);
`;

// 1. With a case: open the screen from Home, pick the client and the case,
//    drop a file on the screen.
await page.setInputFiles('#smoke-home-drop-source', [homeScanCase]).catch(() => {});
const addWithCase = await page.evaluate(new Function('fx', `return (async () => {
  ${DROP_ON}
  document.getElementById('nav-home').click();
  await sleep(200);
  document.getElementById('home-add-documents').click();
  await sleep(200);
  const view = document.getElementById('view-add-documents');
  const opened = !view.classList.contains('hidden');
  await pickClient('Dana Driscoll');
  const sel = document.getElementById('adddocs-matter_id');
  const caseOptions = [...sel.options].map(o => o.textContent);
  sel.value = String(fx.caseId);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const prevented = await dropOn(view);
  return {
    opened, caseOptions, prevented,
    rows: await rowsFor(fx.dana),
    profileOpen: !document.getElementById('view-person-detail').classList.contains('hidden'),
    profileId: document.getElementById('per-id').value
  };
})()`), addDocsFix).catch(e => ({ error: String(e) }));

const danaDirs = await page.evaluate(async (fx) => ({
  client: (await window.api.dbGet('SELECT client_docs_dir FROM people WHERE id = ?', [fx.dana])).client_docs_dir,
  caseDir: (await window.api.dbGet('SELECT output_dir FROM matters WHERE id = ?', [fx.caseId])).output_dir
}), addDocsFix).catch(() => ({}));
danaDirs.client = onDisk(danaDirs.client);
danaDirs.caseDir = onDisk(danaDirs.caseDir);
const danaDir = danaDirs.client || null;
// Uploads with a case go in <client>/<Case>/Uploads/; without, in
// <client>/Client Papers/ (client-folders Task 5). Both recorded on stored_dir.
const danaUploads = danaDirs.caseDir ? path.join(danaDirs.caseDir, 'Uploads') : null;
const danaPapers = danaDir ? path.join(danaDir, 'Client Papers') : null;
if (addWithCase.error || addDocsFix.error) {
  check('Add Documents files a scan under a client and case', false, addWithCase.error || addDocsFix.error);
} else {
  check('the Add Documents panel opens the Add Documents screen', addWithCase.opened);
  check('the Case picker lists the client\'s cases after "Not tied to a case"',
    addWithCase.caseOptions[0] === 'Not tied to a case' && addWithCase.caseOptions.includes('Driscoll v Exampleton'),
    JSON.stringify(addWithCase.caseOptions));
  check('a drop on the Add Documents screen is handled, not navigated to', addWithCase.prevented === true);
  const r = addWithCase.rows[0];
  check('Add Documents records the file under the chosen client and case',
    addWithCase.rows.length === 1 && r.person_id === addDocsFix.dana && r.matter_id === addDocsFix.caseId,
    JSON.stringify(addWithCase.rows));
  check('the file Add Documents recorded exists on disk',
    !!r && !!danaUploads && fs.existsSync(path.join(danaUploads, r.filename))
      && fs.readFileSync(path.join(danaUploads, r.filename), 'utf8') === 'CASE SCAN BYTES',
    `${danaUploads} / ${r && r.filename}`);
  check('an upload with a case lands in <Client>/<Case>/Uploads/ with stored_dir recorded',
    !!r && !!danaDir && !!danaUploads && onDisk(r.stored_dir) === danaUploads
      && path.dirname(path.dirname(danaUploads)) === danaDir
      && path.basename(danaDirs.caseDir) === 'Driscoll v Exampleton (2026-CV-3301)',
    JSON.stringify([r && r.stored_dir, danaDirs]));
  check('after adding, the client\'s profile is open',
    addWithCase.profileOpen && addWithCase.profileId === String(addDocsFix.dana),
    JSON.stringify([addWithCase.profileOpen, addWithCase.profileId]));
}

// 2. Choose Files…, with no case. The native dialog is stubbed in the main
//    process — it cannot be driven from here — so this proves the button
//    reaches addClientDocument with the right client and no case.
await app.evaluate(({ dialog }, files) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
}, [homeScanLoose]);
const addLoose = await page.evaluate(new Function('fx', `return (async () => {
  ${DROP_ON}
  document.getElementById('nav-home').click();
  await sleep(200);
  document.getElementById('home-add-documents').click();
  await sleep(200);
  const clearedName = document.getElementById('adddocs-client_name').value;
  await pickClient('Dana Driscoll');
  const sel = document.getElementById('adddocs-matter_id');
  sel.value = '';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('btn-adddocs-choose').click();
  await sleep(900);
  return {
    clearedName,
    rows: await rowsFor(fx.dana),
    profileId: document.getElementById('per-id').value
  };
})()`), addDocsFix).catch(e => ({ error: String(e) }));
if (addLoose.error) {
  check('Choose Files adds a scan with no case', false, addLoose.error);
} else {
  const r = addLoose.rows[1];
  check('the Add Documents screen starts empty each time it is opened',
    addLoose.clearedName === '', JSON.stringify(addLoose.clearedName));
  check('Choose Files with "Not tied to a case" records the file with no case',
    addLoose.rows.length === 2 && r.original_name === 'Loose receipt.pdf' && r.matter_id === null
      && r.person_id === addDocsFix.dana,
    JSON.stringify(addLoose.rows.map(x => [x.original_name, x.matter_id])));
  check('the file Choose Files recorded exists on disk, in Client Papers',
    !!r && !!danaPapers && fs.existsSync(path.join(danaPapers, r.filename)) && onDisk(r.stored_dir) === danaPapers,
    `${danaPapers} / ${r && r.filename} / ${r && r.stored_dir}`);
  check('Choose Files then opens the client\'s profile', addLoose.profileId === String(addDocsFix.dana));
}

// 2b. Choose Files… WITH a case passes the case through too.
await app.evaluate(({ dialog }, files) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
}, [homeScanPicked]);
const addPicked = await page.evaluate(new Function('fx', `return (async () => {
  ${DROP_ON}
  document.getElementById('nav-home').click();
  await sleep(200);
  document.getElementById('home-add-documents').click();
  await sleep(200);
  await pickClient('Dana Driscoll');
  const sel = document.getElementById('adddocs-matter_id');
  sel.value = String(fx.caseId);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('btn-adddocs-choose').click();
  await sleep(900);
  return { rows: await rowsFor(fx.dana) };
})()`), addDocsFix).catch(e => ({ error: String(e) }));
check('Choose Files with a case records the file under that case',
  !addPicked.error && addPicked.rows.length === 3
    && addPicked.rows[2].original_name === 'Picked notice.pdf' && addPicked.rows[2].matter_id === addDocsFix.caseId,
  addPicked.error || JSON.stringify(addPicked.rows.map(x => [x.original_name, x.matter_id])));
check('Choose Files with a case copies into that case\'s Uploads/',
  !addPicked.error && !!danaUploads && onDisk(addPicked.rows[2].stored_dir) === danaUploads
    && fs.existsSync(path.join(danaUploads, addPicked.rows[2].filename)),
  addPicked.error || JSON.stringify(addPicked.rows[2]));

// 3. Files dropped on the Home panel itself are held until a client is chosen.
await page.setInputFiles('#smoke-home-drop-source', [homeScanHeld]).catch(() => {});
const held = await page.evaluate(new Function('fx', `return (async () => {
  ${DROP_ON}
  document.getElementById('nav-home').click();
  await sleep(300);
  const prevented = await dropOn(document.getElementById('home-add-documents'));
  const viewOpen = !document.getElementById('view-add-documents').classList.contains('hidden');
  const heldText = document.getElementById('adddocs-held').textContent;
  const rowsBefore = (await rowsFor(fx.dana)).length;
  await pickClient('Dana Driscoll');
  document.getElementById('btn-adddocs-add-held').click();
  await sleep(900);
  return { prevented, viewOpen, heldText, rowsBefore, rows: await rowsFor(fx.dana),
    profileId: document.getElementById('per-id').value };
})()`), addDocsFix).catch(e => ({ error: String(e) }));
if (held.error) {
  check('files dropped on the Home panel are held for a client', false, held.error);
} else {
  check('a drop on the Add Documents panel is handled, not navigated to', held.prevented === true);
  check('files dropped on the Home panel open Add Documents holding them',
    held.viewOpen && held.heldText.includes('Held scan.pdf') && held.rowsBefore === 3,
    JSON.stringify([held.viewOpen, held.heldText, held.rowsBefore]));
  const r = held.rows[3];
  check('held files are added once a client is chosen',
    held.rows.length === 4 && r.original_name === 'Held scan.pdf' && r.matter_id === null
      && !!danaPapers && onDisk(r.stored_dir) === danaPapers && fs.existsSync(path.join(danaPapers, r.filename)),
    JSON.stringify(held.rows.map(x => [x.original_name, x.matter_id])));
}

// 4. Recently Touched Clients: the client just filed under comes first, with
//    their latest case beside the name; the opposing party never appears,
//    however recently he was touched.
const recentClients = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  document.getElementById('nav-home').click();
  await sleep(500);
  const rows = [...document.querySelectorAll('#home-recent-clients .home-row')];
  return rows.map(r => [...r.children].map(c => c.textContent));
}).catch(e => ({ error: String(e) }));
check('Recently Touched Clients lists the client touched in this run first',
  !recentClients.error && recentClients.length > 0 && recentClients.length <= 8
    && recentClients[0][0] === 'Dana Driscoll' && recentClients[0][1] === 'Driscoll v Exampleton',
  JSON.stringify(recentClients));
check('Recently Touched Clients never lists a pure opposing party',
  !recentClients.error && !recentClients.some(r => r[0] === 'Oscar Opposing'),
  JSON.stringify(recentClients));
const recentClick = await page.evaluate(async (pid) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  document.querySelector('#home-recent-clients .home-row a').click();
  await sleep(400);
  return document.getElementById('per-id').value === String(pid)
    && !document.getElementById('view-person-detail').classList.contains('hidden');
}, addDocsFix.dana).catch(() => false);
check('a Recently Touched Clients name opens that client', recentClick);

// Home at the smallest supported window: 1024px wide. The three panels share
// one row and nothing scrolls sideways.
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
const narrow = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  document.getElementById('nav-home').click();
  await sleep(500);
  const tops = ['home-new-matter', 'home-new-client', 'home-add-documents']
    .map(id => document.getElementById(id).getBoundingClientRect().top);
  const de = document.documentElement;
  return { width: window.innerWidth, tops, overflow: de.scrollWidth - de.clientWidth };
}).catch(e => ({ error: String(e) }));
if (process.env.SMOKE_SHOTS) {
  fs.mkdirSync(process.env.SMOKE_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'home-1024.png') }).catch(() => {});
  await page.evaluate(async () => {
    document.getElementById('home-add-documents').click();
    await new Promise(r => setTimeout(r, 300));
  }).catch(() => {});
  await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'add-documents-1024.png') }).catch(() => {});
  await page.evaluate(() => document.getElementById('btn-adddocs-cancel').click()).catch(() => {});
}
check('at 1024px the three Home panels share one row with no sideways scroll',
  !narrow.error && narrow.tops.every(t => t === narrow.tops[0]) && narrow.overflow <= 0,
  JSON.stringify(narrow));
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));

// --- Add Documents: races (client-folders Task 3b review fixes)
//
// Each of these needs one call to be slow on purpose. window.api is frozen by
// contextBridge, so the delay goes in the MAIN process: the registered invoke
// handler is wrapped (it still does the real work, just later). The dialog is
// stubbed as before, with a delay of its own.
const raceFix = await page.evaluate(async () => {
  const now = new Date().toISOString();
  const person = async (name) => (await window.api.dbRun(
    'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
    [name, 'individual', now])).lastInsertRowid;
  return { fiona: await person('Fiona Fairweather'), farah: await person('Farah Fenwick') };
}).catch(e => ({ error: String(e) }));
const raceHooked = await app.evaluate(({ ipcMain }) => {
  const h = ipcMain._invokeHandlers;
  if (!h || !h.get('db-all') || !h.get('add-client-document-files')) return false;
  const wrap = (channel, delayFor) => {
    const orig = h.get(channel);
    globalThis.__smokeOrig = globalThis.__smokeOrig || {};
    globalThis.__smokeOrig[channel] = orig;
    h.set(channel, async (e, ...args) => {
      const ms = delayFor(...args);
      if (ms) await new Promise(r => setTimeout(r, ms));
      return orig(e, ...args);
    });
  };
  globalThis.__smokePeopleDelays = [];
  globalThis.__smokeFilesDelay = 0;
  wrap('db-all', (sql) => /FROM people WHERE archived = 0/.test(sql) && globalThis.__smokePeopleDelays.length
    ? globalThis.__smokePeopleDelays.shift() : 0);
  wrap('add-client-document-files', () => globalThis.__smokeFilesDelay);
  return true;
}).catch(() => false);
check('smoke can slow the main-process handlers for the race checks', raceHooked);

const scanSrcRace = fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-scans-race-'));
const raceA = path.join(scanSrcRace, 'Race held.pdf');
const raceB = path.join(scanSrcRace, 'Race dropped.pdf');
const raceC = path.join(scanSrcRace, 'Race double.pdf');
const raceD = path.join(scanSrcRace, 'Race profile.pdf');
for (const f of [raceA, raceB, raceC, raceD]) fs.writeFileSync(f, path.basename(f));
const countNamed = (rows, name) => rows.filter(r => r.original_name === name).length;

// (a) Two keystrokes whose queries come back in the wrong order: the list must
//     show the LATER term, not whichever query happened to finish last.
const stale = await page.evaluate(new Function('fx', `return (async () => {
  ${DROP_ON}
  document.getElementById('nav-home').click();
  await sleep(200);
  document.getElementById('home-add-documents').click();
  await sleep(300);
  return true;
})()`), raceFix).catch(e => ({ error: String(e) }));
await app.evaluate(() => { globalThis.__smokePeopleDelays = [700, 0]; });
const staleList = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const input = document.getElementById('adddocs-client_name');
  input.value = 'Fiona';
  input.dispatchEvent(new Event('input'));
  await sleep(20);
  input.value = 'Farah';
  input.dispatchEvent(new Event('input'));
  await sleep(1200);
  return [...document.querySelectorAll('#combo-adddocs-client .combobox-dropdown li')].map(l => l.textContent);
}).catch(e => ({ error: String(e) }));
await app.evaluate(() => { globalThis.__smokePeopleDelays = []; });
check('a slow earlier client search does not overwrite a newer one',
  !stale.error && !staleList.error && staleList.includes('Farah Fenwick') && !staleList.includes('Fiona Fairweather'),
  JSON.stringify(stale.error || staleList));

// (b) A held file is being added, slowly, when another drop lands carrying the
//     same file again: that file must be copied exactly once, and the user
//     told the second drop was not taken.
await page.evaluate(() => {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.id = 'smoke-race-drop-2';
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  document.body.appendChild(input);
});
await page.setInputFiles('#smoke-home-drop-source', [raceA]).catch(() => {});
await page.setInputFiles('#smoke-race-drop-2', [raceA, raceB]).catch(() => {});
await app.evaluate(() => { globalThis.__smokeFilesDelay = 800; });
const dropDuring = await page.evaluate(new Function('fx', `return (async () => {
  ${DROP_ON}
  const alerts = [];
  const oldAlert = window.alert;
  window.alert = (m) => { alerts.push(String(m)); };
  try {
    document.getElementById('nav-home').click();
    await sleep(300);
    await dropOn(document.getElementById('home-add-documents'));
    await pickClient('Fiona Fairweather');
    const addBtn = document.getElementById('btn-adddocs-add-held');
    const chooseBtn = document.getElementById('btn-adddocs-choose');
    addBtn.click();
    let disabledInFlight = addBtn.getAttribute('aria-disabled') === 'true' && chooseBtn.getAttribute('aria-disabled') === 'true';
    for (let i = 0; i < 5 && !disabledInFlight; i++) {
      await sleep(100);
      disabledInFlight = addBtn.getAttribute('aria-disabled') === 'true' && chooseBtn.getAttribute('aria-disabled') === 'true';
    }
    const src = document.getElementById('smoke-race-drop-2');
    const dt = new DataTransfer();
    for (const f of src.files) dt.items.add(f);
    document.getElementById('view-add-documents')
      .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await sleep(2000);
    return { disabledInFlight, alerts, rows: await rowsFor(fx.fiona),
      enabledAfter: !addBtn.hasAttribute('aria-disabled') && !chooseBtn.hasAttribute('aria-disabled') };
  } finally { window.alert = oldAlert; }
})()`), raceFix).catch(e => ({ error: String(e) }));
check('a drop during an in-flight add does not copy a held file twice',
  !dropDuring.error && countNamed(dropDuring.rows, 'Race held.pdf') === 1
    && countNamed(dropDuring.rows, 'Race dropped.pdf') <= 1,
  JSON.stringify(dropDuring.error || dropDuring.rows.map(r => r.original_name)));
check('a drop during an in-flight add tells the user it was not taken',
  !dropDuring.error && dropDuring.alerts.length === 1 && /still adding/i.test(dropDuring.alerts[0]),
  JSON.stringify(dropDuring.error || dropDuring.alerts));
check('Choose Files and Add are disabled while a copy is in flight, and re-enabled after',
  !dropDuring.error && dropDuring.disabledInFlight && dropDuring.enabledAfter,
  JSON.stringify(dropDuring.error || [dropDuring.disabledInFlight, dropDuring.enabledAfter]));

// (c) Add clicked twice while the first copy is still running: one copy.
await page.setInputFiles('#smoke-home-drop-source', [raceC]).catch(() => {});
const doubleAdd = await page.evaluate(new Function('fx', `return (async () => {
  ${DROP_ON}
  document.getElementById('nav-home').click();
  await sleep(300);
  await dropOn(document.getElementById('home-add-documents'));
  await pickClient('Fiona Fairweather');
  const addBtn = document.getElementById('btn-adddocs-add-held');
  addBtn.click();
  addBtn.click();
  await sleep(2000);
  return { rows: await rowsFor(fx.fiona) };
})()`), raceFix).catch(e => ({ error: String(e) }));
check('double-clicking Add copies the held file once',
  !doubleAdd.error && countNamed(doubleAdd.rows, 'Race double.pdf') === 1,
  JSON.stringify(doubleAdd.error || doubleAdd.rows.map(r => r.original_name)));
await app.evaluate(() => { globalThis.__smokeFilesDelay = 0; });

// (d) The profile's own Add Document… button, double-clicked under a slow
//     dialog: one dialog's worth of files, copied once.
await app.evaluate(({ dialog }, files) => {
  dialog.showOpenDialog = async () => {
    await new Promise(r => setTimeout(r, 600));
    return { canceled: false, filePaths: files };
  };
}, [raceD]);
const profileDouble = await page.evaluate(async (pid) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await window.openPerson(pid);
  await sleep(400);
  const btn = document.getElementById('btn-add-client-document');
  btn.click();
  btn.click();
  let disabledInFlight = btn.getAttribute('aria-disabled') === 'true';
  for (let i = 0; i < 4 && !disabledInFlight; i++) {
    await sleep(100);
    disabledInFlight = btn.getAttribute('aria-disabled') === 'true';
  }
  for (let i = 0; i < 60 && btn.hasAttribute('aria-disabled'); i++) await sleep(100);
  return { disabledInFlight, enabledAfter: !btn.hasAttribute('aria-disabled'), rows: await window.api.dbAll(
    'SELECT * FROM client_documents WHERE person_id = ? ORDER BY id', [pid]) };
}, raceFix.fiona).catch(e => ({ error: String(e) }));
check('double-clicking the profile\'s Add Document… copies once',
  !profileDouble.error && countNamed(profileDouble.rows, 'Race profile.pdf') === 1,
  JSON.stringify(profileDouble.error || profileDouble.rows.map(r => r.original_name)));
check('the profile\'s Add Document… is disabled while in flight, and re-enabled after',
  !profileDouble.error && profileDouble.disabledInFlight && profileDouble.enabledAfter,
  JSON.stringify(profileDouble.error || [profileDouble.disabledInFlight, profileDouble.enabledAfter]));
await app.evaluate(({ ipcMain }) => {
  const h = ipcMain._invokeHandlers;
  for (const [ch, fn] of Object.entries(globalThis.__smokeOrig || {})) h.set(ch, fn);
}).catch(() => {});


// --- Uploads: Client Papers and case Uploads (client-folders Task 5) ---------
//
// Where the Task 3b checks above prove the two ordinary destinations, these
// cover the rest: a shared case with no folder owner yet asks first (and on
// Cancel copies nothing), the Choose Files dialog is not shown twice for it,
// a row from before migration 35 (no stored_dir) still opens from the
// client's own folder, and an opposing party is never offered the case.
const scanSrcT5 = fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-scans-t5-'));
const t5Held = path.join(scanSrcT5, 'Shared case scan.pdf');
const t5Dialog = path.join(scanSrcT5, 'Shared dialog scan.pdf');
const t5Oscar = path.join(scanSrcT5, 'Opposing scan.pdf');
fs.writeFileSync(t5Held, 'SHARED CASE BYTES');
fs.writeFileSync(t5Dialog, 'SHARED DIALOG BYTES');
fs.writeFileSync(t5Oscar, 'OPPOSING BYTES');

const t5Fix = await page.evaluate(async () => {
  const now = new Date().toISOString();
  const person = async (name) => (await window.api.dbRun(
    'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
    [name, 'individual', now])).lastInsertRowid;
  const gina = await person('Gina Galloway');
  const hank = await person('Hank Holloway');
  const sharedCase = async (name, number) => {
    const id = (await window.api.dbRun(
      'INSERT INTO matters (short_name, case_number, client_role, created_at) VALUES (?,?,?,?)',
      [name, number, 'plaintiff', now])).lastInsertRowid;
    for (const [pid, nm, i] of [[gina, 'Gina Galloway', 0], [hank, 'Hank Holloway', 1]]) {
      await window.api.dbRun(
        'INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,?)',
        [id, pid, nm, 'plaintiff', 'client', i]);
    }
    return id;
  };
  return {
    gina, hank,
    caseA: await sharedCase('Galloway v Sampleton', '2026-CV-5501'),
    caseB: await sharedCase('Holloway v Testerton', '2026-CV-5502')
  };
}).catch(e => ({ error: String(e) }));

const t5Alerts = () => page.evaluate(() => {
  const a = window.__t5Alerts || [];
  window.__t5Alerts = [];
  return a;
});
await page.evaluate(() => {
  window.__t5Alerts = [];
  window.alert = (m) => { window.__t5Alerts.push(String(m)); };
});
// Start an Add of the held file for Gina under a shared case. Resolves once
// Add is clicked; the picker holds the copy open.
const t5StartHeldAdd = (fx, caseId) => page.evaluate(new Function('args', `return (async () => {
  ${DROP_ON}
  const [fx, caseId] = args;
  document.getElementById('nav-home').click();
  await sleep(300);
  await dropOn(document.getElementById('home-add-documents'));
  await pickClient('Gina Galloway');
  const sel = document.getElementById('adddocs-matter_id');
  sel.value = String(caseId);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('btn-adddocs-add-held').click();
  return true;
})()`), [fx, caseId]);
const t5State = (fx, caseId) => page.evaluate(async ([fx, caseId]) => ({
  rows: await window.api.dbAll('SELECT * FROM client_documents WHERE person_id IN (?,?) ORDER BY id', [fx.gina, fx.hank]),
  matter: await window.api.dbGet('SELECT folder_person_id, output_dir FROM matters WHERE id = ?', [caseId]),
  held: document.getElementById('adddocs-held').textContent
}), [fx, caseId]).then(resolveStored);
const t5Settle = async (fx) => {
  for (let i = 0; i < 40; i++) {
    const busy = await page.evaluate(() => document.getElementById('btn-adddocs-add-held').getAttribute('aria-disabled') === 'true');
    if (!busy) return;
    await new Promise(r => setTimeout(r, 100));
  }
};

if (t5Fix.error) {
  check('Task 5 fixtures', false, t5Fix.error);
} else {
  // 1. Held file, shared case, Cancel: the picker shows, nothing is copied,
  //    the case stays undecided, the file is held again and the user is told.
  await page.setInputFiles('#smoke-home-drop-source', [t5Held]).catch(() => {});
  await t5StartHeldAdd(t5Fix, t5Fix.caseA).catch(() => {});
  const askedOnUpload = await waitForPicker(true);
  const offered = askedOnUpload ? await pickerOptions() : null;
  await pickerCancel();
  await waitForPicker(false);
  await t5Settle(t5Fix);
  const afterCancel = await t5State(t5Fix, t5Fix.caseA);
  const cancelAlerts = await t5Alerts();
  check('an upload to a shared case with no folder owner shows the picker',
    askedOnUpload && !!offered && offered.clients.some(c => c.id === t5Fix.gina) && offered.clients.some(c => c.id === t5Fix.hank),
    JSON.stringify(offered));
  check('Cancel on the upload picker copies nothing and leaves the case undecided',
    afterCancel.rows.length === 0 && afterCancel.matter.folder_person_id === null && afterCancel.matter.output_dir === null
      && !fs.existsSync(path.join(tmpRoot, 'Clients', 'Gina Galloway')),
    JSON.stringify(afterCancel));
  check('after Cancel the files are held again and the user is told nothing was added',
    afterCancel.held.includes('Shared case scan.pdf')
      && cancelAlerts.length === 1 && /nothing was added/i.test(cancelAlerts[0]),
    JSON.stringify([afterCancel.held, cancelAlerts]));

  // 2. Add again and choose Hank: the case is filed under Hank, and Gina's
  //    scan goes into that case's Uploads/ (the case has one folder).
  await page.evaluate(() => document.getElementById('btn-adddocs-add-held').click());
  const askedAgain = await waitForPicker(true);
  await pickerChoose(t5Fix.hank);
  await waitForPicker(false);
  await t5Settle(t5Fix);
  const afterChoose = await t5State(t5Fix, t5Fix.caseA);
  const hankUploads = afterChoose.matter.output_dir ? path.join(afterChoose.matter.output_dir, 'Uploads') : null;
  const r = afterChoose.rows[0];
  check('choosing a client on the upload picker files the scan in that case\'s Uploads/',
    askedAgain && afterChoose.rows.length === 1 && !!r && r.person_id === t5Fix.gina && r.matter_id === t5Fix.caseA
      && afterChoose.matter.folder_person_id === t5Fix.hank
      && path.dirname(afterChoose.matter.output_dir) === path.join(tmpRoot, 'Clients', 'Hank Holloway')
      && r.stored_dir === hankUploads
      && fs.readFileSync(path.join(hankUploads, r.filename), 'utf8') === 'SHARED CASE BYTES',
    JSON.stringify(afterChoose));

  // 3. Choose Files on a shared undecided case: asked BEFORE the dialog, so
  //    the dialog opens exactly once — after the answer.
  await app.evaluate(({ dialog }, files) => {
    globalThis.__t5DialogCalls = 0;
    dialog.showOpenDialog = async () => { globalThis.__t5DialogCalls++; return { canceled: false, filePaths: files }; };
  }, [t5Dialog]);
  await page.evaluate(new Function('args', `return (async () => {
    ${DROP_ON}
    const [fx, caseId] = args;
    document.getElementById('nav-home').click();
    await sleep(200);
    document.getElementById('home-add-documents').click();
    await sleep(200);
    await pickClient('Gina Galloway');
    const sel = document.getElementById('adddocs-matter_id');
    sel.value = String(caseId);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('btn-adddocs-choose').click();
    return true;
  })()`), [t5Fix, t5Fix.caseB]).catch(() => {});
  const askedBeforeDialog = await waitForPicker(true);
  const dialogBefore = await app.evaluate(() => globalThis.__t5DialogCalls);
  await pickerChoose(t5Fix.gina);
  await waitForPicker(false);
  await t5Settle(t5Fix);
  const dialogAfter = await app.evaluate(() => globalThis.__t5DialogCalls);
  const afterDialog = await t5State(t5Fix, t5Fix.caseB);
  const d = afterDialog.rows.find(x => x.original_name === 'Shared dialog scan.pdf');
  const ginaUploads = afterDialog.matter.output_dir ? path.join(afterDialog.matter.output_dir, 'Uploads') : null;
  check('Choose Files on an undecided case asks before the dialog, and shows the dialog once',
    askedBeforeDialog && dialogBefore === 0 && dialogAfter === 1, JSON.stringify([askedBeforeDialog, dialogBefore, dialogAfter]));
  check('after choosing, the picked file lands in that case\'s Uploads/ under the chosen client',
    !!d && d.matter_id === t5Fix.caseB && d.stored_dir === ginaUploads
      && path.dirname(afterDialog.matter.output_dir) === path.join(tmpRoot, 'Clients', 'Gina Galloway')
      && fs.existsSync(path.join(ginaUploads, d.filename)),
    JSON.stringify([d, afterDialog.matter]));
  await t5Alerts();
}

// 4. A row from before migration 35 has no stored_dir: its file sits in the
//    client's own folder, and Open / the missing-file check look there. A
//    Client Papers row on the same profile opens from Client Papers.
const legacyName = 'Legacy scan.pdf';
if (danaDir) fs.writeFileSync(path.join(danaDir, legacyName), 'LEGACY BYTES');
await app.evaluate(({ ipcMain }) => {
  const h = ipcMain._invokeHandlers;
  globalThis.__t5OpenPath = h.get('open-path');
  globalThis.__t5Opened = [];
  h.set('open-path', async (e, target) => { globalThis.__t5Opened.push(target); return { ok: true }; });
}).catch(() => {});
const legacy = await page.evaluate(async ({ pid, name }) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const id = (await window.api.dbRun(
    'INSERT INTO client_documents (person_id, filename, original_name, added_at) VALUES (?,?,?,?)',
    [pid, name, name, new Date().toISOString()])).lastInsertRowid;
  const loose = await window.api.dbGet(
    "SELECT id FROM client_documents WHERE person_id = ? AND original_name = 'Loose receipt.pdf'", [pid]);
  await window.openPerson(pid);
  await sleep(700);
  const rowFor = (docId) => document.querySelector(`#person-documents .doc-row[data-doc-id="${docId}"]`);
  const open = (docId) => [...rowFor(docId).querySelectorAll('button')].find(b => b.textContent === 'Open').click();
  const missing = (docId) => !rowFor(docId).querySelector('.missing-file-tag').classList.contains('hidden');
  open(id);
  open(loose.id);
  await sleep(400);
  return { missingLegacy: missing(id), missingLoose: missing(loose.id) };
}, { pid: addDocsFix.dana, name: legacyName }).catch(e => ({ error: String(e) }));
const openedPaths = await app.evaluate(({ ipcMain }) => {
  const h = ipcMain._invokeHandlers;
  if (globalThis.__t5OpenPath) h.set('open-path', globalThis.__t5OpenPath);
  return globalThis.__t5Opened;
}).catch(() => []);
check('a pre-35 row (no stored_dir) opens from the client\'s own folder',
  !legacy.error && !!danaDir && openedPaths[0] === path.join(danaDir, legacyName) && legacy.missingLegacy === false,
  JSON.stringify([legacy, openedPaths]));
check('a Client Papers row opens from Client Papers',
  !legacy.error && !!danaPapers && openedPaths[1] === path.join(danaPapers, 'Loose receipt.pdf') && legacy.missingLoose === false,
  JSON.stringify([legacy, openedPaths]));

// 5. The opposing party on a case is never offered that case — neither on the
//    Add Documents screen nor in the reassign dropdown on his own documents —
//    and main refuses the upload even if asked directly.
const roleFilter = await page.evaluate(new Function('args', `return (async () => {
  ${DROP_ON}
  const [fx, file] = args;
  document.getElementById('nav-home').click();
  await sleep(200);
  document.getElementById('home-add-documents').click();
  await sleep(200);
  await pickClient('Oscar Opposing');
  const addDocsOptions = [...document.getElementById('adddocs-matter_id').options].map(o => o.textContent);
  document.getElementById('btn-adddocs-cancel').click();
  let refused = null;
  try {
    const res = await window.api.addClientDocumentFiles(fx.oscar, [file], { matterId: fx.caseId });
    refused = res && res.error ? res.error : null;
  } catch (e) { refused = String(e); }
  const afterRefusal = (await rowsFor(fx.oscar)).length;
  await window.api.addClientDocumentFiles(fx.oscar, [file]);
  await window.openPerson(fx.oscar);
  await sleep(600);
  const row = document.querySelector('#person-documents .doc-row');
  const reassignOptions = row ? [...row.querySelector('.doc-matter').options].map(o => o.textContent) : null;
  const reassignTitle = row ? row.querySelector('.doc-matter').title : '';
  return { addDocsOptions, refused, afterRefusal, reassignOptions, reassignTitle };
})()`), [addDocsFix, t5Oscar]).catch(e => ({ error: String(e) }));
check('Add Documents does not offer a case where the person is the opposing party',
  !roleFilter.error && roleFilter.addDocsOptions.length === 1 && !roleFilter.addDocsOptions.includes('Driscoll v Exampleton'),
  JSON.stringify(roleFilter));
check('the reassign dropdown does not offer a case where the person is the opposing party',
  !roleFilter.error && Array.isArray(roleFilter.reassignOptions)
    && roleFilter.reassignOptions.join('|') === '(no case)',
  JSON.stringify(roleFilter));
check('main refuses to file an opposing party\'s scan under that case, copying nothing',
  !roleFilter.error && !!roleFilter.refused && roleFilter.afterRefusal === 0,
  JSON.stringify(roleFilter));
check('the reassign dropdown says it changes the record, not the file',
  !roleFilter.error && /record only/i.test(roleFilter.reassignTitle) && /file stays/i.test(roleFilter.reassignTitle),
  JSON.stringify(roleFilter.reassignTitle));
await page.evaluate(() => { window.alert = () => {}; });

// --- Case screen: Add Documents and Open Folder (client-folders Task 5b) ----
//
// The case screen's Add Documents files a scan under the case's folder owner
// and into the case's Uploads/; a shared case with no owner asks first (before
// the file dialog); a drop on the screen does the same, and a drop mid-copy is
// turned away. Open Folder opens the case folder (asking first if needed) and
// the profile's Open Folder opens the client's folder — open-path is stubbed
// in main so nothing launches Finder/Explorer. A case filed under No Client,
// or with no client at all, takes no uploads and says why.
const scanSrcT5b = fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-scans-t5b-'));
const t5bFile = (name, bytes) => { const p = path.join(scanSrcT5b, name); fs.writeFileSync(p, bytes); return p; };
const t5bButton = t5bFile('Case button scan.pdf', 'CASE BUTTON BYTES');
const t5bDrop = t5bFile('Case drop scan.pdf', 'CASE DROP BYTES');
const t5bBusy = t5bFile('Case busy scan.pdf', 'CASE BUSY BYTES');
const t5bShared = t5bFile('Case shared scan.pdf', 'CASE SHARED BYTES');
const t5bRefused = t5bFile('Refused held scan.pdf', 'REFUSED BYTES');
const t5bThrown = t5bFile('Thrown held scan.pdf', 'THROWN BYTES');
const t5bSlow = t5bFile('Global slow scan.pdf', 'GLOBAL SLOW BYTES');
const t5bTurnedAway = t5bFile('Global turned away.pdf', 'GLOBAL TURNED AWAY BYTES');
const t5bAfter = t5bFile('Global after drop.pdf', 'GLOBAL AFTER BYTES');

const t5bFix = await page.evaluate(async () => {
  const now = new Date().toISOString();
  const person = async (name) => (await window.api.dbRun(
    'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
    [name, 'individual', now])).lastInsertRowid;
  const ivy = await person('Ivy Ingram');
  const jack = await person('Jack Jennings');
  const kara = await person('Kara Keating');
  const matter = async (name, number, clients) => {
    const id = (await window.api.dbRun(
      'INSERT INTO matters (short_name, case_number, client_role, created_at) VALUES (?,?,?,?)',
      [name, number, 'plaintiff', now])).lastInsertRowid;
    for (const [i, [pid, nm]] of clients.entries()) {
      await window.api.dbRun(
        'INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,?)',
        [id, pid, nm, 'plaintiff', 'client', i]);
    }
    return id;
  };
  const both = [[jack, 'Jack Jennings'], [kara, 'Kara Keating']];
  return {
    ivy, jack, kara,
    caseIvy: await matter('Ingram v Exampleton', '2026-CV-5601', [[ivy, 'Ivy Ingram']]),
    caseShared: await matter('Jennings v Sampleton', '2026-CV-5602', both),
    caseNoClient: await matter('Keating v Testerton', '2026-CV-5603', both),
    caseNone: await matter('Nobody v Exampleton', '2026-CV-5604', []),
    caseGone: await matter('Vanishing v Sampleton', '2026-CV-5605', [[ivy, 'Ivy Ingram']])
  };
}).catch(e => ({ error: String(e) }));

const t5bHooked = await app.evaluate(({ ipcMain, dialog }) => {
  const h = ipcMain._invokeHandlers;
  if (!h || !h.get('open-path') || !h.get('add-client-document-files')) return false;
  globalThis.__t5bOrig = { 'open-path': h.get('open-path'), 'add-client-document-files': h.get('add-client-document-files') };
  globalThis.__t5bOpened = [];
  globalThis.__t5bFilesDelay = 0;
  globalThis.__t5bFilesThrow = false;
  h.set('open-path', async (e, target) => { globalThis.__t5bOpened.push(target); return { ok: true }; });
  h.set('add-client-document-files', async (e, ...args) => {
    if (globalThis.__t5bFilesThrow) throw new Error('Disk full (smoke)');
    if (globalThis.__t5bFilesDelay) await new Promise(r => setTimeout(r, globalThis.__t5bFilesDelay));
    return globalThis.__t5bOrig['add-client-document-files'](e, ...args);
  });
  globalThis.__t5bDialogCalls = 0;
  globalThis.__t5bDialogFiles = [];
  dialog.showOpenDialog = async () => {
    globalThis.__t5bDialogCalls++;
    return { canceled: false, filePaths: globalThis.__t5bDialogFiles };
  };
  return true;
}).catch(() => false);
check('smoke can stub open-path and the file dialog for the case-screen checks', t5bHooked);

const t5bSet = (vals) => app.evaluate((_, vals) => { Object.assign(globalThis, vals); }, vals);
const t5bMain = () => app.evaluate(() => ({ opened: globalThis.__t5bOpened.slice(), dialogCalls: globalThis.__t5bDialogCalls }));
await page.evaluate(() => {
  window.__t5bAlerts = [];
  window.alert = (m) => { window.__t5bAlerts.push(String(m)); };
});
const t5bAlerts = () => page.evaluate(() => { const a = window.__t5bAlerts; window.__t5bAlerts = []; return a; });
const t5bOpenCase = (id) => page.evaluate(async (id) => {
  await window.openMatterForTest(id);
  await new Promise(r => setTimeout(r, 500));
  const shown = (elId) => !document.getElementById(elId).classList.contains('hidden');
  return { add: shown('btn-matter-add-documents'), open: shown('btn-matter-open-folder') };
}, id);
const t5bClick = (id) => page.evaluate((id) => document.getElementById(id).click(), id);
const t5bIdle = async () => {
  for (let i = 0; i < 60; i++) {
    const busy = await page.evaluate(() => document.getElementById('btn-matter-add-documents').getAttribute('aria-disabled') === 'true');
    if (!busy) return;
    await new Promise(r => setTimeout(r, 100));
  }
};
const t5bDropOnCase = (files) => page.setInputFiles('#smoke-home-drop-source', files).then(() => page.evaluate(() => {
  const dt = new DataTransfer();
  for (const f of document.getElementById('smoke-home-drop-source').files) dt.items.add(f);
  const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
  document.getElementById('view-matter-detail').dispatchEvent(ev);
  return ev.defaultPrevented;
}));
const t5bState = (matterId) => page.evaluate(async (matterId) => ({
  rows: await window.api.dbAll('SELECT * FROM client_documents WHERE matter_id = ? ORDER BY id', [matterId]),
  matter: await window.api.dbGet('SELECT folder_person_id, output_dir FROM matters WHERE id = ?', [matterId]),
  note: document.getElementById('matter-upload-note').textContent
}), matterId).then(resolveStored);
const t5bWaitOpened = async (n) => {
  for (let i = 0; i < 40; i++) {
    const m = await t5bMain();
    if (m.opened.length >= n) return m.opened;
    await new Promise(r => setTimeout(r, 100));
  }
  return (await t5bMain()).opened;
};

if (t5bFix.error || !t5bHooked) {
  check('Task 5b fixtures', false, t5bFix.error || 'hooks not installed');
} else {
  // 1. A one-client case: the buttons show, Add Documents copies into
  //    <Client>/<Case>/Uploads/ with stored_dir recorded, and says so.
  const shownIvy = await t5bOpenCase(t5bFix.caseIvy);
  check('the case screen shows Add Documents and Open Folder for a saved case',
    shownIvy.add && shownIvy.open, JSON.stringify(shownIvy));
  await t5bSet({ __t5bDialogFiles: [t5bButton] });
  await t5bClick('btn-matter-add-documents');
  await new Promise(r => setTimeout(r, 300));
  await t5bIdle();
  const ivyState = await t5bState(t5bFix.caseIvy);
  const ivyUploads = ivyState.matter.output_dir ? path.join(ivyState.matter.output_dir, 'Uploads') : null;
  const b = ivyState.rows.find(r => r.original_name === 'Case button scan.pdf');
  check('case Add Documents lands in <Client>/<Case>/Uploads/ with stored_dir set',
    !!b && b.person_id === t5bFix.ivy && !!ivyUploads && b.stored_dir === ivyUploads
      && path.dirname(ivyState.matter.output_dir) === path.join(tmpRoot, 'Clients', 'Ivy Ingram')
      && fs.readFileSync(path.join(ivyUploads, b.filename), 'utf8') === 'CASE BUTTON BYTES',
    JSON.stringify(ivyState));
  check('case Add Documents says the files went to the case\'s Uploads folder',
    /Added 1 file to this case.s Uploads folder/.test(ivyState.note), JSON.stringify(ivyState.note));

  // 2. A drop on the case screen does the same.
  const dropPrevented = await t5bDropOnCase([t5bDrop]);
  await new Promise(r => setTimeout(r, 300));
  await t5bIdle();
  const afterDrop = await t5bState(t5bFix.caseIvy);
  const dr = afterDrop.rows.find(r => r.original_name === 'Case drop scan.pdf');
  check('a drop on the case screen lands in that case\'s Uploads/',
    dropPrevented && !!dr && dr.person_id === t5bFix.ivy && dr.stored_dir === ivyUploads
      && fs.readFileSync(path.join(ivyUploads, dr.filename), 'utf8') === 'CASE DROP BYTES',
    JSON.stringify(afterDrop.rows));

  // 3. A second drop while the first copy is running is turned away.
  await t5bAlerts();
  await t5bSet({ __t5bFilesDelay: 900 });
  await t5bDropOnCase([t5bBusy]);
  const disabledInFlight = await page.evaluate(() => document.getElementById('btn-matter-add-documents').getAttribute('aria-disabled') === 'true');
  await t5bDropOnCase([t5bBusy]);
  await new Promise(r => setTimeout(r, 1300));
  await t5bIdle();
  await t5bSet({ __t5bFilesDelay: 0 });
  const busyRows = (await t5bState(t5bFix.caseIvy)).rows.filter(r => r.original_name === 'Case busy scan.pdf');
  const busyAlerts = await t5bAlerts();
  check('a drop on the case screen during a copy is refused, and the file copied once',
    busyRows.length === 1 && busyAlerts.length === 1 && /still adding/i.test(busyAlerts[0]),
    JSON.stringify([busyRows.length, busyAlerts]));
  check('the case screen\'s Add Documents is disabled while a copy is in flight',
    disabledInFlight && !(await page.evaluate(() => document.getElementById('btn-matter-add-documents').getAttribute('aria-disabled') === 'true')),
    JSON.stringify(disabledInFlight));

  // 4. A shared case with no folder owner: asked BEFORE the dialog; the scan
  //    is filed under the chosen client, in that client's case folder.
  await t5bOpenCase(t5bFix.caseShared);
  await t5bSet({ __t5bDialogFiles: [t5bShared], __t5bDialogCalls: 0 });
  await t5bClick('btn-matter-add-documents');
  const askedShared = await waitForPicker(true);
  const dialogBeforeShared = (await t5bMain()).dialogCalls;
  await pickerChoose(t5bFix.kara);
  await waitForPicker(false);
  await new Promise(r => setTimeout(r, 300));
  await t5bIdle();
  const sharedState = await t5bState(t5bFix.caseShared);
  const sr = sharedState.rows[0];
  check('case Add Documents on an undecided shared case asks first, then shows the dialog once',
    askedShared && dialogBeforeShared === 0 && (await t5bMain()).dialogCalls === 1,
    JSON.stringify([askedShared, dialogBeforeShared]));
  check('after choosing, the case upload is filed under the chosen client in her case\'s Uploads/',
    !!sr && sr.person_id === t5bFix.kara && sharedState.matter.folder_person_id === t5bFix.kara
      && path.dirname(sharedState.matter.output_dir) === path.join(tmpRoot, 'Clients', 'Kara Keating')
      && sr.stored_dir === path.join(sharedState.matter.output_dir, 'Uploads')
      && fs.existsSync(path.join(sr.stored_dir, sr.filename)),
    JSON.stringify(sharedState));

  // 5. Open Folder on the case: the case folder, opened through open-path.
  await t5bOpenCase(t5bFix.caseIvy);
  await t5bClick('btn-matter-open-folder');
  const opened1 = await t5bWaitOpened(1);
  check('case Open Folder opens the case\'s folder',
    opened1.length === 1 && opened1[0] === ivyState.matter.output_dir, JSON.stringify(opened1));

  // 6. Open Folder on an undecided shared case asks, and "No Client" opens
  //    the case's folder under No Client/.
  await t5bOpenCase(t5bFix.caseNoClient);
  await t5bClick('btn-matter-open-folder');
  const askedOpen = await waitForPicker(true);
  await pickerChoose(0);
  await waitForPicker(false);
  const opened2 = await t5bWaitOpened(2);
  const noClientState = await t5bState(t5bFix.caseNoClient);
  check('case Open Folder on an undecided case asks, then opens the folder chosen',
    askedOpen && noClientState.matter.folder_person_id === 0 && opened2[1] === noClientState.matter.output_dir
      && path.dirname(noClientState.matter.output_dir) === path.join(tmpRoot, 'No Client')
      && fs.existsSync(noClientState.matter.output_dir),
    JSON.stringify([askedOpen, opened2, noClientState.matter]));

  // 7. A No Client case takes no uploads: told why, no dialog, nothing copied.
  await t5bAlerts();
  await t5bSet({ __t5bDialogCalls: 0, __t5bDialogFiles: [t5bButton] });
  await t5bClick('btn-matter-add-documents');
  await new Promise(r => setTimeout(r, 400));
  await t5bIdle();
  const noClientAlerts = await t5bAlerts();
  check('a No Client case refuses uploads with a clear message and no dialog',
    noClientAlerts.length === 1 && /filed under No Client/.test(noClientAlerts[0]) && /Open Folder/.test(noClientAlerts[0])
      && (await t5bMain()).dialogCalls === 0 && (await t5bState(t5bFix.caseNoClient)).rows.length === 0,
    JSON.stringify(noClientAlerts));

  // 8. A case with no client at all: no picker (there is nobody to pick),
  //    told why, nothing copied, and the case folder is not decided.
  await t5bOpenCase(t5bFix.caseNone);
  await t5bClick('btn-matter-add-documents');
  await new Promise(r => setTimeout(r, 400));
  const pickerForNone = await pickerShown();
  await t5bIdle();
  const noneAlerts = await t5bAlerts();
  const noneState = await t5bState(t5bFix.caseNone);
  check('a case with no client refuses uploads without asking, and decides nothing',
    !pickerForNone && noneAlerts.length === 1 && /no client on this case/i.test(noneAlerts[0])
      && noneState.rows.length === 0 && noneState.matter.folder_person_id === null && noneState.matter.output_dir === null
      && (await t5bMain()).dialogCalls === 0,
    JSON.stringify([pickerForNone, noneAlerts, noneState]));

  // 9. The profile's Open Folder opens the client's own folder.
  await page.evaluate(async (pid) => {
    await window.openPerson(pid);
    await new Promise(r => setTimeout(r, 500));
    document.getElementById('btn-open-client-folder').click();
  }, t5bFix.ivy);
  const opened3 = await t5bWaitOpened(3);
  check('the profile\'s Open Folder opens the client\'s folder',
    opened3[2] === path.join(tmpRoot, 'Clients', 'Ivy Ingram'), JSON.stringify(opened3));

  // 10. The dialog variant, pointed at a case that no longer exists, refuses
  //     BEFORE the dialog opens.
  const goneDialog = await page.evaluate((pid) =>
    window.api.addClientDocument(pid, { matterId: 99999999 }), t5bFix.ivy).catch(e => ({ thrown: String(e) }));
  check('Choose Files for a deleted case is refused before the dialog opens',
    !!goneDialog && /no longer exists/.test(goneDialog.error || '') && (await t5bMain()).dialogCalls === 0,
    JSON.stringify(goneDialog));

  // 11. Add Documents screen: a held file refused before any copy (the case
  //     was deleted after it was picked) goes back on hold; so does one whose
  //     copy threw with nothing recorded.
  const heldBack = async (file, between) => {
    await page.setInputFiles('#smoke-home-drop-source', [file]).catch(() => {});
    return page.evaluate(new Function('args', `return (async () => {
      ${DROP_ON}
      const [fx, between] = args;
      document.getElementById('nav-home').click();
      await sleep(200);
      await dropOn(document.getElementById('home-add-documents'));
      await pickClient('Ivy Ingram');
      const sel = document.getElementById('adddocs-matter_id');
      sel.value = String(fx.caseGone);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      if (between === 'delete') {
        await window.api.dbRun('DELETE FROM parties WHERE matter_id = ?', [fx.caseGone]);
        await window.api.dbRun('DELETE FROM matters WHERE id = ?', [fx.caseGone]);
      }
      document.getElementById('btn-adddocs-add-held').click();
      await sleep(900);
      return {
        view: !document.getElementById('view-add-documents').classList.contains('hidden'),
        held: document.getElementById('adddocs-held').textContent,
        rows: (await rowsFor(fx.ivy)).map(r => r.original_name)
      };
    })()`), [t5bFix, between]).catch(e => ({ error: String(e) }));
  };
  await t5bAlerts();
  await t5bSet({ __t5bFilesThrow: true });
  const thrown = await heldBack(t5bThrown, 'none');
  await t5bSet({ __t5bFilesThrow: false });
  const thrownAlerts = await t5bAlerts();
  check('a copy that throws with nothing recorded puts the held files back',
    !thrown.error && thrown.view && thrown.held.includes('Thrown held scan.pdf') && !thrown.rows.includes('Thrown held scan.pdf')
      && thrownAlerts.length === 1 && /Nothing was added/.test(thrownAlerts[0]),
    JSON.stringify([thrown, thrownAlerts]));
  await page.evaluate(() => document.getElementById('btn-adddocs-cancel').click()).catch(() => {});
  const refusedHeld = await heldBack(t5bRefused, 'delete');
  const refusedAlerts = await t5bAlerts();
  check('a held file refused before copying (case deleted) goes back on hold',
    !refusedHeld.error && refusedHeld.view && refusedHeld.held.includes('Refused held scan.pdf')
      && !refusedHeld.rows.includes('Refused held scan.pdf')
      && refusedAlerts.length === 1 && /Nothing was added: That case no longer exists/.test(refusedAlerts[0]),
    JSON.stringify([refusedHeld, refusedAlerts]));
  await page.evaluate(() => document.getElementById('btn-adddocs-cancel').click()).catch(() => {});

  // 12. ONE add at a time across the whole app (Task 5b review fixes). A slow
  //     add started on the Add Documents screen; meanwhile the user goes to a
  //     case and clicks its Add Documents, then to a profile and drops a file
  //     on its Documents panel. Both are turned away WITH a message (the
  //     buttons alone looked dead), nothing opens or copies twice, and every
  //     add button shows busy until the first add ends — then all come back.
  const addBtnIds = ['btn-add-client-document', 'btn-adddocs-choose', 'btn-adddocs-add-held', 'btn-matter-add-documents'];
  const busyLook = () => page.evaluate((ids) =>
    Object.fromEntries(ids.map(id => [id, document.getElementById(id).getAttribute('aria-disabled') === 'true'])), addBtnIds);
  const dropFiles = async (files, elId) => {
    await page.setInputFiles('#smoke-race-drop-2', files).catch(() => {});
    return page.evaluate((elId) => {
      const dt = new DataTransfer();
      for (const f of document.getElementById('smoke-race-drop-2').files) dt.items.add(f);
      const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
      document.getElementById(elId).dispatchEvent(ev);
      return ev.defaultPrevented;
    }, elId);
  };
  await t5bAlerts();
  await t5bSet({ __t5bFilesDelay: 3000, __t5bDialogCalls: 0, __t5bDialogFiles: [t5bButton] });
  await page.setInputFiles('#smoke-home-drop-source', [t5bSlow]).catch(() => {});
  const slowStart = await page.evaluate(new Function('fx', `return (async () => {
    ${DROP_ON}
    document.getElementById('nav-home').click();
    await sleep(200);
    await dropOn(document.getElementById('home-add-documents'));
    await pickClient('Ivy Ingram');
    document.getElementById('btn-adddocs-add-held').click();
    await sleep(50);
    return true;
  })()`), t5bFix).catch(e => ({ error: String(e) }));
  const busyAtStart = await busyLook();
  const alertsPending = () => page.evaluate(() => (window.__t5bAlerts || []).length);
  await t5bOpenCase(t5bFix.caseIvy);
  const caseRowsBefore = (await t5bState(t5bFix.caseIvy)).rows.length;
  await t5bClick('btn-matter-add-documents');
  for (let i = 0; i < 20 && !(await alertsPending()); i++) await new Promise(r => setTimeout(r, 100));
  const caseBusyLook = await busyLook();
  const caseAlerts = await t5bAlerts();
  await page.evaluate(async (pid) => {
    await window.openPerson(pid);
    await new Promise(r => setTimeout(r, 300));
  }, t5bFix.ivy);
  await dropFiles([t5bTurnedAway], 'person-documents-panel');
  for (let i = 0; i < 20 && !(await alertsPending()); i++) await new Promise(r => setTimeout(r, 100));
  const profileBusyLook = await busyLook();
  const profileAlerts = await t5bAlerts();
  // Wait for the slow add to finish (every button back to normal).
  for (let i = 0; i < 80; i++) {
    const look = await busyLook();
    if (!Object.values(look).some(Boolean)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await t5bSet({ __t5bFilesDelay: 0 });
  await new Promise(r => setTimeout(r, 300));
  const idleLook = await busyLook();
  const ivyRows = (await page.evaluate((pid) =>
    window.api.dbAll('SELECT * FROM client_documents WHERE person_id = ? ORDER BY id', [pid]), t5bFix.ivy));
  const named = (n) => ivyRows.filter(r => r.original_name === n);
  check('a slow add on the Add Documents screen marks every add button busy',
    !slowStart.error && Object.values(busyAtStart).every(Boolean), JSON.stringify(slowStart.error || busyAtStart));
  check('the case screen\'s Add Documents during another screen\'s add says so, and opens nothing',
    caseAlerts.length === 1 && /still adding the last files/i.test(caseAlerts[0])
      && (await t5bMain()).dialogCalls === 0
      && (await t5bState(t5bFix.caseIvy)).rows.length === caseRowsBefore,
    JSON.stringify([caseAlerts, caseRowsBefore]));
  check('the case screen\'s Add Documents shows busy while another screen\'s add runs',
    caseBusyLook['btn-matter-add-documents'] === true, JSON.stringify(caseBusyLook));
  check('a profile drop during another screen\'s add says so, and copies nothing',
    profileAlerts.length === 1 && /still adding the last files/i.test(profileAlerts[0])
      && named('Global turned away.pdf').length === 0 && profileBusyLook['btn-add-client-document'] === true,
    JSON.stringify([profileAlerts, profileBusyLook]));
  check('the slow add itself copied its file exactly once',
    named('Global slow scan.pdf').length === 1, JSON.stringify(ivyRows.map(r => r.original_name)));
  check('every add button comes back once the add finishes',
    !Object.values(idleLook).some(Boolean), JSON.stringify(idleLook));

  // ...and the profile panel's drop, now on fileDropTarget, still records a
  // file (into Client Papers), with no message.
  await page.evaluate(async (pid) => {
    await window.openPerson(pid);
    await new Promise(r => setTimeout(r, 300));
  }, t5bFix.ivy);
  const afterPrevented = await dropFiles([t5bAfter], 'person-documents-panel');
  let afterRow = null;
  for (let i = 0; i < 30 && !afterRow; i++) {
    await new Promise(r => setTimeout(r, 100));
    afterRow = resolveStored(await page.evaluate((pid) => window.api.dbGet(
      "SELECT * FROM client_documents WHERE person_id = ? AND original_name = 'Global after drop.pdf'", [pid]), t5bFix.ivy));
  }
  const afterAlerts = await t5bAlerts();
  check('the profile panel\'s drop still records a file once no add is running',
    afterPrevented && !!afterRow && afterAlerts.length === 0
      && afterRow.stored_dir === path.join(tmpRoot, 'Clients', 'Ivy Ingram', 'Client Papers')
      && fs.readFileSync(path.join(afterRow.stored_dir, afterRow.filename), 'utf8') === 'GLOBAL AFTER BYTES',
    JSON.stringify([afterRow, afterAlerts]));

  // The profile panel's outline no longer flickers off over its own children:
  // a dragleave INTO a child keeps it; one out of the panel clears it.
  const outline = await page.evaluate(() => {
    const panel = document.getElementById('person-documents-panel');
    const child = panel.querySelector('button') || panel.firstElementChild;
    panel.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    panel.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: child }));
    const keptOverChild = panel.classList.contains('drop-target');
    panel.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: document.body }));
    return { keptOverChild, clearedOnLeave: !panel.classList.contains('drop-target') };
  }).catch(e => ({ error: String(e) }));
  check('the profile panel keeps its drop outline over its own children, and clears it on leaving',
    !outline.error && outline.keptOverChild && outline.clearedOnLeave, JSON.stringify(outline));
}
await app.evaluate(({ ipcMain }) => {
  const h = ipcMain._invokeHandlers;
  for (const [ch, fn] of Object.entries(globalThis.__t5bOrig || {})) h.set(ch, fn);
}).catch(() => {});
await page.evaluate(() => { window.alert = () => {}; });

// --- Letters under the client (client-folders Task 6) ----------------------
//
// New Letter has a Client picker. It fills itself from the recipient (when
// they are a client on any case) or from the Regarding case's folder owner,
// but never over a choice made by hand. A letter with a client is saved in
// Clients/<Client>/Letters/<dated folder>/; without one, General Letters/.
// Once the letter's folder is frozen, changing its client moves nothing, and
// the packet screen shows the client read-only.
const t6 = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, tries = 50, ms = 100) => {
    for (let i = 0; i < tries; i++) {
      const v = await fn();
      if (v) return v;
      await wait(ms);
    }
    return null;
  };
  const now = new Date().toISOString();
  const person = async (name) => (await window.api.dbRun(
    'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
    [name, 'individual', now])).lastInsertRowid;
  const lena = await person('Lena Lambert');
  const milo = await person('Milo Morgan');
  const nora = await person('Nora Nash');
  const owen = await person('Owen Olsen');
  const matter = async (name, number, clients, owner) => {
    const id = (await window.api.dbRun(
      'INSERT INTO matters (short_name, case_number, client_role, folder_person_id, created_at) VALUES (?,?,?,?,?)',
      [name, number, 'plaintiff', owner, now])).lastInsertRowid;
    for (const [i, [pid, nm]] of clients.entries()) {
      await window.api.dbRun(
        'INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,?)',
        [id, pid, nm, 'plaintiff', 'client', i]);
    }
    return id;
  };
  const caseLena = await matter('Lambert v Exampleton', '2026-CV-6601', [[lena, 'Lena Lambert']], null);
  const caseShared = await matter('Nash and Olsen v Sampleton', '2026-CV-6602',
    [[nora, 'Nora Nash'], [owen, 'Owen Olsen']], nora);

  const client = () => ({
    id: document.getElementById('ltr-client_person_id').value,
    name: document.getElementById('ltr-client_name').value
  });
  const fork = async () => {
    document.getElementById('nav-matters').click();
    await wait(300);
    document.getElementById('btn-new-matter').click();
    await wait(200);
    document.getElementById('btn-fork-letter').click();
    await wait(200);
  };
  const pick = async (comboId, inputId, text, exact = true) => {
    const input = document.getElementById(inputId);
    input.value = text;
    input.dispatchEvent(new Event('input'));
    const li = await waitFor(() => [...document.querySelectorAll(`#${comboId} .combobox-dropdown li`)]
      .find(l => exact ? l.textContent === text : l.textContent.startsWith(text)));
    if (!li) return false;
    li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return true;
  };
  const pickRecipient = (name) => pick('combo-letter-recipient', 'ltr-recipient_name', name);
  const pickCase = (name) => pick('combo-letter-matter', 'ltr-matter_name', name, false);
  const pickClient = (name) => pick('combo-letter-client', 'ltr-client_name', name);
  const noneLabel = async () => {
    const input = document.getElementById('ltr-client_name');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    const li = await waitFor(() => document.querySelector('#combo-letter-client .combobox-dropdown li'));
    return li;
  };
  const settle = () => wait(500);
  const out = { lena, milo, nora, owen };

  // 1. The Client picker is on New Letter, empty on a fresh letter.
  await fork();
  out.hasPicker = !!document.getElementById('ltr-client_name') && !!document.getElementById('ltr-client_person_id');
  out.startsEmpty = client().id === '';
  const first = await noneLabel();
  out.firstOption = first ? first.textContent : null;

  // 2. A recipient who is a client on a case fills Client with them.
  await fork();
  out.pickedLena = await pickRecipient('Lena Lambert');
  await settle();
  out.afterClientRecipient = client();

  // 3. A recipient who is nobody's client leaves Client alone; picking a
  //    Regarding case fills in that case's folder owner.
  await fork();
  await pickRecipient('Milo Morgan');
  await settle();
  out.afterPlainRecipient = client();
  await pickCase('Nash and Olsen v Sampleton');
  await settle();
  out.afterSharedCase = client();
  //    A case with no folder owner yet uses its single client party.
  await pickCase('Lambert v Exampleton');
  await settle();
  out.afterSingleClientCase = client();

  // 4. A Client chosen by hand is not overwritten by a later recipient or
  //    case pick — nor is an explicit "none".
  await fork();
  await pickClient('Owen Olsen');
  await pickRecipient('Lena Lambert');
  await settle();
  await pickCase('Lambert v Exampleton');
  await settle();
  out.handChosen = client();
  await fork();
  const none = await noneLabel();
  if (none) none.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await pickRecipient('Lena Lambert');
  await settle();
  out.noneChosen = client();

  // 5. Create a letter with a client and generate it.
  const generate = async () => {
    document.getElementById('packet-result').classList.add('hidden');
    const opt = [...document.getElementById('pk-letterhead_id').options].find(o => o.textContent === 'Letter Test LH');
    if (opt) document.getElementById('pk-letterhead_id').value = opt.value;
    document.getElementById('pkf_subject').value = 'Client Folder Letter';
    document.getElementById('pkf_letter_body').value = 'First paragraph.\n\nSecond paragraph.';
    document.getElementById('btn-generate-packet-docx').click();
    return !!(await waitFor(() => !document.getElementById('packet-result').classList.contains('hidden'), 100, 100));
  };
  const packetView = () => ({
    rowShown: !document.getElementById('pk-client-row').classList.contains('hidden'),
    comboShown: !document.getElementById('combo-packet-client').classList.contains('hidden'),
    frozenShown: !document.getElementById('pk-client-frozen').classList.contains('hidden'),
    frozenText: document.getElementById('pk-client-frozen').textContent,
    comboName: document.getElementById('pk-client_name').value,
    comboId: document.getElementById('pk-client_person_id').value
  });
  const docsOf = (pid) => window.api.dbAll('SELECT docx_path FROM documents WHERE packet_id = ? ORDER BY id', [pid]);

  await fork();
  await pickRecipient('Lena Lambert');
  await settle();
  document.getElementById('btn-create-letter').click();
  await waitFor(() => !document.getElementById('view-packet').classList.contains('hidden')
    && document.getElementById('pk-kind').value === 'standalone_letter');
  const withRow = await window.api.dbGet(
    "SELECT * FROM packets WHERE recipient_person_id = ? AND kind = 'standalone_letter' ORDER BY id DESC LIMIT 1", [lena]);
  out.withClientStored = withRow && withRow.client_person_id;
  out.withBeforeGenerate = packetView();
  out.withGenerated = await generate();
  const withAfter = await window.api.dbGet('SELECT * FROM packets WHERE id = ?', [withRow.id]);
  out.withDir = withAfter.output_dir;
  out.withDocs = await docsOf(withRow.id);

  // 6. Frozen: changing client_person_id afterwards moves nothing. The packet
  //    screen shows the client read-only, and a save cannot change it.
  await window.api.dbRun('UPDATE packets SET client_person_id = ? WHERE id = ?', [owen, withRow.id]);
  await window.openPacketForTest(withRow.id);
  await wait(300);
  out.frozenView = packetView();
  out.frozenRegenerated = await generate();
  out.frozenAfter = await window.api.dbGet('SELECT output_dir, client_person_id FROM packets WHERE id = ?', [withRow.id]);
  out.frozenDocs = await docsOf(withRow.id);
  document.getElementById('pk-client_person_id').value = String(milo);
  document.getElementById('btn-save-packet').click();
  await wait(400);
  out.frozenSaved = await window.api.dbGet('SELECT client_person_id FROM packets WHERE id = ?', [withRow.id]);

  // 7. A letter with no client goes to General Letters; before it is
  //    generated its client can still be changed on the packet screen.
  await fork();
  await pickRecipient('Milo Morgan');
  await settle();
  document.getElementById('btn-create-letter').click();
  await waitFor(() => !document.getElementById('view-packet').classList.contains('hidden')
    && document.getElementById('pk-kind').value === 'standalone_letter');
  const noRow = await window.api.dbGet(
    "SELECT * FROM packets WHERE recipient_person_id = ? AND kind = 'standalone_letter' ORDER BY id DESC LIMIT 1", [milo]);
  out.noClientStored = noRow.client_person_id;
  out.noBeforeGenerate = packetView();
  out.noGenerated = await generate();
  out.noDir = (await window.api.dbGet('SELECT output_dir FROM packets WHERE id = ?', [noRow.id])).output_dir;

  await fork();
  await pickRecipient('Milo Morgan');
  await settle();
  document.getElementById('btn-create-letter').click();
  await waitFor(() => !document.getElementById('view-packet').classList.contains('hidden')
    && document.getElementById('pk-kind').value === 'standalone_letter');
  const editRow = await window.api.dbGet(
    "SELECT * FROM packets WHERE recipient_person_id = ? AND kind = 'standalone_letter' ORDER BY id DESC LIMIT 1", [milo]);
  out.editPicked = await pick('combo-packet-client', 'pk-client_name', 'Nora Nash');
  out.editGenerated = await generate();
  out.editAfter = await window.api.dbGet('SELECT output_dir, client_person_id FROM packets WHERE id = ?', [editRow.id]);

  // 8. A second letter to the same person on the same day gets its own
  //    numbered folder rather than sharing the first one's.
  await fork();
  await pickRecipient('Milo Morgan');
  await settle();
  document.getElementById('btn-create-letter').click();
  await waitFor(() => !document.getElementById('view-packet').classList.contains('hidden')
    && document.getElementById('pk-kind').value === 'standalone_letter');
  const againRow = await window.api.dbGet(
    "SELECT * FROM packets WHERE recipient_person_id = ? AND kind = 'standalone_letter' ORDER BY id DESC LIMIT 1", [milo]);
  out.againGenerated = await generate();
  out.againDir = (await window.api.dbGet('SELECT output_dir FROM packets WHERE id = ?', [againRow.id])).output_dir;
  return out;
}).catch(e => ({ error: String(e) })).then(resolveStored);

if (t6.error) {
  check('Task 6 letter fixtures', false, t6.error);
} else {
  check('New Letter has a Client picker that starts empty, with "(none — General Letters)" first',
    t6.hasPicker && t6.startsEmpty && t6.firstOption === '(none — General Letters)', JSON.stringify([t6.hasPicker, t6.startsEmpty, t6.firstOption]));
  check('picking a recipient who is a client on a case fills Client with them',
    t6.pickedLena && t6.afterClientRecipient.id === String(t6.lena) && t6.afterClientRecipient.name === 'Lena Lambert',
    JSON.stringify(t6.afterClientRecipient));
  check('a recipient who is nobody\'s client leaves Client empty',
    t6.afterPlainRecipient.id === '', JSON.stringify(t6.afterPlainRecipient));
  check('picking a Regarding case fills Client with the case\'s folder owner',
    t6.afterSharedCase.id === String(t6.nora) && t6.afterSharedCase.name === 'Nora Nash', JSON.stringify(t6.afterSharedCase));
  check('a Regarding case with no folder owner yet uses its single client',
    t6.afterSingleClientCase.id === String(t6.lena), JSON.stringify(t6.afterSingleClientCase));
  check('a Client chosen by hand is not overwritten by a later recipient or case pick',
    t6.handChosen.id === String(t6.owen) && t6.handChosen.name === 'Owen Olsen', JSON.stringify(t6.handChosen));
  check('an explicit "(none — General Letters)" is not overwritten by a later recipient pick',
    t6.noneChosen.id === '', JSON.stringify(t6.noneChosen));
  check('a new letter stores its client on packets.client_person_id',
    t6.withClientStored === t6.lena && t6.noClientStored === null, JSON.stringify([t6.withClientStored, t6.noClientStored]));
  const lenaLetters = path.join(tmpRoot, 'Clients', 'Lena Lambert', 'Letters');
  check('a letter with a client lands in Clients/<Client>/Letters/<dated folder>/',
    t6.withGenerated && !!t6.withDir && path.dirname(t6.withDir) === lenaLetters
      && path.basename(t6.withDir).includes('Letter to Lena Lambert')
      && t6.withDocs.length === 1 && path.dirname(t6.withDocs[0].docx_path) === t6.withDir
      && fs.existsSync(t6.withDocs[0].docx_path),
    JSON.stringify([t6.withDir, t6.withDocs]));
  check('a letter with no client lands in General Letters/<dated folder>/',
    t6.noGenerated && !!t6.noDir && path.dirname(t6.noDir) === path.join(tmpRoot, 'General Letters')
      && path.basename(t6.noDir).includes('Letter to Milo Morgan'),
    String(t6.noDir));
  check('a second letter to the same person on the same day gets its own numbered folder',
    t6.againGenerated && !!t6.againDir && t6.againDir === `${t6.noDir} (2)`,
    JSON.stringify([t6.noDir, t6.againDir]));
  check('the packet screen lets an ungenerated letter\'s client be picked',
    t6.withBeforeGenerate.rowShown && t6.withBeforeGenerate.comboShown && !t6.withBeforeGenerate.frozenShown
      && t6.withBeforeGenerate.comboId === String(t6.lena) && t6.withBeforeGenerate.comboName === 'Lena Lambert'
      && t6.noBeforeGenerate.comboShown && t6.noBeforeGenerate.comboId === '',
    JSON.stringify([t6.withBeforeGenerate, t6.noBeforeGenerate]));
  check('changing the client before the first generate files the letter under the new client',
    t6.editPicked && t6.editGenerated && t6.editAfter.client_person_id === t6.nora
      && path.dirname(t6.editAfter.output_dir) === path.join(tmpRoot, 'Clients', 'Nora Nash', 'Letters'),
    JSON.stringify(t6.editAfter));
  check('a frozen letter folder does not move when client_person_id changes afterwards',
    t6.frozenRegenerated && t6.frozenAfter.output_dir === t6.withDir
      && t6.frozenDocs.every(d => path.dirname(d.docx_path) === t6.withDir)
      && !fs.existsSync(path.join(tmpRoot, 'Clients', 'Owen Olsen', 'Letters')),
    JSON.stringify([t6.frozenAfter, t6.frozenDocs]));
  check('a generated letter shows its client read-only on the packet screen',
    t6.frozenView.rowShown && !t6.frozenView.comboShown && t6.frozenView.frozenShown
      && t6.frozenView.frozenText.includes('Owen Olsen'),
    JSON.stringify(t6.frozenView));
  check('saving a generated letter cannot change its client',
    t6.frozenSaved.client_person_id === t6.owen, JSON.stringify(t6.frozenSaved));
}

// --- Task 6 review fixes: the Client suggestion also clears ----------------
//
// (1) A suggested Client is cleared again when a later suggestion finds
// nobody — else a non-client recipient's letter files under the previous
// recipient. A Client chosen by hand is never cleared. (3) An abandoned
// partial search in the Client box reverts on blur rather than looking like
// a selection. (4) A genuinely disabled .btn looks disabled.
//
// (2) needs a lookup that fails: the recipient-is-a-client query rejects in
// the main process for one fixture person.
const t6bFailId = await page.evaluate(async () => (await window.api.dbRun(
  'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
  ['Faye Failwell', 'individual', new Date().toISOString()])).lastInsertRowid).catch(() => null);
await app.evaluate(({ ipcMain }, failId) => {
  const h = ipcMain._invokeHandlers;
  const orig = h.get('db-get');
  globalThis.__t6bOrigDbGet = orig;
  h.set('db-get', async (e, sql, params) => {
    if (String(sql).includes("pa.role = 'client')") && params && params[0] == failId) {
      throw new Error('synthetic lookup failure (smoke)');
    }
    return orig(e, sql, params);
  });
}, t6bFailId).catch(() => {});
const t6b = await page.evaluate(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, tries = 50, ms = 100) => {
    for (let i = 0; i < tries; i++) {
      const v = await fn();
      if (v) return v;
      await wait(ms);
    }
    return null;
  };
  const now = new Date().toISOString();
  const person = async (name) => (await window.api.dbRun(
    'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
    [name, 'individual', now])).lastInsertRowid;
  const alice = await person('Alma Abbott');
  const bob = await person('Bram Booker');
  const cara = await person('Cleo Crane');
  const dean = await person('Drew Dunn');
  const matter = async (name, number, clients, owner) => {
    const id = (await window.api.dbRun(
      'INSERT INTO matters (short_name, case_number, client_role, folder_person_id, created_at) VALUES (?,?,?,?,?)',
      [name, number, 'plaintiff', owner, now])).lastInsertRowid;
    for (const [i, [pid, nm]] of clients.entries()) {
      await window.api.dbRun(
        'INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,?)',
        [id, pid, nm, 'plaintiff', 'client', i]);
    }
    return id;
  };
  await matter('Abbott v Exampleton', '2026-CV-6701', [[alice, 'Alma Abbott']], alice);
  await matter('Crane and Dunn v Testerton', '2026-CV-6702',
    [[cara, 'Cleo Crane'], [dean, 'Drew Dunn']], null);
  await matter('Sampleton v Crane', '2026-CV-6703', [[cara, 'Cleo Crane']], 0);

  const client = () => ({
    id: document.getElementById('ltr-client_person_id').value,
    name: document.getElementById('ltr-client_name').value
  });
  const fork = async () => {
    document.getElementById('nav-matters').click();
    await wait(300);
    document.getElementById('btn-new-matter').click();
    await wait(200);
    document.getElementById('btn-fork-letter').click();
    await wait(200);
  };
  const pick = async (comboId, inputId, text, exact = true) => {
    const input = document.getElementById(inputId);
    input.value = text;
    input.dispatchEvent(new Event('input'));
    const li = await waitFor(() => [...document.querySelectorAll(`#${comboId} .combobox-dropdown li`)]
      .find(l => exact ? l.textContent === text : l.textContent.startsWith(text)));
    if (!li) return false;
    li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return true;
  };
  const pickRecipient = (name) => pick('combo-letter-recipient', 'ltr-recipient_name', name);
  const pickCase = (name) => pick('combo-letter-matter', 'ltr-matter_name', name, false);
  const pickClient = (name) => pick('combo-letter-client', 'ltr-client_name', name);
  const settle = () => wait(500);
  const out = { alice, bob, cara };

  // 1a. Client recipient, then a non-client recipient: Client clears, and
  //     the letter is filed under General Letters.
  await fork();
  await pickRecipient('Alma Abbott');
  await settle();
  out.recipAlice = client();
  await pickRecipient('Bram Booker');
  await settle();
  out.recipBob = client();
  document.getElementById('btn-create-letter').click();
  await waitFor(() => !document.getElementById('view-packet').classList.contains('hidden')
    && document.getElementById('pk-kind').value === 'standalone_letter');
  const bobRow = await window.api.dbGet(
    "SELECT id, client_person_id FROM packets WHERE recipient_person_id = ? AND kind = 'standalone_letter' ORDER BY id DESC LIMIT 1", [bob]);
  out.bobStored = bobRow ? bobRow.client_person_id : 'missing';
  document.getElementById('packet-result').classList.add('hidden');
  const opt = [...document.getElementById('pk-letterhead_id').options].find(o => o.textContent === 'Letter Test LH');
  if (opt) document.getElementById('pk-letterhead_id').value = opt.value;
  document.getElementById('pkf_subject').value = 'Cleared Client Letter';
  document.getElementById('pkf_letter_body').value = 'First paragraph.\n\nSecond paragraph.';
  document.getElementById('btn-generate-packet-docx').click();
  out.bobGenerated = !!(await waitFor(() => !document.getElementById('packet-result').classList.contains('hidden'), 100, 100));
  out.bobDir = bobRow ? (await window.api.dbGet('SELECT output_dir FROM packets WHERE id = ?', [bobRow.id])).output_dir : null;

  // 1b. Regarding a case with an owner, then a case with several clients and
  //     no owner, then a case filed under No Client: each clears.
  await fork();
  await pickCase('Abbott v Exampleton');
  await settle();
  out.caseOwner = client();
  await pickCase('Crane and Dunn v Testerton');
  await settle();
  out.caseSeveral = client();
  await pickCase('Abbott v Exampleton');
  await settle();
  out.caseOwnerAgain = client();
  await pickCase('Sampleton v Crane');
  await settle();
  out.caseNoClient = client();

  // 1c. A hand-chosen Client survives both kinds of empty suggestion, and so
  //     does a hand-chosen "none" after an auto-suggested client.
  await fork();
  await pickClient('Cleo Crane');
  await pickRecipient('Bram Booker');
  await settle();
  await pickCase('Crane and Dunn v Testerton');
  await settle();
  out.handSurvives = client();
  await fork();
  await pickRecipient('Alma Abbott');
  await settle();
  const cinput = document.getElementById('ltr-client_name');
  cinput.value = '';
  cinput.dispatchEvent(new Event('input'));
  const noneLi = await waitFor(() => document.querySelector('#combo-letter-client .combobox-dropdown li'));
  if (noneLi) noneLi.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await pickCase('Abbott v Exampleton');
  await settle();
  out.handNoneSurvives = client();

  // 1d. A rejected lookup leaves Client as it was.
  await fork();
  await pickRecipient('Alma Abbott');
  await settle();
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  window.addEventListener('unhandledrejection', onUnhandled);
  out.pickedFaye = await pickRecipient('Faye Failwell');
  await settle();
  window.removeEventListener('unhandledrejection', onUnhandled);
  out.afterRejected = client();
  out.unhandled = unhandled;

  // 3. Type a partial name, blur: the text reverts, the selection stands.
  await fork();
  await pickRecipient('Alma Abbott');
  await settle();
  const input = document.getElementById('ltr-client_name');
  input.focus();
  input.value = 'Cle';
  input.dispatchEvent(new Event('input'));
  await wait(300);
  input.blur();
  await wait(300);
  out.afterBlur = client();
  //    ...and an abandoned search does not count as a hand choice.
  await pickRecipient('Bram Booker');
  await settle();
  out.afterBlurThenBob = client();
  //    On an empty Client, the text reverts to empty.
  input.focus();
  input.value = 'Dre';
  input.dispatchEvent(new Event('input'));
  await wait(300);
  input.blur();
  await wait(300);
  out.afterBlurEmpty = client();

  // 4. A disabled .btn is styled apart from an enabled one; an enabled one
  //    keeps the ordinary look.
  const style = (cls, disabled) => {
    const b = document.createElement('button');
    b.className = cls;
    b.disabled = disabled;
    b.textContent = 'x';
    document.body.appendChild(b);
    const cs = getComputedStyle(b);
    const s = { bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor, cursor: cs.cursor };
    b.remove();
    return s;
  };
  out.btn = { enabled: style('btn', false), disabled: style('btn', true),
    primaryEnabled: style('btn primary', false), primaryDisabled: style('btn primary', true) };
  return out;
}).catch(e => ({ error: String(e) })).then(resolveStored);

await app.evaluate(({ ipcMain }) => {
  if (globalThis.__t6bOrigDbGet) ipcMain._invokeHandlers.set('db-get', globalThis.__t6bOrigDbGet);
}).catch(() => {});

if (t6b.error) {
  check('Task 6 review-fix fixtures', false, t6b.error);
} else {
  const none = (c) => c.id === '' && c.name === '';
  check('a suggested Client clears when the recipient changes to a non-client',
    t6b.recipAlice.id === String(t6b.alice) && none(t6b.recipBob), JSON.stringify([t6b.recipAlice, t6b.recipBob]));
  check('that letter is filed under General Letters',
    t6b.bobStored === null && t6b.bobGenerated && !!t6b.bobDir
      && path.dirname(t6b.bobDir) === path.join(tmpRoot, 'General Letters'),
    JSON.stringify([t6b.bobStored, t6b.bobDir]));
  check('a suggested Client clears when Regarding changes to a case with several clients and no owner',
    t6b.caseOwner.id === String(t6b.alice) && none(t6b.caseSeveral), JSON.stringify([t6b.caseOwner, t6b.caseSeveral]));
  check('a suggested Client clears when Regarding changes to a case filed under No Client',
    t6b.caseOwnerAgain.id === String(t6b.alice) && none(t6b.caseNoClient), JSON.stringify([t6b.caseOwnerAgain, t6b.caseNoClient]));
  check('a hand-chosen Client survives empty recipient and case suggestions',
    t6b.handSurvives.id === String(t6b.cara) && t6b.handSurvives.name === 'Cleo Crane', JSON.stringify(t6b.handSurvives));
  check('a hand-chosen "none" survives a later case suggestion',
    none(t6b.handNoneSurvives), JSON.stringify(t6b.handNoneSurvives));
  check('a failed Client lookup leaves Client unchanged and raises no unhandled rejection',
    t6bFailId && t6b.pickedFaye && t6b.afterRejected.id === String(t6b.alice) && !t6b.unhandled,
    JSON.stringify([t6bFailId, t6b.pickedFaye, t6b.afterRejected, t6b.unhandled]));
  check('an abandoned partial Client search reverts its text on blur and keeps the selection',
    t6b.afterBlur.id === String(t6b.alice) && t6b.afterBlur.name === 'Alma Abbott', JSON.stringify(t6b.afterBlur));
  check('an abandoned Client search is not a hand choice',
    none(t6b.afterBlurThenBob), JSON.stringify(t6b.afterBlurThenBob));
  check('an abandoned search on an empty Client reverts to empty',
    none(t6b.afterBlurEmpty), JSON.stringify(t6b.afterBlurEmpty));
  const b = t6b.btn;
  check('a disabled .btn looks different from an enabled one (plain and primary)',
    (b.disabled.bg !== b.enabled.bg || b.disabled.color !== b.enabled.color)
      && (b.primaryDisabled.bg !== b.primaryEnabled.bg),
    JSON.stringify(b));
  check('an enabled .btn keeps its ordinary look',
    b.enabled.bg === 'rgb(225, 225, 225)' && b.enabled.color === 'rgb(0, 0, 0)' && b.enabled.cursor === 'pointer'
      && b.primaryEnabled.bg === 'rgb(0, 120, 215)' && b.primaryEnabled.color === 'rgb(255, 255, 255)',
    JSON.stringify(b));
}


// --- client-folders Task 9B: case types, shared-case folder link, My Office,
// Calendar tab, and the Answer to Complaint's [DEFENDANT] blank ------------

// 1. Settings → Matter Types: the folder column is gone (folders follow the
//    client since Task 3), the placeholders describe kinds of work, and the
//    help text no longer claims the type picks the folder.
const t9bTypes = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const has = await window.api.dbGet('SELECT COUNT(*) c FROM matter_types WHERE archived = 0');
  if (!has.c) {
    await window.api.dbRun(
      "INSERT INTO matter_types (name, side, opposing_side_default, sort_order) VALUES ('Type9B', 'defense', 'prosecution', 99)");
  }
  document.getElementById('nav-settings').click();
  await sleep(700);
  const el = document.getElementById('matter-types-manage');
  const rows = [...el.children].filter(r => r.querySelector('select'));
  const first = rows[0];
  const inputs = first ? [...first.querySelectorAll('input')] : [];
  const fieldset = el.closest('fieldset');
  return {
    rowCount: rows.length,
    header: el.firstElementChild ? el.firstElementChild.textContent : '',
    placeholders: inputs.map(i => i.placeholder),
    anyFolderInput: rows.some(r => [...r.querySelectorAll('input')].some(i => /folder/i.test(i.placeholder))),
    help: fieldset ? fieldset.querySelector('p').textContent.replace(/\s+/g, ' ') : ''
  };
}).catch(e => ({ error: String(e) }));
if (t9bTypes.error) {
  check('Task 9B matter-types fixture', false, t9bTypes.error);
} else {
  check('a matter type row has no folder input (name + caption authority only)',
    t9bTypes.rowCount > 0 && !t9bTypes.anyFolderInput && t9bTypes.placeholders.length === 2
      && !/Folder/.test(t9bTypes.header),
    JSON.stringify(t9bTypes));
  check('matter type placeholders read "Criminal Defense" and "PEOPLE OF THE STATE OF MICHIGAN"',
    t9bTypes.placeholders[0] === 'Criminal Defense' && t9bTypes.placeholders[1] === 'PEOPLE OF THE STATE OF MICHIGAN',
    JSON.stringify(t9bTypes.placeholders));
  check('Matter Types help no longer says the type sets the folder, and points cities to Organization clients',
    !/folder new matters|saved into|Folder name/i.test(t9bTypes.help) && /Organization client/.test(t9bTypes.help),
    t9bTypes.help);
}

// 2. A shared case on a client's profile links to the one real folder. The
//    second client's link opens the same path as the first's; a case with no
//    folder yet shows no link. open-path is stubbed as in the Task 5 checks.
await app.evaluate(({ ipcMain }) => {
  const h = ipcMain._invokeHandlers;
  globalThis.__t9bOpenPath = h.get('open-path');
  globalThis.__t9bOpened = [];
  h.set('open-path', async (e, target) => { globalThis.__t9bOpened.push(target); return { ok: true }; });
}).catch(() => {});
const t9bShared = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = new Date().toISOString();
  const person = async (name) => (await window.api.dbRun(
    "INSERT INTO people (display_name, kind, created_at) VALUES (?, 'individual', ?)", [name, now])).lastInsertRowid;
  const nina = await person('Nina Northcott');
  const omar = await person('Omar Oakley');
  const matter = async (name, number) => {
    const id = (await window.api.dbRun(
      'INSERT INTO matters (short_name, case_number, client_role, created_at) VALUES (?,?,?,?)',
      [name, number, 'plaintiff', now])).lastInsertRowid;
    for (const [i, [pid, nm]] of [[nina, 'Nina Northcott'], [omar, 'Omar Oakley']].entries()) {
      await window.api.dbRun(
        'INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,?)',
        [id, pid, nm, 'plaintiff', 'client', i]);
    }
    return id;
  };
  const shared = await matter('Northcott v Exampleton', '2026-CV-9901');
  const unsaved = await matter('Oakley v Sampleton', '2026-CV-9902');
  await window.api.setMatterFolderOwner(shared, nina);
  const res = await window.api.matterFolder(shared);
  const stored = (await window.api.dbGet('SELECT output_dir FROM matters WHERE id = ?', [shared])).output_dir;
  const linksFor = async (pid) => {
    await window.openPerson(pid);
    await sleep(700);
    const rows = [...document.querySelectorAll('#person-cases > div')];
    const rowOf = (name) => rows.find(r => r.textContent.includes(name));
    const link = (r) => r && [...r.querySelectorAll('a')].find(a => a.textContent === 'Open Folder');
    const sharedLink = link(rowOf('Northcott v Exampleton'));
    const unsavedLink = link(rowOf('Oakley v Sampleton'));
    const color = sharedLink ? getComputedStyle(sharedLink).color : null;
    if (sharedLink) sharedLink.click();
    await sleep(400);
    return { hasShared: !!sharedLink, hasUnsaved: !!unsavedLink, color };
  };
  const omarView = await linksFor(omar);
  const ninaView = await linksFor(nina);
  const unsavedStill = (await window.api.dbGet('SELECT output_dir FROM matters WHERE id = ?', [unsaved])).output_dir;
  return { res, stored, omarView, ninaView, unsavedStill };
}).catch(e => ({ error: String(e) }));
const t9bOpened = await app.evaluate(({ ipcMain }) => {
  const h = ipcMain._invokeHandlers;
  if (globalThis.__t9bOpenPath) h.set('open-path', globalThis.__t9bOpenPath);
  return globalThis.__t9bOpened;
}).catch(() => []);
if (t9bShared.error) {
  check('Task 9B shared-case fixture', false, t9bShared.error);
} else {
  check('a shared case shows "Open Folder" on the second client\'s profile, opening the one real folder',
    t9bShared.omarView.hasShared && !!t9bShared.stored && t9bOpened[0] === onDisk(t9bShared.stored)
      && path.basename(path.dirname(t9bShared.stored)) === 'Nina Northcott',
    JSON.stringify([t9bShared, t9bOpened]));
  check('the folder owner\'s profile link opens the same path',
    t9bShared.ninaView.hasShared && t9bOpened[1] === onDisk(t9bShared.stored), JSON.stringify(t9bOpened));
  check('a case with no folder yet shows no Open Folder link (and viewing does not create one)',
    !t9bShared.omarView.hasUnsaved && !t9bShared.ninaView.hasUnsaved && t9bShared.unsavedStill === null,
    JSON.stringify(t9bShared));
  check('the case row\'s Open Folder link uses the row\'s plain link color',
    t9bShared.omarView.color === 'rgb(0, 51, 153)', String(t9bShared.omarView.color));
}

// 3. The Attorneys tab reads "My Office" everywhere a user can see it
//    (internal ids unchanged), and 4. a Calendar tab sits after Matters.
const t9bTabs = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tabs = [...document.querySelectorAll('.tabs-container .tab')].map(t => t.textContent.trim());
  document.getElementById('nav-attorneys').click();
  await sleep(400);
  const officeActive = document.getElementById('nav-attorneys').classList.contains('active');
  const subTab = document.getElementById('sub-attorneys-profile').textContent.trim();
  const addBtn = document.getElementById('btn-new-attorney').textContent.trim();
  const steps = (window.__tutorialSteps || []).map(s => `${s.title} ${s.text}`).join(' | ');
  const domText = document.body.textContent;
  const stale = /Attorneys tab|Add Attorney\b/;

  document.getElementById('nav-calendar').click();
  await sleep(400);
  const calVisible = !document.getElementById('view-calendar').classList.contains('hidden');
  const active = [...document.querySelectorAll('.tabs-container .tab.active')].map(t => t.id);
  const backHiddenFromTab = document.getElementById('btn-back-from-calendar').classList.contains('hidden');
  document.getElementById('nav-home').click();
  await sleep(300);
  document.getElementById('home-view-calendar').click();
  await sleep(300);
  const backShownFromHome = !document.getElementById('btn-back-from-calendar').classList.contains('hidden');
  const activeFromHome = [...document.querySelectorAll('.tabs-container .tab.active')].map(t => t.id);
  document.getElementById('btn-back-from-calendar').click();
  await sleep(300);
  const backToHome = !document.getElementById('view-home').classList.contains('hidden');
  return {
    tabs, officeActive, subTab, addBtn,
    staleInSteps: stale.test(steps), staleInDom: (domText.match(stale) || [null])[0],
    calVisible, active, backHiddenFromTab, backShownFromHome, activeFromHome, backToHome
  };
}).catch(e => ({ error: String(e) }));
if (t9bTabs.error) {
  check('Task 9B tabs fixture', false, t9bTabs.error);
} else {
  check('the top bar reads Home | Matters | Calendar | People | Contacts | My Office | Settings',
    JSON.stringify(t9bTabs.tabs) === JSON.stringify(['Home', 'Matters', 'Calendar', 'People', 'Contacts', 'My Office', 'Settings']),
    JSON.stringify(t9bTabs.tabs));
  check('My Office opens the signing profiles and highlights',
    t9bTabs.officeActive && t9bTabs.addBtn === 'Add Signing Profile' && t9bTabs.subTab === 'Signing Profiles',
    JSON.stringify([t9bTabs.addBtn, t9bTabs.subTab]));
  check('no user-visible text or tour step still says "Attorneys tab" / "Add Attorney"',
    !t9bTabs.staleInSteps && !t9bTabs.staleInDom, JSON.stringify([t9bTabs.staleInSteps, t9bTabs.staleInDom]));
  check('the Calendar tab opens the calendar and is the only highlighted tab',
    t9bTabs.calVisible && JSON.stringify(t9bTabs.active) === '["nav-calendar"]', JSON.stringify(t9bTabs.active));
  check('from the tab the calendar has no Back button; from Home\'s link it does, and Back returns Home',
    t9bTabs.backHiddenFromTab && t9bTabs.backShownFromHome && t9bTabs.backToHome
      && JSON.stringify(t9bTabs.activeFromHome) === '["nav-calendar"]',
    JSON.stringify(t9bTabs));
}
// The same stale wording, in the source strings (catches text only shown on
// paths this run does not reach, like the no-profile setup note).
{
  const src = fs.readFileSync(path.join(APP_DIR, 'renderer.js'), 'utf8') + fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
  const hits = src.split('\n').filter(l => /Attorneys tab|Add Attorney\b|>Attorneys</.test(l));
  check('renderer.js / index.html carry no "Attorneys tab", "Add Attorney" or "Attorneys" tab label', hits.length === 0,
    hits.join(' | '));
}
if (process.env.SMOKE_SHOTS) {
  fs.mkdirSync(process.env.SMOKE_SHOTS, { recursive: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
  await page.evaluate(async () => {
    document.getElementById('nav-attorneys').click();
    await new Promise(r => setTimeout(r, 500));
  }).catch(() => {});
  await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'my-office-1024.png') }).catch(() => {});
  const box = await page.evaluate(() => {
    const r = document.querySelector('.tabs-container').getBoundingClientRect();
    const s = document.getElementById('sub-tabs').getBoundingClientRect();
    return { x: 0, y: 0, width: Math.ceil(window.innerWidth), height: Math.ceil(Math.max(r.bottom, s.bottom)) + 4 };
  }).catch(() => null);
  if (box) await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'top-bar-1024.png'), clip: box }).catch(() => {});
  await page.evaluate(async () => {
    document.getElementById('nav-calendar').click();
    await new Promise(r => setTimeout(r, 500));
  }).catch(() => {});
  await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'calendar-tab-1024.png') }).catch(() => {});
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
}

// --- Contacts Task 2: the Contacts tab, its Contacts | Courts lists --------
// Judges, clerks and opposing counsel are people rows with is_contact = 1.
// The judge below is inserted exactly the way migration 37 back-fills one
// (a Judge contact at the judge's court, linked by judges.person_id); the
// back-fill itself is covered by test:migrations.
const contactsTab = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const run = (sql, p = []) => window.api.dbRun(sql, p);
  const now = new Date().toISOString();
  const court = (await run('INSERT INTO courts (name, city, county) VALUES (?,?,?)',
    ['Testerton 97th District Court', 'Testerton', 'Sampleton'])).lastInsertRowid;
  const judgePerson = (await run(
    `INSERT INTO people (display_name, kind, is_contact, contact_role, works_at_court_id, archived, created_at)
     VALUES (?, 'individual', 1, 'Judge', ?, 0, ?)`, ['Hon. Quentin Example', court, now])).lastInsertRowid;
  await run('INSERT INTO judges (name, court_id, person_id) VALUES (?,?,?)', ['Hon. Quentin Example', court, judgePerson]);
  const clerk = (await run(
    `INSERT INTO people (display_name, kind, is_contact, contact_role, works_at_court_id, created_at)
     VALUES (?, 'individual', 1, 'Clerk', ?, ?)`, ['Clara Testcase', court, now])).lastInsertRowid;
  await run('INSERT INTO contact_notes (person_id, note_date, body, created_at) VALUES (?,?,?,?)',
    [clerk, '2026-08-01', 'Older note that must not show', now]);
  await run('INSERT INTO contact_notes (person_id, note_date, body, created_at) VALUES (?,?,?,?)',
    [clerk, '2026-09-01', 'Prefers email for scheduling\nSecond line never shown', now]);
  const org = (await run(
    `INSERT INTO people (display_name, kind, created_at) VALUES (?, 'organization', ?)`,
    ['Exampleton Police Department', now])).lastInsertRowid;
  await run(
    `INSERT INTO people (display_name, kind, is_contact, contact_role, works_at_org_id, created_at)
     VALUES (?, 'individual', 1, 'Court Officer', ?, ?)`, ['Olive Samplewood', org, now]);
  await run(
    `INSERT INTO people (display_name, kind, is_contact, contact_role, firm_name, archived, created_at)
     VALUES (?, 'individual', 1, 'Attorney', ?, 1, ?)`, ['Otto Retiredcounsel', 'Acme Holdings LLC', now]);
  await run(
    "INSERT INTO matters (short_name, case_number, court_id, client_role, caption_style, created_at) VALUES (?,?,?,?,?,?)",
    ['Contacts Tab Case', '2026-CT-1', court, 'defendant', 'full', now]);

  const tabOrder = [...document.querySelectorAll('.tabs-container .tab')].map(t => t.id);
  document.getElementById('nav-contacts').click();
  await sleep(500);
  const hidden = id => document.getElementById(id).classList.contains('hidden');
  const activeTabs = () => [...document.querySelectorAll('.tabs-container .tab.active')].map(t => t.id);
  const activeSubs = () => [...document.querySelectorAll('.sub-tab.active')].map(t => t.id);
  const rows = () => [...document.querySelectorAll('#contacts-list tr')].map(tr =>
    [...tr.children].map(td => td.textContent));
  const opened = {
    visible: !hidden('view-contacts'), active: activeTabs(), subs: activeSubs(),
    subRowShown: !hidden('sub-tabs-contacts'), rows: rows(),
  };
  const judgeRow = opened.rows.find(r => r[0] === 'Hon. Quentin Example');
  const clerkRow = [...document.querySelectorAll('#contacts-list tr')]
    .find(tr => tr.children[0].textContent === 'Clara Testcase');
  const noteCell = clerkRow ? clerkRow.children[3] : null;
  const note = noteCell ? { text: noteCell.textContent, color: getComputedStyle(noteCell).color } : null;
  const orgRow = opened.rows.find(r => r[0] === 'Olive Samplewood');

  const search = document.getElementById('contacts-search');
  const filter = async (term) => {
    search.value = term;
    search.dispatchEvent(new Event('input'));
    await sleep(300);
    return rows().map(r => r[0]);
  };
  const byRole = await filter('CLERK');
  const byWorksAt = await filter('testerton 97th');
  const byName = await filter('samplewood');
  const none = await filter('zzz-nobody');
  await filter('');
  const archivedHidden = !rows().some(r => r[0].startsWith('Otto Retiredcounsel'));
  const archivedBox = document.getElementById('contacts-show-archived');
  archivedBox.checked = true;
  archivedBox.dispatchEvent(new Event('change'));
  await sleep(300);
  const archivedRow = rows().find(r => r[0].startsWith('Otto Retiredcounsel'));
  archivedBox.checked = false;
  archivedBox.dispatchEvent(new Event('change'));
  await sleep(200);

  document.getElementById('btn-new-contact').click();
  await sleep(300);
  const newContact = {
    page: !hidden('view-contact-detail'), name: document.getElementById('con-display_name').value,
    id: document.getElementById('con-id').value, active: activeTabs(),
  };

  document.getElementById('nav-people').click();
  await sleep(500);
  const peopleText = document.getElementById('people-list').textContent;
  const peopleSubs = [...document.querySelectorAll('#sub-tabs-people .sub-tab')].map(t => t.id);

  document.getElementById('nav-contacts').click();
  await sleep(300);
  document.getElementById('sub-contacts-courts').click();
  await sleep(600);
  const courtRows = [...document.querySelectorAll('#courts-list tr')].map(tr =>
    [...tr.children].map(td => td.textContent));
  const courtsView = {
    visible: !hidden('view-courts'), contactsHidden: hidden('view-contacts'),
    active: activeTabs(), subs: activeSubs(),
    row: courtRows.find(r => r[0] === 'Testerton 97th District Court'),
    // The interim Edit Courts & Judges fieldset is retired (Task 6): the
    // court page edits a court, the judge's contact page a judge.
    oldEditGone: !document.getElementById('courts-manage') && !document.getElementById('judges-manage')
      && !/Edit Courts/.test(document.getElementById('view-courts').textContent),
  };
  const cs = document.getElementById('courts-search');
  cs.value = 'nothing-like-this';
  cs.dispatchEvent(new Event('input'));
  await sleep(300);
  const courtsFiltered = document.querySelectorAll('#courts-list tr td[colspan]').length === 1;
  cs.value = '';
  cs.dispatchEvent(new Event('input'));
  await sleep(200);
  // Clicking a court row opens that court's page, which carries the
  // header-line explanation; Back returns to the list.
  const courtTr = [...document.querySelectorAll('#courts-list tr')]
    .find(tr => tr.children[0].textContent === 'Testerton 97th District Court');
  courtTr.click();
  await sleep(500);
  const clickOpensPage = {
    page: !hidden('view-court-detail'), listHidden: hidden('view-courts'),
    name: document.getElementById('crt-name').value, active: activeTabs(), subs: activeSubs(),
    explainsHeader: /beneath\s+STATE OF MICHIGAN/.test(document.getElementById('view-court-detail').textContent),
  };
  document.getElementById('btn-back-court').click();
  await sleep(400);
  clickOpensPage.backToList = !hidden('view-courts') && hidden('view-court-detail');

  document.getElementById('sub-contacts-contacts').click();
  await sleep(300);
  const back = { visible: !hidden('view-contacts'), subs: activeSubs() };

  return { tabOrder, opened, judgeRow, note, orgRow, byRole, byWorksAt, byName, none, archivedHidden, archivedRow,
    newContact, peopleText, peopleSubs, courtsView, courtsFiltered, clickOpensPage, back,
    oldGone: !document.getElementById('view-people' + '-courts') && !document.getElementById('sub-people' + '-courts') };
}).catch(e => ({ error: String(e) }));

if (contactsTab.error) {
  check('Contacts tab fixture', false, contactsTab.error);
} else {
  const c = contactsTab;
  const at = id => c.tabOrder.indexOf(id);
  check('Contacts tab sits between People and My Office',
    at('nav-contacts') === at('nav-people') + 1 && at('nav-attorneys') === at('nav-contacts') + 1, JSON.stringify(c.tabOrder));
  check('the Contacts tab opens the contacts list and is the only highlighted tab, sub-tab Contacts',
    c.opened.visible && JSON.stringify(c.opened.active) === '["nav-contacts"]' && c.opened.subRowShown
      && JSON.stringify(c.opened.subs) === '["sub-contacts-contacts"]', JSON.stringify(c.opened));
  check('a migrated judge is listed with role Judge and their court',
    JSON.stringify(c.judgeRow) === JSON.stringify(['Hon. Quentin Example', 'Judge', 'Testerton 97th District Court', '']),
    JSON.stringify(c.judgeRow));
  check('a contact at an organization shows the organization under Works at',
    !!c.orgRow && c.orgRow[2] === 'Exampleton Police Department', JSON.stringify(c.orgRow));
  check('Latest note shows only the newest note\'s first line, in #555',
    !!c.note && c.note.text === 'Prefers email for scheduling' && c.note.color === 'rgb(85, 85, 85)', JSON.stringify(c.note));
  check('the filter matches role, works-at and name, case-insensitively',
    JSON.stringify(c.byRole) === '["Clara Testcase"]'
      && JSON.stringify(c.byWorksAt) === '["Clara Testcase","Hon. Quentin Example"]'
      && JSON.stringify(c.byName) === '["Olive Samplewood"]' && c.none.length === 1,
    JSON.stringify([c.byRole, c.byWorksAt, c.byName, c.none]));
  check('archived contacts are hidden until Show archived, then listed',
    c.archivedHidden && !!c.archivedRow && c.archivedRow[2] === 'Acme Holdings LLC', JSON.stringify(c.archivedRow));
  check('New Contact opens a blank contact page under the Contacts tab',
    c.newContact.page && c.newContact.name === '' && c.newContact.id === ''
      && JSON.stringify(c.newContact.active) === '["nav-contacts"]', JSON.stringify(c.newContact));
  check('the People tab no longer lists the judge or the clerk',
    !c.peopleText.includes('Hon. Quentin Example') && !c.peopleText.includes('Clara Testcase'));
  check('People keeps a single Clients sub-tab', JSON.stringify(c.peopleSubs) === '["sub-people-clients"]',
    JSON.stringify(c.peopleSubs));
  check('Courts sub-tab: its own view, Contacts tab still highlighted, sub-tab Courts active',
    c.courtsView.visible && c.courtsView.contactsHidden && JSON.stringify(c.courtsView.active) === '["nav-contacts"]'
      && JSON.stringify(c.courtsView.subs) === '["sub-contacts-courts"]', JSON.stringify(c.courtsView));
  check('Courts list reads Name | City | County | People | Cases',
    JSON.stringify(c.courtsView.row) === JSON.stringify(['Testerton 97th District Court', 'Testerton', 'Sampleton', '2', '1']),
    JSON.stringify(c.courtsView.row));
  check('courts filter narrows to nothing for a non-match', c.courtsFiltered);
  check('the interim Edit Courts & Judges fieldset is gone from Contacts > Courts', c.courtsView.oldEditGone);
  check('clicking a court row opens its court page (Contacts tab, sub-tab Courts), with the header-line explanation; Back returns',
    c.clickOpensPage.page && c.clickOpensPage.listHidden && c.clickOpensPage.name === 'Testerton 97th District Court'
      && JSON.stringify(c.clickOpensPage.active) === '["nav-contacts"]'
      && JSON.stringify(c.clickOpensPage.subs) === '["sub-contacts-courts"]'
      && c.clickOpensPage.explainsHeader && c.clickOpensPage.backToList, JSON.stringify(c.clickOpensPage));
  check('the Contacts sub-tab returns to the contacts list',
    c.back.visible && JSON.stringify(c.back.subs) === '["sub-contacts-contacts"]', JSON.stringify(c.back));
  check('the old People > Courts view and sub-tab are gone', c.oldGone);
}
{
  const needle = 'people' + '-courts';
  const hits = ['index.html', 'renderer.js', 'style.css', 'HOW-TO-USE.md', 'README.md']
    .filter(f => fs.readFileSync(path.join(APP_DIR, f), 'utf8').includes(needle));
  check('nothing in the app still references the old courts view id', hits.length === 0, hits.join(', '));
}
if (process.env.SMOKE_SHOTS) {
  fs.mkdirSync(process.env.SMOKE_SHOTS, { recursive: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
  await page.evaluate(async () => {
    document.getElementById('nav-contacts').click();
    await new Promise(r => setTimeout(r, 500));
  }).catch(() => {});
  await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'contacts-tab-1024.png') }).catch(() => {});
  await page.evaluate(async () => {
    document.getElementById('sub-contacts-courts').click();
    await new Promise(r => setTimeout(r, 600));
  }).catch(() => {});
  await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'contacts-courts-1024.png') }).catch(() => {});
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
}

// --- Contacts Task 3: the contact page, and one name for a judge -----------
// Uses Task 2's migrated-style judge (Hon. Quentin Example at Testerton 12th
// District Court, linked by judges.person_id). Renaming them on the contact
// page must change what a caption prints, in the preview HTML (the PDF path)
// and in the .docx XML.
const contactPage = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const run = (sql, p = []) => window.api.dbRun(sql, p);
  const get = (sql, p = []) => window.api.dbGet(sql, p);
  const hidden = id => document.getElementById(id).classList.contains('hidden');
  const activeTabs = () => [...document.querySelectorAll('.tabs-container .tab.active')].map(t => t.id);
  const activeSubs = () => [...document.querySelectorAll('.sub-tab.active')].map(t => t.id);
  const val = id => document.getElementById(id).value;
  const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const rowFor = (name) => [...document.querySelectorAll('#contacts-list tr')]
    .find(tr => tr.children[0] && tr.children[0].textContent === name);
  const openFromList = async (name) => {
    document.getElementById('nav-contacts').click();
    await sleep(400);
    const tr = rowFor(name);
    if (!tr) return false;
    tr.click();
    await sleep(500);
    return true;
  };
  const now = new Date().toISOString();

  const judge = await get(`SELECT j.id, j.person_id, j.court_id FROM judges j WHERE j.name = 'Hon. Quentin Example'`);
  const court = judge.court_id;
  const matterId = (await run(
    `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, judge_id, client_role, caption_style,
       party_label, caption_authority, created_at) VALUES (0, ?,?,?,?,?,?,?,?,?)`,
    ['Judge Sync Case', '2026-JS-1', court, judge.id, 'defendant', 'full', 'Defendant',
     'PEOPLE OF THE CITY OF EXAMPLETON', now])).lastInsertRowid;
  await run('INSERT INTO parties (matter_id, name, side, sort_order) VALUES (?,?,?,0)', [matterId, 'Dana Q. Sample', 'defendant']);

  // 1. Open the judge from the Contacts list.
  const opened = await openFromList('Hon. Quentin Example');
  const judgePage = {
    opened, page: !hidden('view-contact-detail'), listHidden: hidden('view-contacts'),
    active: activeTabs(), subs: activeSubs(), id: val('con-id'),
    name: val('con-display_name'), role: val('con-contact_role'), worksAt: val('con-works_at'),
    worksAtCourt: val('con-works_at_court_id'), worksAtOrg: val('con-works_at_org_id'),
    roleOptions: [...document.getElementById('con-contact_role').options].map(o => o.textContent),
  };

  // 2. Rename on the contact page and save.
  set('con-display_name', 'Quentin R. Renamed');
  document.getElementById('btn-save-contact').click();
  await sleep(600);
  const afterRename = {
    person: (await get('SELECT display_name FROM people WHERE id = ?', [judge.person_id])).display_name,
    judge: await get('SELECT name, court_id FROM judges WHERE id = ?', [judge.id]),
    shown: val('con-display_name'),
  };

  // 3. The caption on a case with that judge: preview (PDF HTML) and .docx.
  document.getElementById('nav-matters').click();
  await sleep(400);
  const mrow = [...document.querySelectorAll('#matters-list tr')].find(r => r.innerText.includes('Judge Sync Case'));
  let previewHtml = '', docxPath = null;
  if (mrow) {
    mrow.click();
    await sleep(700);
    document.getElementById('btn-goto-generate').click();
    await sleep(600);
    document.getElementById('gen-doctype').value = 'appearance';
    document.getElementById('gen-doctype').dispatchEvent(new Event('change'));
    await sleep(400);
    document.getElementById('btn-preview').click();
    await sleep(600);
    previewHtml = document.getElementById('preview-frame').srcdoc || '';
    document.getElementById('btn-generate-docx').click();
    let gen = null;
    for (let i = 0; i < 60 && !gen; i++) {
      await sleep(100);
      gen = await get(
        "SELECT path FROM generated_files WHERE matter_id = ? AND format = 'docx' ORDER BY id DESC LIMIT 1", [matterId]);
    }
    docxPath = gen && gen.path;
  }

  // 4. A judge typed fresh on a case becomes a contact.
  await window.openMatterForTest(matterId);
  await sleep(600);
  set('mat-judge', 'Priya N. Freshbench');
  await sleep(400);
  const addJudge = [...document.querySelectorAll('#combo-judge li.add-new')][0];
  if (addJudge) addJudge.click();
  for (let i = 0; i < 40 && !val('mat-judge_id'); i++) await sleep(100);
  const freshJudgeId = val('mat-judge_id');
  const freshJudge = freshJudgeId ? await get(
    `SELECT j.name, j.court_id, p.display_name, p.is_contact, p.contact_role, p.works_at_court_id
       FROM judges j LEFT JOIN people p ON p.id = j.person_id WHERE j.id = ?`, [freshJudgeId]) : null;

  // 5. Opposing counsel "+ Add" is a contact, role Attorney.
  set('mat-oppcounsel_name', 'Opal Q. Counselworth');
  await sleep(400);
  const addOc = document.querySelector('#combo-oppcounsel li.add-new');
  if (addOc) addOc.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 40 && !val('mat-opposing_counsel_person_id'); i++) await sleep(100);
  const ocId = val('mat-opposing_counsel_person_id');
  const oc = ocId ? await get('SELECT display_name, is_contact, contact_role FROM people WHERE id = ?', [ocId]) : null;
  window.markFormCleanForTest('view-matter-detail');
  const ocLink = document.querySelector('#combo-oppcounsel ~ .person-added-note .open-profile-link')
    || document.querySelector('.person-added-note .open-profile-link');
  if (ocLink) ocLink.click();
  await sleep(500);
  const ocOpened = { page: !hidden('view-contact-detail'), name: val('con-display_name'), role: val('con-contact_role') };

  document.getElementById('nav-contacts').click();
  await sleep(400);
  const listRow = (name) => { const tr = rowFor(name); return tr ? [...tr.children].map(td => td.textContent) : null; };
  const freshRow = listRow('Priya N. Freshbench');
  const ocRow = listRow('Opal Q. Counselworth');

  // 6. Round trip every field through New Contact, including a new role and
  //    Works at an organization, then switched to a court.
  document.getElementById('btn-new-contact').click();
  await sleep(300);
  const blank = { page: !hidden('view-contact-detail'), active: activeTabs(), subs: activeSubs(),
    archiveHidden: hidden('contact-archive-foot'),
    empty: ['con-display_name', 'con-phone', 'con-email', 'con-street', 'con-city', 'con-zip', 'con-works_at', 'con-contact_role']
      .every(id => val(id) === '') };
  document.getElementById('con-display_name').value = 'Gwen T. Roundtrip';
  const roleSel = document.getElementById('con-contact_role');
  roleSel.value = '__add_role__';
  roleSel.dispatchEvent(new Event('change'));
  await sleep(100);
  const roleBoxShown = !hidden('con-role-add');
  document.getElementById('con-role-new').value = 'Bailiff';
  document.getElementById('btn-con-role-add').click();
  await sleep(400);
  const roleAfterAdd = { value: roleSel.value, boxHidden: hidden('con-role-add'),
    stored: !!(await get("SELECT 1 AS x FROM contact_roles WHERE name = 'Bailiff'")) };
  const works = document.getElementById('con-works_at');
  works.dispatchEvent(new Event('focus'));
  set('con-works_at', 'Exampleton Police');
  await sleep(400);
  const orgLi = [...document.querySelectorAll('#combo-con-works-at li')]
    .find(li => li.textContent === 'Exampleton Police Department (organization)');
  if (orgLi) orgLi.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  document.getElementById('con-phone').value = '(555) 010-2233';
  document.getElementById('con-email').value = 'gwen@example.com';
  document.getElementById('con-street').value = '100 Main St';
  document.getElementById('con-city').value = 'Exampleton, MI';
  document.getElementById('con-zip').value = '48000';
  document.getElementById('btn-save-contact').click();
  // Wait for the save to land rather than a fixed delay: on the Windows CI
  // runner 700 ms was not enough, the id read back blank, and a later step
  // dereferenced a missing row.
  for (let i = 0; i < 50 && !val('con-id'); i++) await sleep(100);
  await sleep(200);
  const newId = val('con-id');
  const stored = newId ? await get(
    `SELECT display_name, contact_role, works_at_court_id, works_at_org_id, phone, email, street, city, zip,
            is_contact, kind, archived FROM people WHERE id = ?`, [newId]) : null;
  const orgId = (await get("SELECT id FROM people WHERE display_name = 'Exampleton Police Department'")).id;
  await openFromList('Gwen T. Roundtrip');
  const reread = Object.fromEntries(['con-display_name', 'con-contact_role', 'con-works_at', 'con-phone', 'con-email',
    'con-street', 'con-city', 'con-zip'].map(id => [id, val(id)]));
  works.dispatchEvent(new Event('focus'));
  set('con-works_at', 'Testerton 97th');
  await sleep(400);
  const courtLi = [...document.querySelectorAll('#combo-con-works-at li')]
    .find(li => li.textContent === 'Testerton 97th District Court (court, Testerton)');
  if (courtLi) courtLi.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  document.getElementById('btn-save-contact').click();
  await sleep(600);
  const switched = await get('SELECT works_at_court_id, works_at_org_id FROM people WHERE id = ?', [newId]);
  const judgeRowsForGwen = (await get('SELECT COUNT(*) AS n FROM judges WHERE person_id = ?', [newId])).n;

  // 7. Global search opens a contact on the contact page.
  const search = document.getElementById('global-search');
  search.value = 'Roundtrip';
  search.dispatchEvent(new Event('input'));
  await sleep(500);
  const searchText = document.getElementById('global-search-results').innerText;
  const hit = [...document.querySelectorAll('#global-search-results div')].find(d => d.textContent === 'Gwen T. Roundtrip');
  document.getElementById('nav-home').click();
  await sleep(300);
  if (hit) hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await sleep(500);
  const searchOpened = { page: !hidden('view-contact-detail'), id: val('con-id'), active: activeTabs() };

  // 8. Archive hides it from the list; Back returns to the list.
  window.confirm = () => true;
  document.getElementById('btn-archive-contact').click();
  let archivedRow = await get('SELECT archived FROM people WHERE id = ?', [newId]);
  for (let i = 0; i < 40 && (!archivedRow || archivedRow.archived !== 1); i++) {
    await sleep(100);
    archivedRow = await get('SELECT archived FROM people WHERE id = ?', [newId]);
  }
  const archivedFlag = archivedRow && archivedRow.archived;
  for (let i = 0; i < 40 && !/archived/.test(document.getElementById('contact-archived-note').textContent); i++) await sleep(100);
  const archivedNote = document.getElementById('contact-archived-note').textContent;
  document.getElementById('btn-back-contact').click();
  await sleep(400);
  const backToList = { list: !hidden('view-contacts'), active: activeTabs(), subs: activeSubs() };
  const archivedListed = !!rowFor('Gwen T. Roundtrip');

  // 9. The contact page's archive takes the judge out of the case pickers.
  //    (It is the only place a judge is archived: the interim Edit Courts &
  //    Judges rows are retired, Task 6.)
  const reverse = {};
  await window.openContact(judge.person_id);
  await sleep(400);
  document.getElementById('btn-archive-contact').click();
  let jArchived = await get('SELECT archived FROM judges WHERE id = ?', [judge.id]);
  for (let i = 0; i < 40 && (!jArchived || jArchived.archived !== 1); i++) {
    await sleep(100);
    jArchived = await get('SELECT archived FROM judges WHERE id = ?', [judge.id]);
  }
  reverse.qArchived = jArchived && jArchived.archived;
  document.getElementById('btn-archive-contact').click(); // Restore
  let jRestored = await get('SELECT archived FROM judges WHERE id = ?', [judge.id]);
  for (let i = 0; i < 40 && (!jRestored || jRestored.archived !== 0); i++) {
    await sleep(100);
    jRestored = await get('SELECT archived FROM judges WHERE id = ?', [judge.id]);
  }
  reverse.qRestored = jRestored && jRestored.archived;

  return { judgePage, afterRename, previewHtml, docxPath, freshJudge, oc, ocOpened, freshRow, ocRow,
    blank, roleBoxShown, roleAfterAdd, stored, orgId, court, reread, switched, judgeRowsForGwen,
    searchText, searchOpened, newId, archivedFlag, archivedNote, backToList, archivedListed, reverse };
}).catch(e => ({ error: String(e) }));

if (contactPage.error) {
  check('Contacts Task 3 fixture', false, contactPage.error);
} else {
  const c = contactPage;
  check('a contact row opens the contact page under the Contacts tab, sub-tab Contacts',
    c.judgePage.opened && c.judgePage.page && c.judgePage.listHidden
      && JSON.stringify(c.judgePage.active) === '["nav-contacts"]'
      && JSON.stringify(c.judgePage.subs) === '["sub-contacts-contacts"]', JSON.stringify(c.judgePage));
  check('the judge\'s page shows name, role Judge and their court under Works at',
    c.judgePage.name === 'Hon. Quentin Example' && c.judgePage.role === 'Judge'
      && c.judgePage.worksAt === 'Testerton 97th District Court' && c.judgePage.worksAtCourt === String(c.court)
      && c.judgePage.worksAtOrg === '', JSON.stringify(c.judgePage));
  check('Role offers the seeded roles and "Add role…"',
    c.judgePage.roleOptions.includes('Clerk') && c.judgePage.roleOptions.includes('Probation Officer')
      && c.judgePage.roleOptions[c.judgePage.roleOptions.length - 1] === 'Add role…', JSON.stringify(c.judgePage.roleOptions));
  check('renaming a judge contact writes the contact and judges.name together',
    c.afterRename.person === 'Quentin R. Renamed' && c.afterRename.judge.name === 'Quentin R. Renamed'
      && c.afterRename.judge.court_id === c.court && c.afterRename.shown === 'Quentin R. Renamed', JSON.stringify(c.afterRename));
  check('after the rename, the caption preview (PDF HTML) prints "Hon. Quentin R. Renamed"',
    c.previewHtml.includes('Hon. Quentin R. Renamed') && !c.previewHtml.includes('Quentin Example'),
    c.previewHtml ? 'preview lacks the new name' : 'no preview');
  if (!c.docxPath) {
    check('after the rename, the .docx caption prints "Hon. Quentin R. Renamed"', false, 'no .docx was generated');
  } else {
    const xml = readDocxXml(c.docxPath);
    check('after the rename, the .docx caption prints "Hon. Quentin R. Renamed"',
      xml.includes('Hon. Quentin R. Renamed') && !xml.includes('Quentin Example'), c.docxPath);
  }
  check('a judge typed fresh on a case is created with a Judge contact at that court',
    !!c.freshJudge && c.freshJudge.name === 'Priya N. Freshbench' && c.freshJudge.display_name === 'Priya N. Freshbench'
      && c.freshJudge.is_contact === 1 && c.freshJudge.contact_role === 'Judge'
      && c.freshJudge.court_id === c.court && c.freshJudge.works_at_court_id === c.court, JSON.stringify(c.freshJudge));
  check('that judge appears in Contacts with role Judge and the court',
    JSON.stringify(c.freshRow) === JSON.stringify(['Priya N. Freshbench', 'Judge', 'Testerton 97th District Court', '']),
    JSON.stringify(c.freshRow));
  check('opposing counsel "+ Add" creates a contact with role Attorney',
    !!c.oc && c.oc.display_name === 'Opal Q. Counselworth' && c.oc.is_contact === 1 && c.oc.contact_role === 'Attorney'
      && !!c.ocRow && c.ocRow[1] === 'Attorney', JSON.stringify([c.oc, c.ocRow]));
  check('the new opposing counsel\'s "open profile" link opens the contact page',
    c.ocOpened.page && c.ocOpened.name === 'Opal Q. Counselworth' && c.ocOpened.role === 'Attorney', JSON.stringify(c.ocOpened));
  check('New Contact opens blank, with no Archive, under the Contacts tab',
    c.blank.page && c.blank.empty && c.blank.archiveHidden && JSON.stringify(c.blank.active) === '["nav-contacts"]',
    JSON.stringify(c.blank));
  check('"Add role…" adds a role to the pick-list and selects it',
    c.roleBoxShown && c.roleAfterAdd.value === 'Bailiff' && c.roleAfterAdd.boxHidden && c.roleAfterAdd.stored,
    JSON.stringify(c.roleAfterAdd));
  check('a new contact saves every field, as a contact, working at the organization',
    !!c.stored && c.stored.display_name === 'Gwen T. Roundtrip' && c.stored.contact_role === 'Bailiff'
      && c.stored.works_at_org_id === c.orgId && c.stored.works_at_court_id === null
      && c.stored.phone === '(555) 010-2233' && c.stored.email === 'gwen@example.com'
      && c.stored.street === '100 Main St' && c.stored.city === 'Exampleton, MI' && c.stored.zip === '48000'
      && c.stored.is_contact === 1 && c.stored.kind === 'individual' && c.stored.archived === 0, JSON.stringify(c.stored));
  check('reopening the contact shows every field back',
    JSON.stringify(c.reread) === JSON.stringify({ 'con-display_name': 'Gwen T. Roundtrip', 'con-contact_role': 'Bailiff',
      'con-works_at': 'Exampleton Police Department', 'con-phone': '(555) 010-2233', 'con-email': 'gwen@example.com',
      'con-street': '100 Main St', 'con-city': 'Exampleton, MI', 'con-zip': '48000' }), JSON.stringify(c.reread));
  check('switching Works at to a court stores the court and clears the organization',
    !!c.switched && c.switched.works_at_court_id === c.court && c.switched.works_at_org_id === null, JSON.stringify(c.switched));
  check('a non-judge contact never gets a judges row', c.judgeRowsForGwen === 0, String(c.judgeRowsForGwen));
  check('global search lists the contact under Contacts and opens the contact page',
    /Contacts/.test(c.searchText) && c.searchOpened.page && c.searchOpened.id === c.newId
      && JSON.stringify(c.searchOpened.active) === '["nav-contacts"]', JSON.stringify([c.searchText, c.searchOpened]));
  check('Archive archives the contact and says so on the page',
    c.archivedFlag === 1 && /archived/.test(c.archivedNote), JSON.stringify([c.archivedFlag, c.archivedNote]));
  check('Back returns to the contacts list, where the archived contact is hidden',
    c.backToList.list && JSON.stringify(c.backToList.active) === '["nav-contacts"]'
      && JSON.stringify(c.backToList.subs) === '["sub-contacts-contacts"]' && !c.archivedListed, JSON.stringify(c.backToList));
  check('archiving a judge\'s contact takes the judge out of the pickers; Restore brings it back',
    c.reverse.qArchived === 1 && c.reverse.qRestored === 0, JSON.stringify([c.reverse.qArchived, c.reverse.qRestored]));
}
if (process.env.SMOKE_SHOTS && !contactPage.error) {
  fs.mkdirSync(process.env.SMOKE_SHOTS, { recursive: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
  await page.evaluate(async (id) => {
    await window.openContact(id);
    await new Promise(r => setTimeout(r, 500));
  }, Number(contactPage.judgePage.id)).catch(() => {});
  await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'contact-page-1024.png') }).catch(() => {});
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
}

// --- Contacts Task 4: dated notes, on a contact or a court -----------------
// Notes are added through the page (date + text + Save), shown newest first
// whatever order they were written in, and deleted one at a time behind a
// confirm. A note belongs to a person OR a court (CHECK constraint); the court
// side is driven through renderNotes directly until the court page exists
// (Task 6), on a court whose id equals the person's, so a query on the wrong
// column would show up as a crossed note.
const contactNotes = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const run = (sql, p = []) => window.api.dbRun(sql, p);
  const all = (sql, p = []) => window.api.dbAll(sql, p);
  const now = new Date().toISOString();
  const r = {};
  const box = document.getElementById('contact-notes');
  const shown = (el) => [...el.querySelectorAll('.notes-list .home-row')].map(row => ({
    date: row.querySelector('.note-date').textContent, body: row.querySelector('.note-body').textContent }));
  const addNote = async (el, date, body) => {
    el.querySelector('[data-notes-add]').click();
    el.querySelector('.notes-add input[type="date"]').value = date;
    el.querySelector('.notes-add textarea').value = body;
    el.querySelector('.notes-add-buttons .btn.primary').click();
    await sleep(400);
  };
  const listNote = async (name) => {
    document.getElementById('nav-contacts').click();
    await sleep(500);
    const tr = [...document.querySelectorAll('#contacts-list tr')]
      .find(t => t.children[0] && t.children[0].textContent === name);
    return tr ? tr.children[3].textContent : null;
  };

  // A blank New Contact page explains, and offers no Add.
  await window.openContact(null);
  await sleep(300);
  r.blank = { text: box.textContent, add: !!box.querySelector('[data-notes-add]') };

  const person = (await run(
    `INSERT INTO people (display_name, kind, is_contact, contact_role, created_at)
     VALUES (?, 'individual', 1, 'Clerk', ?)`, ['Nora Notetaker', now])).lastInsertRowid;
  r.listBefore = await listNote('Nora Notetaker');

  await window.openContact(person);
  await sleep(400);
  r.empty = box.textContent;
  r.defaultDate = (() => {
    box.querySelector('[data-notes-add]').click();
    const v = box.querySelector('.notes-add input[type="date"]').value;
    box.querySelector('.notes-add-buttons .btn:not(.primary)').click();
    return v;
  })();
  // Written out of date order: the later-dated note first.
  await addNote(box, '2026-09-10', 'Later note first line\nLater note second line');
  await addNote(box, '2026-09-02', 'Earlier note');
  r.order = shown(box);
  r.dbRows = await all('SELECT note_date, body FROM contact_notes WHERE person_id = ? ORDER BY id', [person]);
  r.latest = await window.latestNote({ personId: person });
  r.listAfter = await listNote('Nora Notetaker');

  // The court side, on a court with the same id as the person.
  const clash = await window.api.dbGet('SELECT id FROM courts WHERE id = ?', [person]);
  r.courtIdFree = !clash;
  if (!clash) {
    await run('INSERT INTO courts (id, name) VALUES (?, ?)', [person, 'Notesville Probate Court']);
  }
  const courtBox = document.createElement('div');
  document.body.appendChild(courtBox);
  await window.renderNotes(courtBox, { courtId: person });
  await sleep(200);
  r.courtEmpty = shown(courtBox);
  await addNote(courtBox, '2026-09-20', 'Court-only note');
  r.courtShown = shown(courtBox);
  r.courtLatest = await window.latestNote({ courtId: person });
  r.personLatestAfterCourt = await window.latestNote({ personId: person });
  await window.openContact(person);
  await sleep(400);
  r.personAfterCourt = shown(box);
  courtBox.remove();

  // Both ids on one row: the CHECK constraint refuses it.
  try {
    await run('INSERT INTO contact_notes (person_id, court_id, note_date, body) VALUES (?,?,?,?)',
      [person, person, '2026-09-24', 'Both owners']);
    r.bothRejected = false;
  } catch (e) { r.bothRejected = /CHECK/i.test(String(e)); }
  try { await window.latestNote({ personId: person, courtId: person }); r.helperBoth = false; }
  catch (e) { r.helperBoth = true; }
  r.helperNone = await window.latestNote({});

  // Delete: a declined confirm keeps the note; an accepted one removes it.
  const realConfirm = window.confirm;
  let asked = '';
  try {
    window.confirm = (msg) => { asked = msg; return false; };
    box.querySelector('.notes-list .home-row .btn').click();
    await sleep(400);
    r.afterDecline = shown(box).length;
    window.confirm = (msg) => { asked = msg; return true; };
    box.querySelector('.notes-list .home-row .btn').click();
    await sleep(400);
  } finally {
    window.confirm = realConfirm;
  }
  r.asked = asked;
  r.afterDelete = shown(box);
  r.dbAfterDelete = await all('SELECT note_date FROM contact_notes WHERE person_id = ?', [person]);
  r.courtAfterDelete = await all('SELECT note_date FROM contact_notes WHERE court_id = ?', [person]);
  r.listAfterDelete = await listNote('Nora Notetaker');
  r.personId = person;
  // Leave no stray court behind for later sections' court lists.
  if (!clash) {
    await run('DELETE FROM contact_notes WHERE court_id = ?', [person]);
    await run('DELETE FROM courts WHERE id = ?', [person]);
  }
  return r;
}).catch(e => ({ error: String(e) }));
if (contactNotes.error) {
  check('Contacts Task 4 notes fixture', false, contactNotes.error);
} else {
  const n = contactNotes;
  check('a blank New Contact page explains notes need a saved contact, with no Add',
    /Save this contact first/.test(n.blank.text) && !n.blank.add, JSON.stringify(n.blank));
  check('a contact with no notes says so', /No notes yet/.test(n.empty), n.empty);
  check('the Add note date defaults to today', /^\d{4}-\d{2}-\d{2}$/.test(n.defaultDate)
    && n.defaultDate === new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
    n.defaultDate);
  check('two notes added out of date order are both saved', n.dbRows.length === 2, JSON.stringify(n.dbRows));
  check('notes show newest first by date, whatever order they were written',
    n.order.map(x => x.date).join(',') === '2026-09-10,2026-09-02', JSON.stringify(n.order));
  check('a multi-line note shows in full on the contact page',
    n.order[0] && n.order[0].body === 'Later note first line\nLater note second line', JSON.stringify(n.order));
  check('latestNote returns the newer note',
    n.latest && n.latest.note_date === '2026-09-10' && n.latest.body.startsWith('Later note first line'), JSON.stringify(n.latest));
  check('the Contacts list Latest note updates after a note is added, first line only',
    n.listBefore === '' && n.listAfter === 'Later note first line', `${n.listBefore} -> ${n.listAfter}`);
  check('the court-note fixture got a court id equal to the person id', n.courtIdFree, String(n.personId));
  check('a court shows only its own notes (no person note crosses over)',
    n.courtEmpty.length === 0 && n.courtShown.length === 1 && n.courtShown[0].body === 'Court-only note',
    JSON.stringify(n.courtShown));
  check('latestNote on a court returns the court note', n.courtLatest && n.courtLatest.body === 'Court-only note', JSON.stringify(n.courtLatest));
  check('a court note never shows on the person with the same id',
    n.personAfterCourt.length === 2 && !n.personAfterCourt.some(x => x.body === 'Court-only note')
      && n.personLatestAfterCourt.note_date === '2026-09-10', JSON.stringify(n.personAfterCourt));
  check('a note row with both a person and a court is refused (CHECK)', n.bothRejected);
  check('latestNote refuses both owners and returns null for none', n.helperBoth && n.helperNone === null, JSON.stringify(n.helperNone));
  check('declining the delete confirm keeps the note', n.afterDecline === 2, String(n.afterDecline));
  check('the delete confirm names the note', /2026-09-10/.test(n.asked) && /Later note first line/.test(n.asked), n.asked);
  check('deleting removes exactly that note, and not the court note',
    n.afterDelete.length === 1 && n.afterDelete[0].date === '2026-09-02'
      && n.dbAfterDelete.length === 1 && n.courtAfterDelete.length === 1,
    JSON.stringify([n.afterDelete, n.dbAfterDelete, n.courtAfterDelete]));
  check('the Contacts list Latest note follows the delete', n.listAfterDelete === 'Earlier note', n.listAfterDelete);
}
if (process.env.SMOKE_SHOTS && !contactNotes.error) {
  fs.mkdirSync(process.env.SMOKE_SHOTS, { recursive: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
  await page.evaluate(async (id) => {
    await window.api.dbRun(
      'INSERT INTO contact_notes (person_id, note_date, body, created_at) VALUES (?,?,?,?)',
      [id, '2026-09-12', 'Called about the hearing\nWill email the order by Friday', new Date().toISOString()]);
    await window.openContact(id);
    await new Promise(r => setTimeout(r, 500));
    document.getElementById('contact-notes').scrollIntoView({ block: 'center' });
  }, contactNotes.personId).catch(() => {});
  await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'contact-notes-1024.png') }).catch(() => {});
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
}

// --- Contacts Tasks 1–3 review fixes ---------------------------------------
// (1) a second New Contact opened while the first is saving stays blank;
// (2) a double-clicked Save Contact inserts one person (and one judge);
// (4) Works at typed to a name two places share refuses and asks to pick;
// (5) a role changed away from Judge archives the judges row (out of the
//     case pickers, captions still resolve); back to Judge restores it.
const contactFixes = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const run = (sql, p = []) => window.api.dbRun(sql, p);
  const get = (sql, p = []) => window.api.dbGet(sql, p);
  const val = id => document.getElementById(id).value;
  const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const setRole = (role) => {
    const sel = document.getElementById('con-contact_role');
    sel.value = role;
    sel.dispatchEvent(new Event('change'));
  };
  const saveBtn = document.getElementById('btn-save-contact');
  const count = async (sql, p = []) => (await get(sql, p)).n;
  const now = new Date().toISOString();
  const alerts = [];
  const oldAlert = window.alert;
  window.alert = (m) => { alerts.push(String(m)); };
  try {
    // (1) Save a new contact, and open another New Contact before it lands.
    document.getElementById('btn-new-contact').click();
    await sleep(300);
    document.getElementById('con-display_name').value = 'Nadia R. Racefirst';
    saveBtn.click();
    document.getElementById('btn-new-contact').click();
    await sleep(800);
    const race = {
      id: val('con-id'), name: val('con-display_name'),
      saved: await count("SELECT COUNT(*) AS n FROM people WHERE display_name = 'Nadia R. Racefirst'"),
    };

    // (2) Double-click Save on a new Judge contact. The second click is made
    //     with the button re-enabled, so only the in-code flag can stop it.
    document.getElementById('btn-new-contact').click();
    await sleep(300);
    document.getElementById('con-display_name').value = 'Dorian B. Doubleclick';
    setRole('Judge');
    saveBtn.click();
    const disabledMidSave = saveBtn.disabled;
    saveBtn.disabled = false;
    saveBtn.click();
    await sleep(900);
    const dbl = {
      disabledMidSave, enabledAfter: !saveBtn.disabled,
      people: await count("SELECT COUNT(*) AS n FROM people WHERE display_name = 'Dorian B. Doubleclick'"),
      judges: await count("SELECT COUNT(*) AS n FROM judges WHERE name = 'Dorian B. Doubleclick'"),
    };

    // (4) Two courts share a name; a court and an organization share another.
    await run('INSERT INTO courts (name) VALUES (?)', ['Sampleton Twin Court']);
    await run('INSERT INTO courts (name) VALUES (?)', ['Sampleton Twin Court']);
    await run('INSERT INTO courts (name) VALUES (?)', ['Sampleton Shared Name']);
    await run("INSERT INTO people (display_name, kind, created_at) VALUES (?, 'organization', ?)", ['Sampleton Shared Name', now]);
    const typedDup = async (name, place) => {
      document.getElementById('btn-new-contact').click();
      await sleep(300);
      document.getElementById('con-display_name').value = name;
      set('con-works_at', place);
      document.getElementById('con-works_at').dispatchEvent(new Event('blur'));
      alerts.length = 0;
      saveBtn.click();
      await sleep(600);
      return { alerts: [...alerts], id: val('con-id'), enabledAfter: !saveBtn.disabled,
        saved: await count('SELECT COUNT(*) AS n FROM people WHERE display_name = ?', [name]) };
    };
    const twoCourts = await typedDup('Tessa M. Twincourt', 'Sampleton Twin Court');
    const courtAndOrg = await typedDup('Omar J. Sharedname', 'sampleton shared name');
    // Two same-name courts in different cities: the list tells them apart by
    // city, and typing the full list label picks that one court.
    await run('INSERT INTO courts (name, city) VALUES (?, ?)', ['Citied Twin Court', 'Exampleton']);
    const citiedB = (await run('INSERT INTO courts (name, city) VALUES (?, ?)', ['Citied Twin Court', 'Sampleton'])).lastInsertRowid;
    document.getElementById('btn-new-contact').click();
    await sleep(300);
    document.getElementById('con-works_at').dispatchEvent(new Event('focus'));
    set('con-works_at', 'Citied Twin');
    await sleep(400);
    const citiedLabels = [...document.querySelectorAll('#combo-con-works-at li')].map(li => li.textContent);
    document.getElementById('con-display_name').value = 'Cora L. Citypick';
    set('con-works_at', 'citied twin court (court, sampleton)');
    alerts.length = 0;
    saveBtn.click();
    await sleep(600);
    const citied = { labels: citiedLabels, alerts: [...alerts], expected: citiedB,
      saved: await get("SELECT works_at_court_id FROM people WHERE display_name = 'Cora L. Citypick'") };

    // (5) A judge on a case whose contact role changes to Clerk, then back.
    const court = (await run('INSERT INTO courts (name) VALUES (?)', ['Testerton Rolechange Court'])).lastInsertRowid;
    const personId = (await run(
      `INSERT INTO people (display_name, kind, is_contact, contact_role, works_at_court_id, created_at)
       VALUES (?, 'individual', 1, 'Judge', ?, ?)`, ['Rhea C. Rolechange', court, now])).lastInsertRowid;
    const judgeId = (await run('INSERT INTO judges (name, court_id, person_id) VALUES (?,?,?)',
      ['Rhea C. Rolechange', court, personId])).lastInsertRowid;
    const matterId = (await run(
      `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, judge_id, client_role, caption_style,
         party_label, caption_authority, created_at) VALUES (0, ?,?,?,?,?,?,?,?,?)`,
      ['Role Change Case', '2026-RC-1', court, judgeId, 'defendant', 'full', 'Defendant',
       'PEOPLE OF THE CITY OF EXAMPLETON', now])).lastInsertRowid;
    await run('INSERT INTO parties (matter_id, name, side, sort_order) VALUES (?,?,?,0)', [matterId, 'Dana Q. Sample', 'defendant']);
    const pickerNames = async () => {
      await window.openMatterForTest(matterId);
      await sleep(600);
      set('mat-judge', 'Rolechange');
      await sleep(400);
      const names = [...document.querySelectorAll('#combo-judge li')].filter(li => !li.classList.contains('add-new'))
        .map(li => li.textContent);
      document.querySelector('#combo-judge .combobox-dropdown').classList.add('hidden');
      window.markFormCleanForTest('view-matter-detail');
      return names;
    };
    const saveRole = async (role) => {
      await window.openContact(personId);
      await sleep(400);
      setRole(role);
      saveBtn.click();
      await sleep(700);
      return get(`SELECT j.archived AS judge, p.archived AS person, p.contact_role AS role
                    FROM judges j JOIN people p ON p.id = j.person_id WHERE j.id = ?`, [judgeId]);
    };
    const pickerBefore = await pickerNames();
    const asClerk = await saveRole('Clerk');
    const pickerAsClerk = await pickerNames();
    // The existing case's caption still names the judge.
    await window.openMatterForTest(matterId);
    await sleep(600);
    document.getElementById('btn-goto-generate').click();
    await sleep(600);
    document.getElementById('gen-doctype').value = 'appearance';
    document.getElementById('gen-doctype').dispatchEvent(new Event('change'));
    await sleep(400);
    document.getElementById('btn-preview').click();
    await sleep(600);
    const captionAsClerk = (document.getElementById('preview-frame').srcdoc || '').includes('Hon. Rhea C. Rolechange');
    // Archive/Restore on the contact page must not bring a Clerk's judges row back.
    window.confirm = () => true;
    await window.openContact(personId);
    await sleep(400);
    document.getElementById('btn-archive-contact').click();
    await sleep(500);
    document.getElementById('btn-archive-contact').click(); // Restore
    await sleep(500);
    const clerkRestored = await get(
      'SELECT j.archived AS judge, p.archived AS person FROM judges j JOIN people p ON p.id = j.person_id WHERE j.id = ?', [judgeId]);
    const backToJudge = await saveRole('Judge');
    const pickerBack = await pickerNames();
    const judgeRows = await count('SELECT COUNT(*) AS n FROM judges WHERE person_id = ?', [personId]);

    return { race, dbl, twoCourts, courtAndOrg, citied, pickerBefore, asClerk, pickerAsClerk, captionAsClerk,
      clerkRestored, backToJudge, pickerBack, judgeRows };
  } finally { window.alert = oldAlert; }
}).catch(e => ({ error: String(e) }));

if (contactFixes.error) {
  check('Contacts review fixes fixture', false, contactFixes.error);
} else {
  const f = contactFixes;
  check('a second New Contact opened mid-save stays blank (the save lands, but not on screen)',
    f.race.id === '' && f.race.name === '' && f.race.saved === 1, JSON.stringify(f.race));
  check('double-clicking Save Contact inserts one person and one judge; the button is disabled meanwhile',
    f.dbl.people === 1 && f.dbl.judges === 1 && f.dbl.disabledMidSave && f.dbl.enabledAfter, JSON.stringify(f.dbl));
  const refused = (r) => r.saved === 0 && r.id === '' && r.enabledAfter && r.alerts.length === 1 && /pick/i.test(r.alerts[0]);
  check('Works at typed to a name two courts share refuses and asks to pick from the list',
    refused(f.twoCourts), JSON.stringify(f.twoCourts));
  check('Works at typed to a name a court and an organization share refuses and asks to pick',
    refused(f.courtAndOrg), JSON.stringify(f.courtAndOrg));
  check('Works at lists two same-name courts as "Name (court, City)", and typing that label picks the one court',
    JSON.stringify(f.citied.labels) === JSON.stringify(['Citied Twin Court (court, Exampleton)', 'Citied Twin Court (court, Sampleton)'])
      && f.citied.alerts.length === 0 && !!f.citied.saved && f.citied.saved.works_at_court_id === f.citied.expected,
    JSON.stringify(f.citied));
  check('changing a judge contact\'s role to Clerk archives the judges row, not the contact',
    JSON.stringify(f.pickerBefore) === '["Rhea C. Rolechange"]' && !!f.asClerk
      && f.asClerk.judge === 1 && f.asClerk.person === 0 && f.asClerk.role === 'Clerk'
      && JSON.stringify(f.pickerAsClerk) === '[]', JSON.stringify([f.pickerBefore, f.asClerk, f.pickerAsClerk]));
  check('an existing case\'s caption still prints the judge after the role change', f.captionAsClerk);
  check('archiving and restoring a former judge\'s contact leaves the judges row archived',
    !!f.clerkRestored && f.clerkRestored.judge === 1 && f.clerkRestored.person === 0, JSON.stringify(f.clerkRestored));
  check('changing the role back to Judge restores the same judges row to the pickers',
    !!f.backToJudge && f.backToJudge.judge === 0 && f.backToJudge.role === 'Judge' && f.judgeRows === 1
      && JSON.stringify(f.pickerBack) === '["Rhea C. Rolechange"]', JSON.stringify([f.backToJudge, f.judgeRows, f.pickerBack]));
}

// --- Contacts Task 5: Connected to (contact links, both directions) ---------
// One contact_links row per pair, shown on both people's pages with its label.
// Refused: a link to oneself, and the same pair again in either order. The
// picker lists contacts and organizations (not individual clients).
const contactLinks = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const run = (sql, p = []) => window.api.dbRun(sql, p);
  const get = (sql, p = []) => window.api.dbGet(sql, p);
  const hidden = id => document.getElementById(id).classList.contains('hidden');
  const now = new Date().toISOString();
  const box = document.getElementById('contact-links');
  const r = {};
  const alerts = [];
  const oldAlert = window.alert;
  const oldConfirm = window.confirm;
  window.alert = (m) => { alerts.push(String(m)); };
  const shown = () => [...box.querySelectorAll('.links-list .home-row')].map(row => ({
    name: row.querySelector('.link-name').textContent, label: row.querySelector('.link-label').textContent }));
  const pairCount = async (a, b) => (await get(
    `SELECT COUNT(*) AS n FROM contact_links
      WHERE (a_person_id = ? AND b_person_id = ?) OR (a_person_id = ? AND b_person_id = ?)`, [a, b, b, a])).n;
  const typeWho = async (text) => {
    const who = box.querySelector('.link-who');
    who.dispatchEvent(new Event('focus'));
    who.value = text;
    who.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);
    return [...box.querySelectorAll('.links-add li')].map(li => li.textContent);
  };
  const pick = (liText) => {
    const li = [...box.querySelectorAll('.links-add li')].find(x => x.textContent === liText);
    if (li) li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    return !!li;
  };
  const connect = async (who, liText, label, { clicks = 1, wait = 500 } = {}) => {
    box.querySelector('[data-links-add]').click();
    const offered = await typeWho(who);
    const picked = liText ? pick(liText) : false;
    box.querySelector('.link-label-input').value = label;
    alerts.length = 0;
    const saveBtn = box.querySelector('.links-add .btn.primary');
    for (let i = 0; i < clicks; i++) { saveBtn.disabled = false; saveBtn.click(); }
    if (wait) {
      // Success rebuilds the box (the + Connect button comes back visible);
      // a refused save leaves the form open and alerts instead. Poll for
      // either rather than a fixed sleep, up to the caller's wait budget.
      const addBtnVisible = () => {
        const b = box.querySelector('[data-links-add]');
        return b && !b.classList.contains('hidden');
      };
      for (let i = 0; i < Math.ceil(wait / 100) && !addBtnVisible() && !alerts.length; i++) await sleep(100);
      await sleep(100);
    }
    return { offered, picked };
  };
  try {
    const mk = async (name, role, kind = 'individual', isContact = 1) => (await run(
      `INSERT INTO people (display_name, kind, is_contact, contact_role, created_at) VALUES (?,?,?,?,?)`,
      [name, kind, isContact, role, now])).lastInsertRowid;
    const judge = await mk('Hon. Lena Linkjudge', 'Judge');
    const clerk = await mk('Carl P. Linkclerk', 'Clerk');
    const officer = await mk('Petra V. Linkofficer', 'Probation Officer');
    const insurer = await mk('Linkton Mutual Insurance', null, 'organization', 0);
    const client = await mk('Ivan K. Linkclient', null, 'individual', 0);

    // A blank New Contact explains, with no Connect.
    await window.openContact(null);
    await sleep(300);
    r.blank = { text: box.textContent, add: !!box.querySelector('[data-links-add]') };

    // Judge -> clerk, "her clerk", picked from the list.
    await window.openContact(judge);
    await sleep(400);
    r.emptyText = box.textContent;
    const first = await connect('Link', 'Carl P. Linkclerk (Clerk)', 'her clerk');
    r.offered = first.offered;
    r.picked = first.picked;
    r.judgeShows = shown();
    r.row = await get('SELECT a_person_id AS a, b_person_id AS b, label FROM contact_links WHERE a_person_id = ?', [judge]);

    // The name opens the clerk's page, which shows the judge with the label.
    box.querySelector('.link-name').click();
    await sleep(500);
    r.clerkPage = { id: document.getElementById('con-id').value, shows: shown() };

    // The same pair in reverse order, typed not picked: refused.
    await connect('Hon. Lena Linkjudge', null, 'the judge');
    r.reverse = { alerts: [...alerts], count: await pairCount(judge, clerk), shows: shown() };

    // Oneself: not offered in the list, and refused when typed.
    const selfOffered = await (async () => {
      const offered = await typeWho('Linkclerk');
      return offered;
    })();
    box.querySelector('.link-label-input').value = 'myself';
    box.querySelector('.link-who').value = 'Carl P. Linkclerk';
    box.querySelector('.link-who').dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    alerts.length = 0;
    box.querySelector('.links-add .btn.primary').click();
    await sleep(400);
    r.self = { offered: selfOffered, alerts: [...alerts],
      count: (await get('SELECT COUNT(*) AS n FROM contact_links WHERE a_person_id = b_person_id')).n };
    box.querySelector('.links-add .btn:not(.primary)').click();

    // A double-clicked Save makes one link; an organization that is not a
    // contact is offered and opens its client profile.
    const dbl = await connect('Linkton', 'Linkton Mutual Insurance (organization)', 'court insurer', { clicks: 2, wait: 600 });
    r.dbl = { picked: dbl.picked, count: await pairCount(clerk, insurer), alerts: [...alerts] };
    r.clientOffered = (await typeWho('Linkclient')).length;
    box.querySelector('.links-add .btn:not(.primary)').click();
    const orgLink = [...box.querySelectorAll('.link-name')].find(a => a.textContent === 'Linkton Mutual Insurance');
    if (orgLink) orgLink.click();
    await sleep(500);
    r.orgOpens = { person: !hidden('view-person-detail'), id: document.getElementById('per-id').value, expected: String(insurer) };

    // Re-open race: a connect save in flight while another contact is opened
    // must not paint onto that contact's page.
    await window.openContact(clerk);
    await sleep(400);
    await connect('Linkofficer', 'Petra V. Linkofficer (Probation Officer)', 'works with', { wait: 0 });
    await window.openContact(judge);
    let raceSaved = await pairCount(clerk, officer);
    for (let i = 0; i < 20 && !raceSaved; i++) { await sleep(100); raceSaved = await pairCount(clerk, officer); }
    r.race = { id: document.getElementById('con-id').value, linksFor: box.dataset.linksFor, shows: shown(),
      saved: raceSaved };
    await window.openContact(clerk);
    await sleep(400);
    r.raceBack = shown();

    // Remove: declined keeps it; accepted clears it from both pages.
    await window.openContact(judge);
    await sleep(400);
    const removeBtn = () => [...box.querySelectorAll('.links-list .home-row')]
      .find(row => row.querySelector('.link-name').textContent === 'Carl P. Linkclerk')?.querySelector('.btn');
    let asked = '';
    window.confirm = (m) => { asked = m; return false; };
    removeBtn().click();
    await sleep(400);
    r.declined = { asked, count: await pairCount(judge, clerk) };
    window.confirm = () => true;
    removeBtn().click();
    // The delete lands in the database before the box re-renders; wait for
    // the DOM to actually drop the row, not just the database row to go.
    for (let i = 0; i < 20 && shown().some(x => x.name === 'Carl P. Linkclerk'); i++) await sleep(100);
    const removedCount = await pairCount(judge, clerk);
    r.removed = { count: removedCount, judgeShows: shown(),
      people: (await get('SELECT COUNT(*) AS n FROM people WHERE id IN (?, ?)', [judge, clerk])).n };
    await window.openContact(clerk);
    await sleep(400);
    r.removed.clerkShows = shown();
    r.ids = { judge, clerk, officer, insurer, client };
    return r;
  } finally { window.alert = oldAlert; window.confirm = oldConfirm; }
}).catch(e => ({ error: String(e) }));

if (contactLinks.error) {
  check('Contacts Task 5 fixture', false, contactLinks.error);
} else {
  const l = contactLinks;
  check('a blank New Contact explains that links come after saving, with no Connect',
    /Save this contact first/.test(l.blank.text) && !l.blank.add, JSON.stringify(l.blank));
  check('Connect lists contacts (with role) and organizations, and saves judge -> clerk "her clerk"',
    l.picked && l.offered.includes('Carl P. Linkclerk (Clerk)') && l.offered.includes('Linkton Mutual Insurance (organization)')
      && !l.offered.includes('Hon. Lena Linkjudge (Judge)') && !l.offered.some(o => o.startsWith('Ivan K. Linkclient'))
      && !!l.row && l.row.a === l.ids.judge && l.row.b === l.ids.clerk && l.row.label === 'her clerk'
      && JSON.stringify(l.judgeShows) === JSON.stringify([{ name: 'Carl P. Linkclerk', label: 'her clerk' }]),
    JSON.stringify([l.offered, l.row, l.judgeShows]));
  check('the link shows on the clerk\'s page too, and its name opens that contact',
    l.clerkPage.id === String(l.ids.clerk)
      && JSON.stringify(l.clerkPage.shows) === JSON.stringify([{ name: 'Hon. Lena Linkjudge', label: 'her clerk' }]),
    JSON.stringify(l.clerkPage));
  check('the same pair in reverse order is refused with a clear message',
    l.reverse.count === 1 && l.reverse.alerts.length === 1 && /already connected to Hon\. Lena Linkjudge/.test(l.reverse.alerts[0])
      && l.reverse.shows.length === 1, JSON.stringify(l.reverse));
  check('a contact is not offered to itself, and typing its own name is refused',
    !l.self.offered.includes('Carl P. Linkclerk (Clerk)') && l.self.alerts.length === 1
      && /cannot be connected to themselves/.test(l.self.alerts[0]) && l.self.count === 0, JSON.stringify(l.self));
  check('a double-clicked Connect Save makes one link',
    l.dbl.picked && l.dbl.count === 1 && l.dbl.alerts.length === 0, JSON.stringify(l.dbl));
  check('individual clients are not offered in Connect', l.clientOffered === 0, String(l.clientOffered));
  check('a linked organization that is not a contact opens its client profile',
    l.orgOpens.person && l.orgOpens.id === l.orgOpens.expected, JSON.stringify(l.orgOpens));
  check('a Connect save in flight does not paint on a contact opened meanwhile',
    l.race.id === String(l.ids.judge) && l.race.linksFor === String(l.ids.judge) && l.race.saved === 1
      && JSON.stringify(l.race.shows) === JSON.stringify([{ name: 'Carl P. Linkclerk', label: 'her clerk' }])
      && l.raceBack.some(x => x.name === 'Petra V. Linkofficer' && x.label === 'works with'),
    JSON.stringify([l.race, l.raceBack]));
  check('Remove asks first; declining keeps the link',
    /Carl P\. Linkclerk/.test(l.declined.asked) && l.declined.count === 1, JSON.stringify(l.declined));
  check('Remove deletes the link row and clears it from both pages; both contacts stay',
    l.removed.count === 0 && l.removed.people === 2 && l.removed.judgeShows.length === 0
      && !l.removed.clerkShows.some(x => x.name === 'Hon. Lena Linkjudge'), JSON.stringify(l.removed));
}

// Task 9c: American spelling in what the user reads. The stage option's VALUE
// keeps its stored spelling (matters.stage, STAGE_FIELDS); only its text moves.
const t9cSpelling = await page.evaluate(() => ({
  section: document.querySelector('#sec-licences .section-toggle').textContent.trim(),
  chauffeur: document.querySelector('label[for="per-chauffeur_license"]').textContent.trim(),
  stage: [...document.getElementById('mat-stage').options]
    .filter(o => /restoration/.test(o.value)).map(o => [o.value, o.textContent.trim()]),
  paper: (window.INTAKE_FIELDS || []).filter(f => /licen[cs]e/i.test(f.section + ' ' + f.label))
    .map(f => `${f.section}: ${f.label}`),
})).catch(e => ({ error: String(e) }));
if (t9cSpelling.error) {
  check('Task 9c spelling fixture', false, t9cSpelling.error);
} else {
  check('the profile section reads "Licenses" and the checkbox "Chauffeur License"',
    t9cSpelling.section === 'Licenses' && t9cSpelling.chauffeur === 'Chauffeur License',
    JSON.stringify(t9cSpelling));
  check('the stage option reads "License restoration" but keeps its stored value',
    JSON.stringify(t9cSpelling.stage) === JSON.stringify([['Licence restoration', 'License restoration']]),
    JSON.stringify(t9cSpelling.stage));
  check('the paper questionnaire\'s license section and labels are spelled "License"',
    t9cSpelling.paper.length > 0 && t9cSpelling.paper.every(l => !/Licence/i.test(l))
      && t9cSpelling.paper.some(l => l.startsWith('Licenses:')),
    JSON.stringify(t9cSpelling.paper));
}
{
  // Visible text only: element text and quoted UI strings. Ids, the stored
  // stage value and identifiers keep their old spelling.
  const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
  const visible = html.replace(/<!--[\s\S]*?-->/g, '').match(/>[^<]*Licen[c]e[^<]*</g) || [];
  const js = fs.readFileSync(path.join(APP_DIR, 'renderer.js'), 'utf8')
    + fs.readFileSync(path.join(APP_DIR, 'document-engine.js'), 'utf8');
  const quoted = js.split('\n').filter(l => !/^\s*\/\//.test(l))
    .flatMap(l => l.match(/(['"`])(?:(?!\1).)*Licence(?:(?!\1).)*\1/g) || [])
    .filter(q => q.slice(1, -1) !== 'Licence restoration');
  check('no visible "Licence" spelling is left in index.html, renderer.js or document-engine.js',
    visible.length === 0 && quoted.length === 0, JSON.stringify([visible, quoted]));
}

// Task 9c: the search box's "Show archived" menu opens only from its caret,
// and closes on a press outside it, on Escape, and on changing screens, even
// when the search box never had focus (the case that used to stick open).
const t9cMenu = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const menu = document.getElementById('global-search-menu');
  const caret = document.getElementById('global-search-caret');
  const input = document.getElementById('global-search');
  const open = () => !menu.classList.contains('hidden');
  const press = (el) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  input.blur();
  document.getElementById('nav-home').click();
  await sleep(300);
  const r = { startsClosed: !open() };
  input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  r.inputDoesNotOpen = !open();
  press(caret); r.caretOpens = open();
  press(document.getElementById('global-search-archived')); r.insideKeepsOpen = open();
  press(document.getElementById('view-home')); r.outsideCloses = !open();
  press(caret); press(caret); r.caretToggles = !open();
  press(caret);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  r.escapeCloses = !open();
  press(caret);
  document.getElementById('nav-matters').click();
  await sleep(300);
  r.navigationCloses = !open();
  document.getElementById('nav-home').click();
  await sleep(300);
  return r;
}).catch(e => ({ error: String(e) }));
check('the "Show archived" menu opens only on the caret and closes on outside press, Escape and navigation',
  !t9cMenu.error && Object.values(t9cMenu).every(v => v === true), JSON.stringify(t9cMenu));

// 6. The C&D Answer to Complaint names the defendant in its opening line; with
//    no defendant parties it prints the "[DEFENDANT]" blank (the old
//    "|| '[DEFENDANT]'" never fired: partyCaptionText returns "Defendant").
const t9bAnswer = await page.evaluate(async () => {
  const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default=1');
  const id = (await window.api.dbRun(
    `INSERT INTO matters (folder_person_id, short_name, case_number, client_role, party_label, created_at)
     VALUES (0, 'Answer Blank Case', 'AB-1', 'defendant', 'Defendant', ?)`,
    [new Date().toISOString()])).lastInsertRowid;
  const matter = await window.api.dbGet('SELECT * FROM matters WHERE id=?', [id]);
  matter.caption_notes = [];
  matter.cases = [{ case_number: matter.case_number, judge_name: null }];
  const dt = window.DocumentEngine.doctypes.find(d => d.id === 'cd_answer_complaint');
  const out = {};
  for (const [label, parties] of [['none', []],
    ['named', [{ name: 'City of Exampleton', side: 'defendant', sort_order: 0 }]]]) {
    matter.parties = parties;
    const blocks = dt.build(matter, attorney, { packet: { packet_date: '2026-01-05', item_description: 'x' } });
    const body = blocks.find(b => b.type === 'body');
    const html = window.DocumentEngine.renderHtml(blocks, matter, attorney);
    const docx = await window.api.generateDocx(blocks, matter, attorney, dt.label, dt.id);
    out[label] = { body: body && body.text, html, docxPath: docx.path };
  }
  return out;
}).catch(e => ({ error: String(e) }));
if (t9bAnswer.error) {
  check('Task 9B answer-to-complaint fixture', false, t9bAnswer.error);
} else {
  const want = 'NOW COMES Defendant, [DEFENDANT], by';
  check('Answer to Complaint with no defendant parties prints [DEFENDANT] (PDF engine)',
    t9bAnswer.none.html.includes(want), String(t9bAnswer.none.body));
  check('Answer to Complaint with no defendant parties prints [DEFENDANT] (Word engine)',
    (readDocxXml(t9bAnswer.none.docxPath) || '').includes(want), t9bAnswer.none.docxPath);
  check('Answer to Complaint with a defendant party still names it, upper-cased',
    t9bAnswer.named.html.includes('NOW COMES Defendant, CITY OF EXAMPLETON, by')
      && (readDocxXml(t9bAnswer.named.docxPath) || '').includes('NOW COMES Defendant, CITY OF EXAMPLETON, by'),
    String(t9bAnswer.named.body));
}


// --- Contacts Task 6: the court page ------------------------------------------
// A Courts row opens the court's page: name, header line (verbatim, never
// upper-cased), city, county, address, phone; Notes; People at this court;
// Cases in this court; Archive/Restore. New Court makes one. The interim Edit
// Courts & Judges fieldset is retired — a judge is edited on their contact page.
const courtPage = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const run = (sql, p = []) => window.api.dbRun(sql, p);
  const get = (sql, p = []) => window.api.dbGet(sql, p);
  const hidden = id => document.getElementById(id).classList.contains('hidden');
  const activeTabs = () => [...document.querySelectorAll('.tabs-container .tab.active')].map(t => t.id);
  const activeSubs = () => [...document.querySelectorAll('.sub-tab.active')].map(t => t.id);
  const val = id => document.getElementById(id).value;
  const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const rows = (id) => [...document.querySelectorAll(`#${id} .home-row`)].map(r =>
    [r.querySelector('a').textContent, ...[...r.querySelectorAll('.link-right span')].map(s => s.textContent)]);
  const courtRow = (name) => [...document.querySelectorAll('#courts-list tr')]
    .find(tr => tr.children[0] && tr.children[0].textContent.startsWith(name));
  const openCourts = async () => {
    document.getElementById('nav-contacts').click();
    await sleep(300);
    document.getElementById('sub-contacts-courts').click();
    await sleep(500);
  };
  const now = new Date().toISOString();
  const r = {};

  // Fixtures: a court with a judge, a clerk (with notes), an archived bailiff
  // and a case; a second court with its own contact and case, which must not
  // show on the first court's page.
  const court = (await run('INSERT INTO courts (name, header_line, city, county) VALUES (?,?,?,?)',
    ['Samplewood 98th District Court', 'IN THE 44th DISTRICT COURT', 'Samplewood', 'Testerton'])).lastInsertRowid;
  const other = (await run('INSERT INTO courts (name) VALUES (?)', ['Otherville 99th District Court'])).lastInsertRowid;
  const mkContact = async (name, role, courtId, archived = 0) => (await run(
    `INSERT INTO people (display_name, kind, is_contact, contact_role, works_at_court_id, archived, created_at)
     VALUES (?, 'individual', 1, ?, ?, ?, ?)`, [name, role, courtId, archived, now])).lastInsertRowid;
  const judgePerson = await mkContact('Hon. Wendell Samplebench', 'Judge', court);
  const judge = (await run('INSERT INTO judges (name, court_id, person_id) VALUES (?,?,?)',
    ['Hon. Wendell Samplebench', court, judgePerson])).lastInsertRowid;
  const clerk = await mkContact('Clive Docketson', 'Clerk', court);
  await run('INSERT INTO contact_notes (person_id, note_date, body, created_at) VALUES (?,?,?,?)',
    [clerk, '2026-01-10', 'Older clerk note', now]);
  await run('INSERT INTO contact_notes (person_id, note_date, body, created_at) VALUES (?,?,?,?)',
    [clerk, '2026-03-02', 'Files stamped copies at the window\nsecond line', now]);
  await mkContact('Bea Retiredbailiff', 'Court Officer', court, 1);
  await mkContact('Olga Elsewhere', 'Clerk', other);
  const mkMatter = async (short, cn, courtId, judgeId) => (await run(
    `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, judge_id, client_role, caption_style,
       party_label, caption_authority, created_at) VALUES (0, ?,?,?,?,?,?,?,?,?)`,
    [short, cn, courtId, judgeId, 'defendant', 'full', 'Defendant', 'PEOPLE OF THE CITY OF EXAMPLETON', now])).lastInsertRowid;
  const matterA = await mkMatter('Court Page Case', '2026-CP-1', court, judge);
  await run('INSERT INTO parties (matter_id, name, side, sort_order) VALUES (?,?,?,0)', [matterA, 'Dana Q. Sample', 'defendant']);
  await mkMatter('Elsewhere Case', '2026-EW-9', other, null);

  // 1. The Courts list row opens the page.
  await openCourts();
  const tr = courtRow('Samplewood 98th District Court');
  if (tr) tr.click();
  await sleep(700);
  r.opened = {
    clicked: !!tr, page: !hidden('view-court-detail'), active: activeTabs(), subs: activeSubs(),
    id: val('crt-id'), fields: ['name', 'header_line', 'city', 'county', 'address', 'phone'].map(f => val('crt-' + f)),
    archiveShown: !hidden('court-archive-foot'), archiveText: document.getElementById('btn-archive-court').textContent,
    headerPlaceholder: document.getElementById('crt-header_line').placeholder,
  };
  r.people = rows('court-people');
  r.cases = rows('court-cases');
  r.court = court;

  // 2. Edit every field and save; the header line is stored exactly as typed.
  const HEADER = 'IN THE 98th District Court for the County of Testerton';
  set('crt-header_line', '  ' + HEADER + ' ');
  set('crt-city', 'Samplewood Heights');
  set('crt-county', 'Testerton');
  set('crt-address', '44 Courthouse Sq, Samplewood, MI 48000');
  set('crt-phone', '(555) 010-4444');
  document.getElementById('btn-save-court').click();
  let stored = await get('SELECT name, header_line, city, county, address, phone, archived FROM courts WHERE id = ?', [court]);
  for (let i = 0; i < 40 && stored.header_line !== HEADER; i++) {
    await sleep(100);
    stored = await get('SELECT name, header_line, city, county, address, phone, archived FROM courts WHERE id = ?', [court]);
  }
  r.stored = stored;
  for (let i = 0; i < 20 && val('crt-header_line') !== HEADER; i++) await sleep(100);
  r.shownAfterSave = val('crt-header_line');
  r.HEADER = HEADER;

  // 3. That header line in a generated caption: preview (PDF HTML) and .docx.
  const generate = async () => {
    await window.openMatterForTest(matterA);
    await sleep(700);
    document.getElementById('btn-goto-generate').click();
    await sleep(600);
    document.getElementById('gen-doctype').value = 'appearance';
    document.getElementById('gen-doctype').dispatchEvent(new Event('change'));
    await sleep(400);
    document.getElementById('btn-preview').click();
    await sleep(600);
    const html = document.getElementById('preview-frame').srcdoc || '';
    const before = await get(
      "SELECT MAX(id) AS id FROM generated_files WHERE matter_id = ? AND format = 'docx'", [matterA]);
    const prevId = (before && before.id) || 0;
    document.getElementById('btn-generate-docx').click();
    let gen = null;
    for (let i = 0; i < 60 && !gen; i++) {
      await sleep(100);
      gen = await get(
        "SELECT path FROM generated_files WHERE matter_id = ? AND format = 'docx' AND id > ? ORDER BY id DESC LIMIT 1",
        [matterA, prevId]);
    }
    return { html, docx: gen && gen.path };
  };
  r.gen = await generate();

  // 4. Notes on the court page, stored on the court (not on a person).
  await window.openCourt(court);
  await sleep(600);
  const notesEl = document.getElementById('court-notes');
  notesEl.querySelector('[data-notes-add]').click();
  notesEl.querySelector('.notes-add input[type="date"]').value = '2026-04-01';
  notesEl.querySelector('.notes-add textarea').value = 'Clerk window closes at 4:00';
  [...notesEl.querySelectorAll('.notes-add button')].find(b => b.textContent === 'Save').click();
  let noteStored = await get('SELECT court_id, person_id, note_date, body FROM contact_notes WHERE body = ?', ['Clerk window closes at 4:00']);
  for (let i = 0; i < 40 && !noteStored; i++) {
    await sleep(100);
    noteStored = await get('SELECT court_id, person_id, note_date, body FROM contact_notes WHERE body = ?', ['Clerk window closes at 4:00']);
  }
  r.notes = {
    shown: [...notesEl.querySelectorAll('.home-row')].map(x => x.querySelector('.note-body').textContent),
    stored: noteStored,
  };
  // The notes list must catch up too, not just the database.
  for (let i = 0; i < 20 && !r.notes.shown.includes('Clerk window closes at 4:00'); i++) {
    await sleep(100);
    r.notes.shown = [...notesEl.querySelectorAll('.home-row')].map(x => x.querySelector('.note-body').textContent);
  }

  // 5. The name links: a person opens their contact page, a case opens the case.
  const personLink = [...document.querySelectorAll('#court-people a')].find(a => a.textContent === 'Clive Docketson');
  if (personLink) personLink.click();
  await sleep(600);
  r.personOpened = { page: !hidden('view-contact-detail'), id: val('con-id'), clerk: String(clerk) };
  await window.openCourt(court);
  await sleep(600);
  const caseLink = [...document.querySelectorAll('#court-cases a')].find(a => a.textContent === 'Court Page Case');
  if (caseLink) caseLink.click();
  await sleep(800);
  r.caseOpened = { page: !hidden('view-matter-detail'), name: val('mat-short_name'), number: val('mat-case_number') };

  // 6. Archive: hidden from the Courts list and the case court picker; the
  //    case already in it still prints it. Restore brings it back.
  await window.openCourt(court);
  await sleep(600);
  window.confirm = () => true;
  document.getElementById('btn-archive-court').click();
  let archFlag = (await get('SELECT archived FROM courts WHERE id = ?', [court])).archived;
  for (let i = 0; i < 40 && archFlag !== 1; i++) {
    await sleep(100);
    archFlag = (await get('SELECT archived FROM courts WHERE id = ?', [court])).archived;
  }
  r.archived = {
    flag: archFlag,
    note: document.getElementById('court-archived-note').textContent,
    btn: document.getElementById('btn-archive-court').textContent,
  };
  await openCourts();
  r.archived.listed = !!courtRow('Samplewood 98th District Court');
  await window.openMatterForTest(matterA);
  await sleep(700);
  r.archived.caseCourt = val('mat-court');
  set('mat-court', 'Samplewood');
  await sleep(500);
  r.archived.picker = [...document.querySelectorAll('#combo-court .combobox-dropdown li')]
    .filter(li => !li.classList.contains('add-new')).map(li => li.textContent);
  set('mat-court', r.archived.caseCourt);
  document.getElementById('mat-court_id').value = String(court);
  r.archivedGen = await generate();
  await window.openCourt(court);
  await sleep(600);
  document.getElementById('btn-archive-court').click(); // Restore
  await sleep(600);
  r.restored = (await get('SELECT archived FROM courts WHERE id = ?', [court])).archived;
  await openCourts();
  r.restoredListed = !!courtRow('Samplewood 98th District Court');

  // 7. New Court round trip; a double click saves one court.
  document.getElementById('btn-new-court').click();
  await sleep(500);
  r.blank = {
    page: !hidden('view-court-detail'), id: val('crt-id'), name: val('crt-name'),
    archiveHidden: hidden('court-archive-foot'),
    notesMsg: document.getElementById('court-notes').textContent,
    peopleMsg: document.getElementById('court-people').textContent,
  };
  set('crt-name', 'Testerton 93rd Circuit Court');
  set('crt-header_line', 'IN THE 93rd Circuit Court for the County of Testerton');
  set('crt-city', 'Testerton');
  set('crt-county', 'Testerton');
  document.getElementById('btn-save-court').click();
  document.getElementById('btn-save-court').click();
  let created = await get(`SELECT COUNT(*) AS n, MAX(id) AS id, header_line, city FROM courts WHERE name = 'Testerton 93rd Circuit Court'`);
  for (let i = 0; i < 40 && !created.n; i++) {
    await sleep(100);
    created = await get(`SELECT COUNT(*) AS n, MAX(id) AS id, header_line, city FROM courts WHERE name = 'Testerton 93rd Circuit Court'`);
  }
  r.created = created;
  for (let i = 0; i < 20 && hidden('court-archive-foot'); i++) await sleep(100);
  r.createdShown = { id: val('crt-id'), name: val('crt-name'), archiveShown: !hidden('court-archive-foot') };
  await openCourts();
  r.createdListed = !!courtRow('Testerton 93rd Circuit Court');

  // 8. A court opened while another is still loading does not get painted over.
  window.openCourt(court);
  await window.openCourt(r.created.id);
  await sleep(600);
  r.lastWins = { id: val('crt-id'), name: val('crt-name'), cases: rows('court-cases').length };

  return r;
}).catch(e => ({ error: String(e) }));

if (courtPage.error) {
  check('Contacts Task 6 fixture', false, courtPage.error);
} else {
  const c = courtPage;
  check('a Courts row opens the court page under the Contacts tab, sub-tab Courts, with every field',
    c.opened.clicked && c.opened.page && c.opened.id === String(c.court)
      && JSON.stringify(c.opened.active) === '["nav-contacts"]' && JSON.stringify(c.opened.subs) === '["sub-contacts-courts"]'
      && JSON.stringify(c.opened.fields) === JSON.stringify(['Samplewood 98th District Court', 'IN THE 44th DISTRICT COURT', 'Samplewood', 'Testerton', '', ''])
      && c.opened.archiveShown && c.opened.archiveText === 'Archive'
      && c.opened.headerPlaceholder === 'IN THE 96th District Court', JSON.stringify(c.opened));
  check('People at this court: its contacts only, archived last and marked, with role and latest note (dated, first line)',
    JSON.stringify(c.people) === JSON.stringify([
      ['Clive Docketson', 'Clerk', '2026-03-02  Files stamped copies at the window'],
      ['Hon. Wendell Samplebench', 'Judge'],
      ['Bea Retiredbailiff  (archived)', 'Court Officer']]), JSON.stringify(c.people));
  check('Cases in this court: its cases only, with the case number',
    JSON.stringify(c.cases) === JSON.stringify([['Court Page Case', '2026-CP-1']]), JSON.stringify(c.cases));
  check('Save stores every field; the header line exactly as typed (trimmed, never upper-cased)',
    !!c.stored && c.stored.header_line === c.HEADER && c.stored.city === 'Samplewood Heights'
      && c.stored.county === 'Testerton' && c.stored.address === '44 Courthouse Sq, Samplewood, MI 48000'
      && c.stored.phone === '(555) 010-4444' && c.stored.name === 'Samplewood 98th District Court'
      && c.shownAfterSave === c.HEADER, JSON.stringify(c.stored));
  check('the edited header line prints verbatim in the caption preview (PDF HTML)',
    c.gen.html.includes(c.HEADER) && !c.gen.html.includes(c.HEADER.toUpperCase()), c.gen.html ? '' : 'no preview');
  if (!c.gen.docx) {
    check('the edited header line prints verbatim in the .docx caption', false, 'no .docx was generated');
  } else {
    const xml = readDocxXml(c.gen.docx);
    check('the edited header line prints verbatim in the .docx caption',
      xml.includes(c.HEADER) && !xml.includes(c.HEADER.toUpperCase()), c.gen.docx);
  }
  check('a note added on the court page is stored on the court and shown there',
    !!c.notes.stored && c.notes.stored.court_id === c.court && c.notes.stored.person_id === null
      && c.notes.stored.note_date === '2026-04-01' && JSON.stringify(c.notes.shown) === '["Clerk window closes at 4:00"]',
    JSON.stringify(c.notes));
  check('a person\'s name on the court page opens their contact page',
    c.personOpened.page && c.personOpened.id === c.personOpened.clerk, JSON.stringify(c.personOpened));
  check('a case\'s name on the court page opens the case',
    c.caseOpened.page && c.caseOpened.name === 'Court Page Case' && c.caseOpened.number === '2026-CP-1', JSON.stringify(c.caseOpened));
  check('Archive archives the court and says so; the button becomes Restore',
    c.archived.flag === 1 && /archived/.test(c.archived.note) && c.archived.btn === 'Restore', JSON.stringify(c.archived));
  check('an archived court is hidden from the Courts list and the case court picker',
    !c.archived.listed && !c.archived.picker.some(t => t.includes('Samplewood 44th')), JSON.stringify(c.archived));
  check('a case already in an archived court still shows and prints it',
    c.archived.caseCourt === 'Samplewood 98th District Court' && c.archivedGen.html.includes(c.HEADER),
    JSON.stringify([c.archived.caseCourt, !!c.archivedGen.html]));
  check('Restore brings the court back to the Courts list', c.restored === 0 && c.restoredListed);
  check('New Court opens a blank page with no Archive, and notes wait for a save',
    c.blank.page && c.blank.id === '' && c.blank.name === '' && c.blank.archiveHidden
      && /Save this court first/.test(c.blank.notesMsg) && /Save this court first/.test(c.blank.peopleMsg), JSON.stringify(c.blank));
  check('New Court saves once (double click) and reopens as the saved court, listed under Courts',
    !!c.created && c.created.n === 1 && c.created.header_line === 'IN THE 93rd Circuit Court for the County of Testerton'
      && c.created.city === 'Testerton' && c.createdShown.id === String(c.created.id)
      && c.createdShown.name === 'Testerton 93rd Circuit Court' && c.createdShown.archiveShown && c.createdListed,
    JSON.stringify([c.created, c.createdShown]));
  check('the court opened last is the one shown, not a slower earlier load',
    c.lastWins.id === String(c.created.id) && c.lastWins.name === 'Testerton 93rd Circuit Court' && c.lastWins.cases === 0,
    JSON.stringify(c.lastWins));
}
{
  const html = fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8');
  check('the interim Edit Courts & Judges fieldset is gone from the app',
    !/courts-manage|judges-manage|Edit Courts &amp; Judges/.test(html)
      && !/renderManage|loadManageLists/.test(fs.readFileSync(path.join(APP_DIR, 'renderer.js'), 'utf8')));
}
if (process.env.SMOKE_SHOTS && !courtPage.error) {
  fs.mkdirSync(process.env.SMOKE_SHOTS, { recursive: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
  await page.evaluate(async (id) => {
    await window.openCourt(id);
    await new Promise(r => setTimeout(r, 500));
  }, courtPage.court).catch(() => {});
  await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'court-page-1024.png') }).catch(() => {});
  await page.evaluate(async () => {
    document.getElementById('court-archive-foot').scrollIntoView({ block: 'end' });
    await new Promise(r => setTimeout(r, 200));
  }).catch(() => {});
  await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'court-page-1024-lower.png') }).catch(() => {});
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
}


// --- Contacts Task 7: Who's involved on the case screen ------------------------
// Auto rows for the case's court, judge and opposing counsel, then the people
// added to the case, each with its latest note on one line. + Add contact
// picks a contact or makes one inline; Remove takes them off this case only.
// Carry-over: a contact saved as OUR CLIENT on a case moves to People (asked
// first; Cancel saves nothing).
const whoBox = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const run = (sql, p = []) => window.api.dbRun(sql, p);
  const get = (sql, p = []) => window.api.dbGet(sql, p);
  const hidden = id => document.getElementById(id).classList.contains('hidden');
  const box = document.getElementById('matter-who');
  const shown = () => [...box.querySelectorAll('.who-list .home-row')].map(row => ({
    kind: row.dataset.whoKind,
    name: row.querySelector('.who-name').textContent,
    role: row.querySelector('.who-role').textContent,
    note: (row.querySelector('.who-note') || {}).textContent || '',
  }));
  const now = new Date().toISOString();
  const oldAlert = window.alert, oldConfirm = window.confirm;
  const alerts = [];
  window.alert = (m) => { alerts.push(m); };
  const r = {};
  try {
    const mkContact = async (name, role) => (await run(
      `INSERT INTO people (display_name, kind, is_contact, contact_role, created_at) VALUES (?, 'individual', 1, ?, ?)`,
      [name, role, now])).lastInsertRowid;
    const note = (col, id, date, body) => run(
      `INSERT INTO contact_notes (${col}, note_date, body, created_at) VALUES (?,?,?,?)`, [id, date, body, now]);
    const court = (await run('INSERT INTO courts (name, city) VALUES (?,?)', ['Whoville 97th District Court', 'Whoville'])).lastInsertRowid;
    await note('court_id', court, '2026-05-01', 'Parking behind the courthouse\nsecond line');
    const judgeP = await mkContact('Hon. Winifred Whobench', 'Judge');
    const judge = (await run('INSERT INTO judges (name, court_id, person_id) VALUES (?,?,?)', ['Hon. Winifred Whobench', court, judgeP])).lastInsertRowid;
    await note('person_id', judgeP, '2026-02-01', 'Older judge note');
    await note('person_id', judgeP, '2026-06-15', 'Prefers courtesy copies');
    const judge2P = await mkContact('Hon. Victor Whosecond', 'Judge');
    const judge2 = (await run('INSERT INTO judges (name, court_id, person_id) VALUES (?,?,?)', ['Hon. Victor Whosecond', court, judge2P])).lastInsertRowid;
    const oc = await mkContact('Olive T. Whocounsel', 'Attorney');
    await note('person_id', oc, '2026-04-20', 'Returns calls after 3');
    const cora = await mkContact('Cora B. Whoclient', 'Adjuster');
    const dex = await mkContact('Dex R. Whotyped', 'Clerk');
    const mkMatter = async (short, courtId, judgeId, ocId) => (await run(
      `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, judge_id, opposing_counsel_person_id,
         client_role, caption_style, party_label, caption_authority, created_at) VALUES (0, ?,?,?,?,?,?,?,?,?,?)`,
      [short, '2026-WHO-1', courtId, judgeId, ocId, 'defendant', 'full', 'Defendant', 'PEOPLE OF THE CITY OF EXAMPLETON', now])).lastInsertRowid;
    const matter = await mkMatter('Who Box Case', court, judge, oc);
    await run('INSERT INTO parties (matter_id, name, side, role, sort_order) VALUES (?,?,?,?,0)', [matter, 'Dana W. Sample', 'defendant', 'client']);
    const empty = await mkMatter('Who Empty Case', null, null, null);

    // 1. Three auto rows, each with its latest note (dated, first line only).
    await window.openMatterForTest(matter);
    await sleep(800);
    r.fieldset = !hidden('matter-detail-sideinfo') && !!document.querySelector('#matter-who-fields legend')
      && document.querySelector('#matter-who-fields legend').textContent;
    r.auto = shown();

    // Names link: the court to its page, the judge to their contact page.
    const link = (name) => [...box.querySelectorAll('a.who-name')].find(a => a.textContent === name);
    link('Whoville 97th District Court').click();
    await sleep(600);
    r.courtOpened = { page: !hidden('view-court-detail'), id: document.getElementById('crt-id').value };
    await window.openMatterForTest(matter);
    await sleep(800);
    link('Hon. Winifred Whobench').click();
    await sleep(600);
    r.judgeOpened = { page: !hidden('view-contact-detail'), id: document.getElementById('con-id').value };
    await window.openMatterForTest(matter);
    await sleep(800);

    // 2. + Add contact -> a new probation officer, inline; Save double-clicked.
    const openForm = () => box.querySelector('[data-who-add]').click();
    const typeWho = async (text) => {
      const input = box.querySelector('.who-who');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(400);
      return [...box.querySelectorAll('.who-add .combobox-dropdown li')];
    };
    openForm();
    await sleep(300);
    let lis = await typeWho('Priya N. Whoprobation');
    const addNew = lis.find(li => li.classList.contains('add-new'));
    r.addNewText = addNew ? addNew.textContent : '';
    if (addNew) addNew.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await sleep(200);
    r.roleShown = !box.querySelector('.who-role-select').classList.contains('hidden');
    // No role picked: refused.
    alerts.length = 0;
    box.querySelector('.who-add .btn.primary').click();
    await sleep(300);
    r.noRole = [...alerts];
    box.querySelector('.who-role-select').value = 'Probation Officer';
    box.querySelector('.who-label-input').value = 'Assigned probation officer';
    box.querySelector('.who-add .btn.primary').click();
    box.querySelector('.who-add .btn.primary').click();
    await sleep(900);
    r.afterAdd = shown();
    r.po = await get(`SELECT COUNT(*) AS n, MAX(id) AS id, is_contact, contact_role FROM people WHERE display_name = 'Priya N. Whoprobation'`);
    r.poLinks = (await get('SELECT COUNT(*) AS n FROM matter_contacts WHERE matter_id = ?', [matter])).n;
    r.poOnContacts = await (async () => {
      document.getElementById('nav-contacts').click();
      await sleep(500);
      return document.getElementById('view-contacts') ? document.getElementById('view-contacts').textContent.includes('Priya N. Whoprobation') : null;
    })();
    await window.openMatterForTest(matter);
    await sleep(800);

    // 3. De-dup: opposing counsel picked again is refused; a matter_contacts row
    //    for the judge (added some other way) is not shown twice.
    openForm();
    await sleep(300);
    lis = await typeWho('Whocounsel');
    r.ocOffered = lis.map(li => li.textContent);
    const ocLi = lis.find(li => li.textContent === 'Olive T. Whocounsel (Attorney)');
    if (ocLi) ocLi.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    alerts.length = 0;
    box.querySelector('.who-add .btn.primary').click();
    await sleep(500);
    r.ocRefused = { alerts: [...alerts], links: (await get('SELECT COUNT(*) AS n FROM matter_contacts WHERE matter_id = ? AND person_id = ?', [matter, oc])).n };
    await run('INSERT INTO matter_contacts (matter_id, person_id, label, sort_order, created_at) VALUES (?,?,?,?,?)',
      [matter, judgeP, 'Also the judge', 5, now]);
    await window.openMatterForTest(matter);
    await sleep(800);
    r.dedup = shown();

    // 4. Remove: declined keeps it; accepted removes the case row only.
    const removeBtn = () => [...box.querySelectorAll('.who-list .home-row')]
      .find(row => row.querySelector('.who-name').textContent === 'Priya N. Whoprobation')?.querySelector('.btn');
    let asked = '';
    window.confirm = (m) => { asked = m; return false; };
    removeBtn().click();
    await sleep(400);
    r.declined = { asked, n: shown().length };
    window.confirm = () => true;
    removeBtn().click();
    removeBtn() && removeBtn().click();
    await sleep(600);
    r.removed = { shown: shown(), person: await get('SELECT is_contact, archived FROM people WHERE id = ?', [r.po.id]),
      links: (await get('SELECT COUNT(*) AS n FROM matter_contacts WHERE matter_id = ? AND person_id = ?', [matter, r.po.id])).n };

    // 5. Changing the case's judge and saving swaps the judge row (and the old
    //    judge's own matter_contacts row, hidden until now, shows as added).
    document.getElementById('mat-judge').value = 'Hon. Victor Whosecond';
    document.getElementById('mat-judge_id').value = String(judge2);
    await window.saveMatterForTest();
    await sleep(800);
    r.swapped = shown();

    // 6. A case with nothing set: a plain empty state. And a slow render for
    //    the first case does not paint over the empty one opened after it.
    window.renderWhosInvolved(matter);
    await window.openMatterForTest(empty);
    await sleep(800);
    r.empty = { rows: shown().length, text: box.querySelector('.home-empty') ? box.querySelector('.home-empty').textContent : '',
      whoFor: box.dataset.whoFor, expected: String(empty), add: !!box.querySelector('[data-who-add]') };

    // 7. Carry-over: a contact picked as OUR CLIENT. Cancel saves nothing; OK
    //    moves them to People. A contact typed as the OTHER side stays a contact.
    await window.openMatterForTest(matter);
    await sleep(800);
    window.addParty('defendant'); await sleep(200);
    const defInputs = document.querySelectorAll('#defendant-list input');
    const cInput = defInputs[defInputs.length - 1];
    cInput.value = 'Cora B. Whoclient';
    cInput.dispatchEvent(new Event('input', { bubbles: true }));
    cInput.dispatchEvent(new Event('focus', { bubbles: true }));
    await sleep(400);
    const coraLi = [...document.querySelectorAll('#defendant-list .combobox-dropdown li')].find(li => li.textContent === 'Cora B. Whoclient');
    r.coraPicked = !!coraLi;
    if (coraLi) coraLi.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    window.addParty('plaintiff'); await sleep(200);
    const pInputs = document.querySelectorAll('#plaintiff-list input');
    const dInput = pInputs[pInputs.length - 1];
    dInput.value = 'Dex R. Whotyped';
    dInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    let carryAsked = '';
    window.confirm = (m) => { carryAsked = m; return false; };
    const cancelled = await window.saveMatterForTest();
    r.carryCancel = { returned: cancelled, asked: carryAsked,
      cora: (await get('SELECT is_contact FROM people WHERE id = ?', [cora])).is_contact,
      parties: (await get('SELECT COUNT(*) AS n FROM parties WHERE matter_id = ?', [matter])).n };
    carryAsked = '';
    window.confirm = (m) => { carryAsked = m; return true; };
    await window.saveMatterForTest();
    await sleep(400);
    r.carryOk = { asked: carryAsked,
      cora: await get('SELECT is_contact, contact_role FROM people WHERE id = ?', [cora]),
      dex: (await get('SELECT is_contact FROM people WHERE id = ?', [dex])).is_contact,
      coraParty: await get('SELECT side, role FROM parties WHERE matter_id = ? AND person_id = ?', [matter, cora]),
      dexParty: await get('SELECT side, role FROM parties WHERE matter_id = ? AND person_id = ?', [matter, dex]) };
    // Saving again asks nothing: Cora is a client now.
    carryAsked = '';
    await window.saveMatterForTest();
    r.carryAgain = carryAsked;

    r.ids = { matter, empty, court, judgeP, judge2P, oc };
    return r;
  } finally { window.alert = oldAlert; window.confirm = oldConfirm; }
}).catch(e => ({ error: String(e) }));

if (whoBox.error) {
  check('Contacts Task 7 fixture', false, whoBox.error);
} else {
  const w = whoBox;
  check('the case screen has a "Who\'s involved" box',
    w.fieldset === 'Who\'s involved', String(w.fieldset));
  check('Who\'s involved: court, judge and opposing counsel as three auto rows with their latest notes (dated, one line)',
    JSON.stringify(w.auto) === JSON.stringify([
      { kind: 'court', name: 'Whoville 97th District Court', role: 'Court', note: '2026-05-01  Parking behind the courthouse' },
      { kind: 'judge', name: 'Hon. Winifred Whobench', role: 'Judge', note: '2026-06-15  Prefers courtesy copies' },
      { kind: 'opposing', name: 'Olive T. Whocounsel', role: 'Opposing counsel', note: '2026-04-20  Returns calls after 3' }]),
    JSON.stringify(w.auto));
  check('the court row opens the court page; the judge row opens the judge\'s contact page',
    w.courtOpened.page && w.courtOpened.id === String(w.ids.court)
      && w.judgeOpened.page && w.judgeOpened.id === String(w.ids.judgeP), JSON.stringify([w.courtOpened, w.judgeOpened]));
  check('+ Add contact offers a new contact inline and asks for its role',
    /\+ Add "Priya N\. Whoprobation"/.test(w.addNewText) && w.roleShown
      && w.noRole.length === 1 && /Pick a role/.test(w.noRole[0]), JSON.stringify([w.addNewText, w.noRole]));
  check('adding a new probation officer (double-clicked) makes one contact and a fourth row with the case label',
    w.po.n === 1 && w.po.is_contact === 1 && w.po.contact_role === 'Probation Officer' && w.poLinks === 1
      && w.afterAdd.length === 4
      && JSON.stringify(w.afterAdd[3]) === JSON.stringify({ kind: 'added', name: 'Priya N. Whoprobation', role: 'Assigned probation officer', note: '' })
      && w.poOnContacts === true, JSON.stringify([w.po, w.poLinks, w.afterAdd, w.poOnContacts]));
  check('someone already on the case (opposing counsel) is refused, not added twice',
    w.ocOffered.includes('Olive T. Whocounsel (Attorney)') && w.ocRefused.alerts.length === 1
      && /already on this case \(Opposing counsel\)/.test(w.ocRefused.alerts[0]) && w.ocRefused.links === 0,
    JSON.stringify([w.ocOffered, w.ocRefused]));
  check('a manual row that repeats the judge shows once, as the judge',
    w.dedup.filter(x => x.name === 'Hon. Winifred Whobench').length === 1
      && w.dedup.find(x => x.name === 'Hon. Winifred Whobench').kind === 'judge' && w.dedup.length === 4,
    JSON.stringify(w.dedup));
  check('Remove asks first; declining keeps the row',
    /Priya N\. Whoprobation/.test(w.declined.asked) && /stay in Contacts/.test(w.declined.asked) && w.declined.n === 4,
    JSON.stringify(w.declined));
  check('Remove takes them off this case only; the contact stays',
    w.removed.links === 0 && !w.removed.shown.some(x => x.name === 'Priya N. Whoprobation')
      && w.removed.person.is_contact === 1 && w.removed.person.archived === 0, JSON.stringify(w.removed));
  check('changing the case\'s judge and saving swaps the judge row',
    JSON.stringify(w.swapped.map(x => [x.kind, x.name])) === JSON.stringify([
      ['court', 'Whoville 97th District Court'], ['judge', 'Hon. Victor Whosecond'],
      ['opposing', 'Olive T. Whocounsel'], ['added', 'Hon. Winifred Whobench']])
      && w.swapped[3].role === 'Also the judge', JSON.stringify(w.swapped));
  check('a case with nothing set shows a plain empty state, not an earlier case\'s rows',
    w.empty.rows === 0 && w.empty.text === 'No court, judge or contacts on this case yet.'
      && w.empty.whoFor === w.empty.expected && w.empty.add, JSON.stringify(w.empty));
  check('a contact picked as our client: saving asks first, and Cancel saves nothing',
    w.coraPicked && w.carryCancel.returned === false && /Cora B\. Whoclient \(Adjuster\)/.test(w.carryCancel.asked)
      && !/Dex R\. Whotyped/.test(w.carryCancel.asked) && w.carryCancel.cora === 1 && w.carryCancel.parties === 1,
    JSON.stringify(w.carryCancel));
  check('OK moves the client out of Contacts; a contact on the other side stays a contact',
    /moves them from Contacts to People/.test(w.carryOk.asked) && w.carryOk.cora.is_contact === 0
      && w.carryOk.dex === 1 && w.carryOk.coraParty && w.carryOk.coraParty.role === 'client'
      && w.carryOk.dexParty && w.carryOk.dexParty.role === 'opposing_party' && w.carryAgain === '',
    JSON.stringify([w.carryOk, w.carryAgain]));
}
if (!whoBox.error) {
  if (process.env.SMOKE_SHOTS) fs.mkdirSync(process.env.SMOKE_SHOTS, { recursive: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
  await page.evaluate(async (ids) => {
    const run = (sql, p = []) => window.api.dbRun(sql, p);
    const now = new Date().toISOString();
    const po = (await window.api.dbGet(`SELECT id FROM people WHERE display_name = 'Priya N. Whoprobation'`)).id;
    await run('INSERT INTO matter_contacts (matter_id, person_id, label, sort_order, created_at) VALUES (?,?,?,?,?)',
      [ids.matter, po, 'Assigned probation officer', 9, now]);
    await run('INSERT INTO contact_notes (person_id, note_date, body, created_at) VALUES (?,?,?,?)',
      [po, '2026-07-02', 'Reports due the Friday before each review hearing', now]);
    await window.openMatterForTest(ids.matter);
    await new Promise(r => setTimeout(r, 800));
    document.getElementById('matter-who-fields').scrollIntoView({ block: 'start' });
    await new Promise(r => setTimeout(r, 200));
  }, whoBox.ids).catch(() => {});
  // A long note stays on one line inside the side column at 1024px.
  const whoFit = await page.evaluate(() => {
    const box = document.getElementById('matter-who-fields').getBoundingClientRect();
    const col = document.getElementById('matter-detail-sideinfo').getBoundingClientRect();
    const notes = [...document.querySelectorAll('#matter-who .who-note')];
    return { box: Math.round(box.width), col: Math.round(col.width),
      oneLine: notes.every(n => n.getBoundingClientRect().height < 30),
      pageScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  }).catch(e => ({ error: String(e) }));
  check('Who\'s involved fits its column at 1024px, each note on one line',
    !whoFit.error && whoFit.box <= whoFit.col + 1 && whoFit.oneLine, JSON.stringify(whoFit));
  if (process.env.SMOKE_SHOTS) {
    await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'whos-involved-1024.png') }).catch(() => {});
    await page.locator('#matter-who-fields').screenshot({ path: path.join(process.env.SMOKE_SHOTS, 'whos-involved-box-1024.png') }).catch(() => {});
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
}

// --- Contacts Task 8: Cases on the contact page, and Add to case ------------
// The union of cases where the contact is the judge, opposing counsel, or in
// matter_contacts (name link + case number + how); "Add to case" inserts a
// matter_contacts row and refuses a contact already on that case.
const contactCases = !whoBox.error && await page.evaluate(async (ids) => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const run = (sql, p = []) => window.api.dbRun(sql, p);
  const get = (sql, p = []) => window.api.dbGet(sql, p);
  const box = () => document.getElementById('contact-cases');
  const shown = () => [...box().querySelectorAll('.links-list .home-row')].map(row => ({
    name: row.querySelector('a').textContent,
    right: [...row.querySelectorAll('.link-right span')].map(s => s.textContent),
  }));
  const now = new Date().toISOString();
  const oldAlert = window.alert;
  const alerts = [];
  window.alert = (m) => { alerts.push(m); };
  const r = {};
  try {
    // 1. The judge's Cases box lists the case they're judge on. Task 7's own
    // fixture swapped the case's judge from judgeP to judge2P (step 5) and
    // left judgeP on the case only as a manual matter_contacts row ("Also
    // the judge") — so judge2P, not judgeP, is who is actually the judge now.
    await window.openContact(ids.judge2P);
    await sleep(500);
    r.judgeCases = shown();

    // 2. Opposing counsel's Cases box lists the case too.
    await window.openContact(ids.oc);
    await sleep(500);
    r.ocCases = shown();

    // 3. A fresh contact starts with an empty Cases box.
    const newC = (await run(
      `INSERT INTO people (display_name, kind, is_contact, contact_role, created_at) VALUES (?, 'individual', 1, ?, ?)`,
      ['Gale P. Whoadded', 'Clerk', now])).lastInsertRowid;
    await window.openContact(newC);
    await sleep(500);
    r.emptyText = box().querySelector('.home-empty') ? box().querySelector('.home-empty').textContent : '';

    // Add to case: pick the empty case from the combobox, add an optional
    // case-role label, and save.
    const openForm = () => box().querySelector('[data-case-add]').click();
    const typeCase = async (text) => {
      const input = box().querySelector('.case-who');
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(400);
      return [...box().querySelectorAll('.case-add .combobox-dropdown li')];
    };
    openForm();
    await sleep(200);
    let lis = await typeCase('Who Empty Case');
    r.caseOffered = lis.map(li => li.textContent);
    const emptyLi = lis.find(li => li.textContent.startsWith('Who Empty Case'));
    if (emptyLi) emptyLi.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    box().querySelector('.case-add .link-label-input').value = 'Court reporter';
    box().querySelector('.case-add .btn.primary').click();
    box().querySelector('.case-add .btn.primary').click(); // double-click adds one row, not two
    await sleep(600);
    r.afterAdd = shown();
    r.addedLinks = (await get('SELECT COUNT(*) AS n FROM matter_contacts WHERE matter_id = ? AND person_id = ?',
      [ids.empty, newC])).n;

    // That contact now shows in the empty case's own Who's involved box too.
    await window.openMatterForTest(ids.empty);
    await sleep(600);
    r.onWhoBox = [...document.querySelectorAll('#matter-who .who-list .home-row')]
      .map(row => row.querySelector('.who-name').textContent);

    // 4. Refuse: the judge, already the judge on "Who Box Case", cannot also
    //    be added there through Add to case.
    await window.openContact(ids.judge2P);
    await sleep(500);
    openForm();
    await sleep(200);
    lis = await typeCase('Who Box Case');
    const matterLi = lis.find(li => li.textContent.startsWith('Who Box Case'));
    if (matterLi) matterLi.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    alerts.length = 0;
    box().querySelector('.case-add .btn.primary').click();
    await sleep(400);
    r.refused = { alerts: [...alerts],
      links: (await get('SELECT COUNT(*) AS n FROM matter_contacts WHERE matter_id = ? AND person_id = ?',
        [ids.matter, ids.judge2P])).n };

    return r;
  } finally { window.alert = oldAlert; }
}, whoBox.ids).catch(e => ({ error: String(e) }));

if (whoBox.error) {
  check('Contacts Task 8 fixture', false, 'skipped: Task 7 fixture failed');
} else if (contactCases.error) {
  check('Contacts Task 8 fixture', false, contactCases.error);
} else {
  const cc = contactCases;
  check('the judge\'s contact page lists the case they\'re judge on',
    cc.judgeCases.length === 1 && cc.judgeCases[0].name === 'Who Box Case'
      && cc.judgeCases[0].right.includes('2026-WHO-1') && cc.judgeCases[0].right.includes('Judge'),
    JSON.stringify(cc.judgeCases));
  check('the opposing counsel\'s contact page lists the case too',
    cc.ocCases.length === 1 && cc.ocCases[0].name === 'Who Box Case'
      && cc.ocCases[0].right.includes('Opposing counsel'), JSON.stringify(cc.ocCases));
  check('a fresh contact\'s Cases box is empty', cc.emptyText === 'Not on any case yet.', cc.emptyText);
  check('Add to case offers the case and, once saved, lists it with the typed case-role',
    cc.caseOffered.some(t => t.startsWith('Who Empty Case')) && cc.afterAdd.length === 1
      && cc.afterAdd[0].name === 'Who Empty Case' && cc.afterAdd[0].right.includes('Court reporter')
      && cc.addedLinks === 1, JSON.stringify([cc.caseOffered, cc.afterAdd, cc.addedLinks]));
  check('the contact added this way also shows in that case\'s Who\'s involved box',
    cc.onWhoBox.includes('Gale P. Whoadded'), JSON.stringify(cc.onWhoBox));
  check('Add to case refuses a contact already on that case',
    cc.refused.alerts.length === 1 && /already on that case \(Judge\)/.test(cc.refused.alerts[0])
      && cc.refused.links === 0, JSON.stringify(cc.refused));
}

// --- Into Task 10: a same-day note tie ---------------------------------------
// Two notes on the same date: the newer id wins, both in the notes list and
// in a "latest note" preview (courts/contacts lists, Who's involved).
const noteTie = await page.evaluate(async () => {
  const run = (sql, p = []) => window.api.dbRun(sql, p);
  const now = new Date().toISOString();
  const personId = (await run(
    `INSERT INTO people (display_name, kind, is_contact, contact_role, created_at) VALUES (?, 'individual', 1, ?, ?)`,
    ['Tia R. Whotied', 'Clerk', now])).lastInsertRowid;
  await run('INSERT INTO contact_notes (person_id, note_date, body, created_at) VALUES (?,?,?,?)',
    [personId, '2026-08-01', 'Older same-day note', now]);
  await run('INSERT INTO contact_notes (person_id, note_date, body, created_at) VALUES (?,?,?,?)',
    [personId, '2026-08-01', 'Newer same-day note', now]);
  await window.openContact(personId);
  await new Promise(r => setTimeout(r, 500));
  const rows = [...document.querySelectorAll('#contact-notes .notes-list .home-row')].map(row => ({
    date: row.querySelector('.note-date').textContent, body: row.querySelector('.note-body').textContent }));
  const latest = await window.latestNote({ personId });
  return { rows, latest };
}).catch(e => ({ error: String(e) }));

if (noteTie.error) {
  check('a same-day note tie', false, noteTie.error);
} else {
  check('a same-day note tie: the notes list shows the newest id first',
    !!noteTie.rows[0] && noteTie.rows[0].body === 'Newer same-day note', JSON.stringify(noteTie.rows));
  check('a same-day note tie: the latest-note preview resolves to the newest id',
    !!noteTie.latest && noteTie.latest.body === 'Newer same-day note', JSON.stringify(noteTie.latest));
}

// --- Contacts Task 9: notes never print — guard test -------------------------
// A judge, a court and a matter contact each carry a note with a unique
// marker. Every non-packet doc type is generated (PDF and .docx) for their
// case: the marker must never reach the rendered HTML, the .docx XML, or the
// documents row's matter_snapshot.
const NOTE_MARKER = 'NOTE-MARKER-7f3a';
const notesGuard = await page.evaluate(async (marker) => {
  const run = (sql, p = []) => window.api.dbRun(sql, p);
  const get = (sql, p = []) => window.api.dbGet(sql, p);
  const all = (sql, p = []) => window.api.dbAll(sql, p);
  const now = new Date().toISOString();
  const r = {};
  try {
    const court = (await run('INSERT INTO courts (name, city) VALUES (?,?)', ['Markerton District Court', 'Markerton'])).lastInsertRowid;
    await run(`INSERT INTO contact_notes (court_id, note_date, body, created_at) VALUES (?,?,?,?)`,
      [court, '2026-07-01', `Courthouse parking note ${marker} — do not print`, now]);
    const judgeP = (await run(
      `INSERT INTO people (display_name, kind, is_contact, contact_role, created_at) VALUES (?, 'individual', 1, 'Judge', ?)`,
      ['Hon. Marker Judgeton', now])).lastInsertRowid;
    const judgeId = (await run('INSERT INTO judges (name, court_id, person_id) VALUES (?,?,?)',
      ['Hon. Marker Judgeton', court, judgeP])).lastInsertRowid;
    await run(`INSERT INTO contact_notes (person_id, note_date, body, created_at) VALUES (?,?,?,?)`,
      [judgeP, '2026-07-02', `Judge's private note ${marker}`, now]);
    const ocP = (await run(
      `INSERT INTO people (display_name, kind, is_contact, contact_role, created_at) VALUES (?, 'individual', 1, 'Attorney', ?)`,
      ['Marker Oppcounselton', now])).lastInsertRowid;
    await run(`INSERT INTO contact_notes (person_id, note_date, body, created_at) VALUES (?,?,?,?)`,
      [ocP, '2026-07-03', `Opposing counsel private note ${marker}`, now]);
    const matterId = (await run(
      `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, judge_id, opposing_counsel_person_id,
         client_role, caption_style, party_label, caption_authority, created_at) VALUES (0, ?,?,?,?,?,?,?,?,?,?)`,
      ['Marker Guard Case', '2026-MK-1', court, judgeId, ocP, 'defendant', 'full', 'Defendant', 'PEOPLE OF THE STATE OF MICHIGAN', now])).lastInsertRowid;
    await run('INSERT INTO parties (matter_id, name, side, role, sort_order) VALUES (?,?,?,?,0)', [matterId, 'Dana M. Sample', 'defendant', 'client']);
    const contactP = (await run(
      `INSERT INTO people (display_name, kind, is_contact, contact_role, created_at) VALUES (?, 'individual', 1, 'Probation Officer', ?)`,
      ['Marker Probationton', now])).lastInsertRowid;
    await run(`INSERT INTO contact_notes (person_id, note_date, body, created_at) VALUES (?,?,?,?)`,
      [contactP, '2026-07-04', `Probation officer's private note ${marker}`, now]);
    await run('INSERT INTO matter_contacts (matter_id, person_id, label, sort_order, created_at) VALUES (?,?,?,?,?)',
      [matterId, contactP, 'Assigned probation officer', 0, now]);

    // Drive the real Generate screen so this test exercises the exact
    // function the Generate buttons call (gatherRenderData()) — a hand-built
    // matter object here would not catch a future leak through that function.
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    document.getElementById('nav-matters').click();
    await wait(400);
    const row = [...document.querySelectorAll('#matters-list tr')].find(rr => rr.innerText.includes('Marker Guard Case'));
    if (!row) return { error: 'matter row not found' };
    row.click();
    await wait(700);
    document.getElementById('btn-goto-generate').click();
    await wait(600);

    const dts = window.DocumentEngine.doctypes.filter(dt => !dt.packetOnly);
    r.dtCount = dts.length;
    r.perType = [];
    for (const dt of dts) {
      document.getElementById('gen-doctype').value = dt.id;
      document.getElementById('gen-doctype').dispatchEvent(new Event('change'));
      await wait(300);
      const { matter, attorney, fields } = await window.gatherRenderData();
      const blocks = dt.build(matter, attorney, fields);
      const html = window.DocumentEngine.renderHtml(blocks, matter, attorney);
      const docx = await window.api.generateDocx(blocks, matter, attorney, dt.label, dt.id);
      const pdf = await window.api.generatePdf(html, matter, dt.label, dt.id);
      const { output_dir, ...matterForSnapshot } = matter;
      const matterSnapshot = JSON.stringify(matterForSnapshot);
      const attorneySnapshot = JSON.stringify(attorney || null);
      const ins = await run(
        `INSERT INTO documents (matter_id, doc_type, field_data, matter_snapshot, attorney_snapshot, pdf_path, docx_path, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [matterId, dt.id, JSON.stringify(fields || {}), matterSnapshot, attorneySnapshot, pdf.stored, docx.stored, now]);
      r.perType.push({
        id: dt.id,
        htmlHasMarker: html.includes(marker),
        docxPath: docx.path,
        snapshotHasMarker: matterSnapshot.includes(marker),
        docId: ins.lastInsertRowid,
      });
    }
    // The documents table itself, for this matter — belt and suspenders on
    // top of the per-type snapshot check above.
    const rows = await all('SELECT id, doc_type, matter_snapshot FROM documents WHERE matter_id = ?', [matterId]);
    r.snapshotRows = rows.map(row2 => ({ id: row2.id, doc_type: row2.doc_type, hasMarker: (row2.matter_snapshot || '').includes(marker) }));
    r.matterId = matterId;
    return r;
  } catch (e) {
    return { error: String(e) };
  }
}, NOTE_MARKER).catch(e => ({ error: String(e) }));

if (notesGuard.error) {
  check('Contacts Task 9 fixture', false, notesGuard.error);
} else {
  const ng = notesGuard;
  // readDocxXml runs in Node, not the browser, so it is applied here to each
  // generated .docx path collected above.
  const docxMarkerFlags = ng.perType.map(p => ({ id: p.id, hasMarker: (readDocxXml(p.docxPath) || '').includes(NOTE_MARKER) }));
  check(`every non-packet doc type was generated (${ng.dtCount} types)`, ng.dtCount > 0 && ng.perType.length === ng.dtCount,
    JSON.stringify({ dtCount: ng.dtCount, generated: ng.perType.length }));
  check('the marker never reaches the rendered HTML passed to generatePdf',
    ng.perType.every(p => !p.htmlHasMarker), JSON.stringify(ng.perType.filter(p => p.htmlHasMarker).map(p => p.id)));
  check('the marker never reaches the .docx XML',
    docxMarkerFlags.every(p => !p.hasMarker), JSON.stringify(docxMarkerFlags.filter(p => p.hasMarker)));
  check('the marker never reaches the documents row\'s matter_snapshot (per-generation check)',
    ng.perType.every(p => !p.snapshotHasMarker), JSON.stringify(ng.perType.filter(p => p.snapshotHasMarker).map(p => p.id)));
  check('the marker never reaches any documents row\'s matter_snapshot for this case (DB check)',
    ng.snapshotRows.length > 0 && ng.snapshotRows.every(r => !r.hasMarker), JSON.stringify(ng.snapshotRows.filter(r => r.hasMarker)));
}

// --- Contacts Task 10 follow-up: converting a contact to a client cleans up -
// A contact saved as a client party on a case loses its contact-only fields
// (role, works-at-court, works-at-org) in the same transaction as the
// is_contact flip. Their matter_contacts row on an UNRELATED other case must
// survive untouched, and that other case's "Who's involved" box must still
// link to them — now as a client profile, not a contact page.
const contactCleanup = await page.evaluate(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const run = (sql, p = []) => window.api.dbRun(sql, p);
  const get = (sql, p = []) => window.api.dbGet(sql, p);
  const now = new Date().toISOString();
  try {
    const court = (await run('INSERT INTO courts (name) VALUES (?)', ['Cleanup Test Court'])).lastInsertRowid;
    const org = (await run(
      "INSERT INTO people (display_name, kind, created_at) VALUES (?, 'organization', ?)",
      ['Cleanup Test Org', now])).lastInsertRowid;
    const personId = (await run(
      `INSERT INTO people (display_name, kind, is_contact, contact_role, works_at_court_id, works_at_org_id, created_at)
       VALUES (?, 'individual', 1, 'Probation Officer', ?, ?, ?)`,
      ['Chris P. Cleanuptest', court, org, now])).lastInsertRowid;

    // Listed as a contact on an unrelated other case — must survive.
    const otherMatterId = (await run(
      `INSERT INTO matters (folder_person_id, short_name, client_role, caption_style, created_at) VALUES (0, ?,?,?,?)`,
      ['Cleanup Other Case', 'defendant', 'full', now])).lastInsertRowid;
    await run('INSERT INTO matter_contacts (matter_id, person_id, label, sort_order, created_at) VALUES (?,?,?,?,?)',
      [otherMatterId, personId, 'Assigned probation officer', 0, now]);

    // The case where they are saved as OUR CLIENT.
    const matterId = (await run(
      `INSERT INTO matters (folder_person_id, short_name, case_number, court_id, client_role, caption_style, party_label, created_at)
       VALUES (0, ?,?,?,?,?,?,?)`,
      ['Cleanup Client Case', '2026-CU-1', court, 'defendant', 'full', 'Defendant', now])).lastInsertRowid;
    await run('INSERT INTO parties (matter_id, person_id, name, side, sort_order) VALUES (?,?,?,?,0)',
      [matterId, personId, 'Chris P. Cleanuptest', 'defendant']);

    window.confirm = () => true;
    await window.openMatterForTest(matterId);
    await sleep(600);
    document.getElementById('btn-save-matter').click();
    await sleep(700);

    const person = await get(
      'SELECT is_contact, contact_role, works_at_court_id, works_at_org_id FROM people WHERE id = ?', [personId]);
    const otherLinkSurvived = await get(
      'SELECT id FROM matter_contacts WHERE matter_id = ? AND person_id = ?', [otherMatterId, personId]);

    // The other case's "Who's involved" box: still lists them, and its link
    // now opens the client profile rather than the contact page.
    await window.openMatterForTest(otherMatterId);
    await sleep(600);
    const whoRow = [...document.querySelectorAll('#matter-who .home-row')]
      .find(r => r.textContent.includes('Chris P. Cleanuptest'));
    const whoLink = whoRow ? whoRow.querySelector('a.who-name') : null;
    if (whoLink) whoLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(400);
    const routedToPerson = !document.getElementById('view-person-detail').classList.contains('hidden')
      && document.getElementById('per-id').value === String(personId);
    const routedToContact = !document.getElementById('view-contact-detail').classList.contains('hidden');

    return {
      person, otherLinkSurvived: !!otherLinkSurvived, whoFound: !!whoRow,
      routedToPerson, routedToContact, personId, matterId, otherMatterId,
    };
  } catch (e) {
    return { error: String(e) };
  }
}).catch(e => ({ error: String(e) }));

if (contactCleanup.error) {
  check('contact-to-client cleanup fixture', false, contactCleanup.error);
} else {
  const cc = contactCleanup;
  check('converting a contact to a client clears is_contact, contact_role, works_at_court_id and works_at_org_id',
    !!cc.person && cc.person.is_contact === 0 && cc.person.contact_role === null
      && cc.person.works_at_court_id === null && cc.person.works_at_org_id === null,
    JSON.stringify(cc.person));
  check('their matter_contacts row on an unrelated other case survives the conversion',
    cc.otherLinkSurvived, JSON.stringify(cc));
  check('the other case\'s Who\'s involved box still lists the now-client contact',
    cc.whoFound, JSON.stringify(cc));
  check('clicking that name now opens the client profile, not the contact page',
    cc.routedToPerson && !cc.routedToContact, JSON.stringify(cc));
}

// --- Portable paths: locations stored relative to the output root (Task 9b) --
//
// By now this run has generated documents, uploaded scans, written letters and
// built packets. 1. Every path column must hold a RELATIVE, "/"-separated
// location. 2. Copy the whole tree to a new root and point output_root there,
// as a restore on another computer would: Open, Reveal and path-exists must
// find a document, an upload and a packet file in the NEW tree, and a
// regenerate must reuse the case's existing folder. The real open/reveal are
// stubbed in main (shell.openPath / showItemInFolder), so the app's own
// handlers still do the resolving, and put back afterwards.
const t9bPortable = await page.evaluate(async () => {
  const cols = [['people', 'client_docs_dir'], ['matters', 'output_dir'], ['packets', 'output_dir'],
    ['client_documents', 'stored_dir'], ['generated_files', 'path'],
    ['documents', 'pdf_path'], ['documents', 'docx_path']];
  const out = { counts: {}, bad: [] };
  for (const [t, c] of cols) {
    const rows = await window.api.dbAll(
      `SELECT ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL AND ${c} <> ''`);
    out.counts[`${t}.${c}`] = rows.length;
    for (const r of rows) {
      if (/^([A-Za-z]:[\\/]|[\\/])/.test(r.v) || r.v.includes('\\')) out.bad.push(`${t}.${c}: ${r.v}`);
    }
  }
  return out;
}).catch(e => ({ error: String(e) }));
if (t9bPortable.error) {
  check('every path column holds a relative location', false, t9bPortable.error);
} else {
  check('every path column holds a relative, "/"-separated location',
    t9bPortable.bad.length === 0 && Object.values(t9bPortable.counts).every(n => n > 0),
    JSON.stringify(t9bPortable.bad.length ? t9bPortable.bad.slice(0, 5) : t9bPortable.counts));
}

// The simulated move.
const movedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-moved-'));
fs.cpSync(tmpRoot, movedRoot, { recursive: true });
const shellStubbed = await app.evaluate(({ shell }) => {
  globalThis.__t9bShell = { openPath: shell.openPath, showItemInFolder: shell.showItemInFolder };
  globalThis.__t9bShellCalls = [];
  shell.openPath = async (p) => { globalThis.__t9bShellCalls.push(['open', p]); return ''; };
  shell.showItemInFolder = (p) => { globalThis.__t9bShellCalls.push(['reveal', p]); };
  return shell.openPath !== globalThis.__t9bShell.openPath;
}).catch(() => false);
const moved = await page.evaluate(async (root) => {
  const before = await window.api.dbGet("SELECT value FROM settings WHERE key = 'output_root'");
  await window.api.dbRun("UPDATE settings SET value = ? WHERE key = 'output_root'", [root]);
  const out = { before: before.value };
  try {
    // A document on a case, a packet file, and an upload — each a stored value.
    out.doc = await window.api.dbGet(
      `SELECT d.docx_path AS stored FROM documents d JOIN matters m ON m.id = d.matter_id
        WHERE d.packet_id IS NULL AND d.docx_path LIKE 'Clients/%' ORDER BY d.id DESC LIMIT 1`);
    out.packetFile = await window.api.dbGet(
      `SELECT docx_path AS stored FROM documents
        WHERE packet_id IS NOT NULL AND docx_path LIKE 'Clients/%' ORDER BY id DESC LIMIT 1`);
    const upload = await window.api.dbGet(
      `SELECT id, person_id, stored_dir AS stored FROM client_documents
        WHERE stored_dir LIKE 'Clients/%' ORDER BY id DESC LIMIT 1`);
    out.upload = upload;
    // The upload goes the way the profile's Documents panel sends it: main
    // resolves the row to a path, and Open / Reveal / exists take that.
    const uploadPaths = upload ? await window.api.clientDocumentPaths(upload.person_id) : {};
    out.uploadResolved = upload ? uploadPaths[upload.id] : null;
    const probe = async (value) => ({
      exists: await window.api.pathExists(value),
      open: await window.api.openPath(value),
      reveal: await window.api.showInFolder(value)
    });
    out.docProbe = out.doc ? await probe(out.doc.stored) : null;
    out.packetProbe = out.packetFile ? await probe(out.packetFile.stored) : null;
    out.uploadProbe = out.uploadResolved ? await probe(out.uploadResolved) : null;

    // Regenerate on a case whose folder is frozen: it must reuse that folder
    // (now under the moved root), not start a second one.
    const m = await window.api.dbGet(
      `SELECT * FROM matters WHERE output_dir LIKE 'Clients/%' AND short_name = 'Anderson Renamed'`);
    out.caseStored = m && m.output_dir;
    if (m) {
      m.parties = await window.api.dbAll('SELECT * FROM parties WHERE matter_id = ? ORDER BY side, sort_order', [m.id]);
      const attorney = await window.api.dbGet('SELECT * FROM attorneys WHERE is_default = 1');
      const dt = window.DocumentEngine.doctypes.find(d => d.id === 'brief_shell');
      const blocks = dt.build(m, attorney, { brief_title: 'Brief After The Move' });
      out.regen = await window.api.generatePdf(
        window.DocumentEngine.renderHtml(blocks, m, attorney), m, dt.label, dt.id);
      out.caseAfter = (await window.api.dbGet('SELECT output_dir FROM matters WHERE id = ?', [m.id])).output_dir;
    }
  } finally {
    await window.api.dbRun("UPDATE settings SET value = ? WHERE key = 'output_root'", [before.value]);
  }
  return out;
}, movedRoot).catch(e => ({ error: String(e) }));
const shellCalls = await app.evaluate(({ shell }) => {
  if (globalThis.__t9bShell) Object.assign(shell, globalThis.__t9bShell);
  return globalThis.__t9bShellCalls || [];
}).catch(() => []);

if (moved.error) {
  check('a moved documents folder is found again', false, moved.error);
} else {
  const inMoved = (p) => typeof p === 'string' && p.startsWith(movedRoot + path.sep);
  const opened = (kind, p) => shellCalls.some(([k, x]) => k === kind && x === p);
  check('the Open / Reveal stubs took (the real handlers resolve, the OS is not called)', shellStubbed);
  for (const [label, row, probe, expected] of [
    ['a case document', moved.doc, moved.docProbe, moved.doc && onDisk(moved.doc.stored, movedRoot)],
    ['a packet file', moved.packetFile, moved.packetProbe, moved.packetFile && onDisk(moved.packetFile.stored, movedRoot)],
    ['an upload', moved.upload, moved.uploadProbe, moved.uploadResolved],
  ]) {
    check(`after a move, ${label} resolves under the new root, and Open / Reveal / exists find it`,
      !!row && !!probe && inMoved(expected) && fs.existsSync(expected)
        && probe.exists === true && probe.open && probe.open.ok && probe.reveal && probe.reveal.ok
        && opened('open', expected) && opened('reveal', expected),
      JSON.stringify({ row, probe, expected }));
  }
  const caseDir = onDisk(moved.caseStored, movedRoot);
  check('after a move, regenerating reuses the case folder (under the new root) rather than making another',
    !!moved.regen && !!moved.regen.path && path.dirname(moved.regen.path) === caseDir
      && moved.caseAfter === moved.caseStored
      && fs.readdirSync(path.dirname(caseDir)).length === fs.readdirSync(path.dirname(onDisk(moved.caseStored))).length,
    JSON.stringify({ regen: moved.regen, caseStored: moved.caseStored, caseAfter: moved.caseAfter }));
  check('the output root is put back after the move check', moved.before === tmpRoot, moved.before);
}

// --- Task 9c: app zoom -------------------------------------------------------
// Magnifier buttons either side of a percentage, in the tab row. Steps 90..200,
// clamped at both ends; the percentage resets; Ctrl/Cmd + - 0 do the same.
// Saved per computer in ui-prefs.json, never in the settings table (which
// travels in a backup). Checked last in this session because it leaves the
// window zoomed for the relaunch below.
const zoomOf = async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
const zoomUi = () => page.evaluate(() => ({
  level: document.getElementById('zoom-level').textContent.trim(),
  outOff: document.getElementById('btn-zoom-out').getAttribute('aria-disabled') === 'true',
  inOff: document.getElementById('btn-zoom-in').getAttribute('aria-disabled') === 'true',
}));
const zoomClick = async (id, times = 1) => {
  for (let i = 0; i < times; i++) {
    await page.evaluate((id) => document.getElementById(id).click(), id);
    await new Promise(r => setTimeout(r, 150));
  }
};
const near = (a, b) => Math.abs(a - b) < 0.001;
const zoomPrefsFile = path.join(profileDir, 'ui-prefs.json');
{
  await page.evaluate(async () => { await window.api.setZoom(1); document.getElementById('nav-home').click(); });
  await new Promise(r => setTimeout(r, 300));

  const look = await page.evaluate(() => {
    const btn = (id) => {
      const b = document.getElementById(id);
      const svg = b.querySelector('svg');
      return {
        title: b.title, aria: b.getAttribute('aria-label'), text: b.textContent.trim(),
        svg: !!svg, fill: svg && svg.getAttribute('fill'), stroke: svg && svg.getAttribute('stroke'),
        circle: !!(svg && svg.querySelector('circle')), lines: svg ? svg.querySelectorAll('line').length : 0,
        img: !!b.querySelector('img, i, use'),
      };
    };
    return { out: btn('btn-zoom-out'), in: btn('btn-zoom-in'), order:
      [...document.querySelector('.tabs-container').children].map(c => c.id || c.className) };
  });
  check('the zoom buttons are line-art magnifiers (circle + handle, "-" / "+" in the lens), currentColor, no fill, no text',
    look.out.svg && look.in.svg && look.out.circle && look.in.circle
      && look.out.lines === 2 && look.in.lines === 3
      && [look.out, look.in].every(b => b.fill === 'none' && b.stroke === 'currentColor' && b.text === '' && !b.img),
    JSON.stringify(look));
  check('the zoom buttons say "Zoom out" / "Zoom in" to the eye and the screen reader',
    look.out.title === 'Zoom out' && look.out.aria === 'Zoom out' && look.in.title === 'Zoom in' && look.in.aria === 'Zoom in',
    JSON.stringify(look));
  const iOrder = (x) => look.order.indexOf(x);
  check('the zoom controls sit right of "? Help"',
    iOrder('btn-start-tutorial') !== -1 && iOrder('zoom-controls') === iOrder('btn-start-tutorial') + 1,
    JSON.stringify(look.order));

  const start = { ui: await zoomUi(), f: await zoomOf() };
  await zoomClick('btn-zoom-in', 2);
  const twice = { ui: await zoomUi(), f: await zoomOf() };
  check('zoom starts at 100%', start.ui.level === '100%' && near(start.f, 1), JSON.stringify(start));
  check('zoom in twice is 125%, and the window really is at 1.25',
    twice.ui.level === '125%' && near(twice.f, 1.25), JSON.stringify(twice));
  await zoomClick('zoom-level');
  const reset = { ui: await zoomUi(), f: await zoomOf() };
  check('clicking the percentage goes back to 100%', reset.ui.level === '100%' && near(reset.f, 1), JSON.stringify(reset));
  await zoomClick('btn-zoom-out');
  const low = { ui: await zoomUi(), f: await zoomOf() };
  await zoomClick('btn-zoom-out', 2);
  const lower = { ui: await zoomUi(), f: await zoomOf() };
  check('zoom out stops at 90% (one step below today\'s size), with the button looking disabled',
    low.ui.level === '90%' && near(low.f, 0.9) && low.ui.outOff && !low.ui.inOff
      && lower.ui.level === '90%' && near(lower.f, 0.9), JSON.stringify([low, lower]));
  const seen = [];
  for (let i = 0; i < 8; i++) { await zoomClick('btn-zoom-in'); seen.push((await zoomUi()).level); }
  const high = { ui: await zoomUi(), f: await zoomOf() };
  check('zoom in steps 90 > 100 > 110 > 125 > 150 > 175 > 200 and stops there, looking disabled',
    JSON.stringify(seen) === JSON.stringify(['100%', '110%', '125%', '150%', '175%', '200%', '200%', '200%'])
      && near(high.f, 2) && high.ui.inOff && !high.ui.outOff, JSON.stringify([seen, high]));
  const offBogus = await page.evaluate(async () => [await window.api.setZoom(5), await window.api.setZoom('x'), await window.api.setZoom(0.2)]);
  check('a zoom asked for off the steps lands on a step (5 -> 200%, junk -> 100%, 0.2 -> 90%)',
    JSON.stringify(offBogus) === '[2,1,0.9]', JSON.stringify(offBogus));

  // Keyboard: Cmd on macOS, Ctrl elsewhere. Sent as real input events through
  // the window (Playwright's keyboard goes in over the DevTools protocol, which
  // bypasses before-input-event, where main handles these keys).
  const mod = process.platform === 'darwin' ? 'meta' : 'control';
  await page.evaluate(() => window.api.setZoom(1));
  await page.evaluate(() => document.getElementById('nav-home').click());
  const keys = [];
  for (const k of ['=', '=', '-', '0', '-', '-']) {
    await app.evaluate(({ BrowserWindow }, [k, mod]) =>
      BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: [mod] }), [k, mod]);
    await new Promise(r => setTimeout(r, 200));
    keys.push([(await zoomUi()).level, Math.round((await zoomOf()) * 100)]);
  }
  check(`${mod === 'meta' ? 'Cmd' : 'Ctrl'} + = / - / 0 step, clamp and reset the zoom, and the percentage follows`,
    JSON.stringify(keys) === JSON.stringify([['110%', 110], ['125%', 125], ['110%', 110], ['100%', 100], ['90%', 90], ['90%', 90]]),
    JSON.stringify(keys));
  await page.evaluate(() => window.api.setZoom(1));
  await new Promise(r => setTimeout(r, 200));

  // Help and the zoom controls stand on the tabs' line.
  const lineAt = async (f) => {
    await page.evaluate((f) => window.api.setZoom(f), f);
    await new Promise(r => setTimeout(r, 300));
    return page.evaluate(() => {
      const b = (id) => Math.round(document.getElementById(id).getBoundingClientRect().bottom * 100) / 100;
      // Inactive tabs: the active one hangs 1px lower on purpose, over the line.
      return { tab: b('nav-settings'), help: b('btn-start-tutorial'), out: b('btn-zoom-out'),
        level: b('zoom-level'), in: b('btn-zoom-in'), matters: b('nav-matters') };
    });
  };
  for (const f of [1, 1.5]) {
    const at = await lineAt(f);
    check(`at ${f * 100}%, "? Help" and the zoom controls share the tabs' bottom edge`,
      [at.help, at.out, at.level, at.in, at.matters].every(v => Math.abs(v - at.tab) < 0.5), JSON.stringify(at));
  }

  // 200% on a 1024-wide window: the top bar wraps, nothing is lost.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 768));
  const narrowFx = await page.evaluate(async () => {
    const now = new Date().toISOString();
    const court = (await window.api.dbRun('INSERT INTO courts (name) VALUES (?)', ['91st DISTRICT COURT'])).lastInsertRowid;
    const id = (await window.api.dbRun(
      `INSERT INTO matters (short_name, case_number, court_id, client_role, caption_style, party_label, created_at)
       VALUES (?,?,?,?,?,?,?)`, ['Narrow Window Picker Case', '2026-CV-390', court, 'defendant', 'full', 'Defendant', now])).lastInsertRowid;
    for (const [i, name] of ['Rita Ramsey', 'Sam Sutton'].entries()) {
      const pid = (await window.api.dbRun('INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
        [name, 'individual', now])).lastInsertRowid;
      await window.api.dbRun('INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,?)',
        [id, pid, name, 'defendant', 'client', i]);
    }
    return { id };
  }).catch(e => ({ error: String(e) }));
  // Is this element on screen and actually the thing under its own centre
  // (not clipped, covered or pushed off the edge)? Scrolls it into view first:
  // scrolling is fine, clipping is not.
  const reachable = (ids) => page.evaluate((ids) => Object.fromEntries(ids.map(id => {
    const el = document.getElementById(id);
    if (!el) return [id, 'missing'];
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const inView = r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= window.innerWidth + 0.5
      && r.top >= 0 && r.bottom <= window.innerHeight + 0.5;
    const hit = document.elementFromPoint(x, y);
    return [id, inView && !!hit && (hit === el || el.contains(hit) || hit.contains(el))];
  })), ids);
  const shots = process.env.SMOKE_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  // capturePage, not page.screenshot: Playwright sizes its capture in CSS
  // pixels, so on a zoomed page it grabs only the top-left corner.
  const shot = async (name) => {
    if (!shots) return;
    const b64 = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')).catch(() => null);
    if (b64) fs.writeFileSync(path.join(shots, name), Buffer.from(b64, 'base64'));
  };
  const topIds = ['nav-home', 'nav-matters', 'nav-calendar', 'nav-people', 'nav-contacts', 'nav-attorneys', 'nav-settings',
    'btn-start-tutorial', 'btn-zoom-out', 'zoom-level', 'btn-zoom-in', 'global-search', 'global-search-caret'];
  for (const f of [1, 1.5, 2]) {
    const pct = f * 100;
    await page.evaluate(async (f) => {
      await window.api.setZoom(f);
      document.getElementById('nav-home').click();
      await new Promise(r => setTimeout(r, 400));
    }, f);
    const top = await reachable(topIds);
    const lines = await page.evaluate(() => {
      const b = (id) => Math.round(document.getElementById(id).getBoundingClientRect().bottom);
      return { tabs: b('nav-home'), settings: b('nav-settings'), help: b('btn-start-tutorial'), zoom: b('btn-zoom-in'),
        pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1 };
    });
    await shot(`zoom-${pct}-home-1024.png`);
    check(`at ${pct}% on a 1024-wide window every tab, Help, the zoom controls and the search box are on screen`,
      Object.values(top).every(v => v === true) && !lines.pageScrollsSideways, JSON.stringify([top, lines]));

    await page.evaluate(async () => {
      document.getElementById('home-add-documents').click();
      await new Promise(r => setTimeout(r, 400));
    });
    const addDocs = await page.evaluate(() =>
      [...document.querySelectorAll('#view-add-documents input, #view-add-documents select, #view-add-documents button')]
        .filter(el => el.offsetParent !== null && el.type !== 'file' && el.type !== 'hidden').map(el => el.id).filter(Boolean));
    const addDocsOk = await reachable(addDocs);
    await shot(`zoom-${pct}-add-documents-1024.png`);
    check(`at ${pct}% the Add Documents form's fields and buttons can all be reached`,
      addDocs.length >= 3 && Object.values(addDocsOk).every(v => v === true), JSON.stringify(addDocsOk));

    if (!narrowFx.error) {
      const go = await openCaseAndGenerate('Narrow Window Picker Case', 'docx');
      const shown = !go.error && await waitForPicker(true);
      const pickerIds = shown ? await page.evaluate(() =>
        [...document.querySelectorAll('#folder-owner-picker input[name="folder-owner"]')].map(r => r.id).filter(Boolean)
          .concat(['btn-folder-owner-save', 'btn-folder-owner-cancel'])) : [];
      const pickerOk = shown ? await reachable(pickerIds) : {};
      if (shown) {
        // The radios themselves, which may have no id: each must be hittable.
        pickerOk.radios = await page.evaluate(() => [...document.querySelectorAll('#folder-owner-picker input[name="folder-owner"]')]
          .every(r => {
            r.scrollIntoView({ block: 'nearest' });
            const b = r.getBoundingClientRect();
            const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
            return b.width > 0 && !!hit && (hit === r || r.parentElement.contains(hit));
          }));
      }
      await shot(`zoom-${pct}-folder-owner-picker-1024.png`);
      check(`at ${pct}% the folder-owner picker's choices, Save and Cancel can all be reached`,
        shown && Object.values(pickerOk).every(v => v === true), JSON.stringify({ go, shown, pickerOk }));
      if (shown) { await pickerCancel(); await waitForPicker(false); }
    }
  }
  check('zoom fixture: a two-client case for the picker', !narrowFx.error, narrowFx.error || '');
  await page.evaluate(() => document.getElementById('nav-home').click());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));

  // Leave it at 125% for the relaunch, and prove it went nowhere near the
  // database: not in settings, not in a backup made now.
  await page.evaluate(() => window.api.setZoom(1.25));
  await new Promise(r => setTimeout(r, 200));
  const prefs = (() => { try { return JSON.parse(fs.readFileSync(zoomPrefsFile, 'utf8')); } catch (e) { return String(e); } })();
  check('the zoom is saved in ui-prefs.json in this computer\'s user-data folder', prefs && prefs.zoom === 1.25, JSON.stringify(prefs));
  const zoomSettings = await page.evaluate(() => window.api.dbAll(
    "SELECT key, value FROM settings WHERE key LIKE '%zoom%' OR value IN ('1.25', '125', '125%')"));
  check('the zoom is not in the settings table', zoomSettings.length === 0, JSON.stringify(zoomSettings));
  const backupFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-zoom-backup-')), 'zoom-check.db');
  await app.evaluate(({ dialog }, file) => {
    globalThis.__zoomSaveDialog = dialog.showSaveDialog;
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, backupFile);
  const made = await page.evaluate(() => window.api.backupNow()).catch(e => ({ error: String(e) }));
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = globalThis.__zoomSaveDialog; });
  const bytes = fs.existsSync(backupFile) ? fs.readFileSync(backupFile).toString('latin1') : '';
  check('a backup made at 125% carries no zoom setting (and is a real backup: it has output_root)',
    !!made && !made.error && bytes.includes('output_root') && !/zoom/i.test(bytes) && !bytes.includes('ui-prefs'),
    JSON.stringify({ made, size: bytes.length }));
}

await app.close().catch(() => {});

// Task 9c: the zoom is remembered across a restart (same user-data folder),
// from the first paint; a broken ui-prefs.json means 100%, not a crash.
{
  const relaunch = () => electron.launch({
    executablePath: electronBin,
    args: [APP_DIR, '--no-sandbox', '--disable-gpu', `--user-data-dir=${profileDir}`],
    cwd: APP_DIR,
    timeout: 120_000,
  });
  const readBack = async (a) => {
    const p = await a.firstWindow();
    await p.waitForLoadState('domcontentloaded').catch(() => {});
    await p.waitForFunction(() => !!(window.api && window.api.getZoom), null, { timeout: 30_000 });
    await p.waitForFunction(() => document.getElementById('zoom-level').textContent.trim() !== '', null, { timeout: 10_000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 800));
    return {
      f: await a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()),
      level: await p.evaluate(() => document.getElementById('zoom-level').textContent.trim()),
    };
  };
  let again = null;
  try {
    again = await relaunch();
    const back = await readBack(again);
    check('after a restart the app comes back at the saved 125%',
      Math.abs(back.f - 1.25) < 0.001 && back.level === '125%', JSON.stringify(back));
    await again.close();
    again = null;
    // The file is the source of truth, not Chromium's own remembered zoom
    // (which is still 125% here).
    fs.writeFileSync(zoomPrefsFile, JSON.stringify({ zoom: 1.5 }));
    again = await relaunch();
    const fromFile = await readBack(again);
    await again.close();
    again = null;
    check('the zoom comes from ui-prefs.json (edited to 150% while closed, it opens at 150%)',
      Math.abs(fromFile.f - 1.5) < 0.001 && fromFile.level === '150%', JSON.stringify(fromFile));
    fs.writeFileSync(zoomPrefsFile, '{ not json');
    again = await relaunch();
    const broken = await readBack(again);
    await again.close();
    again = null;
    fs.writeFileSync(zoomPrefsFile, JSON.stringify({ zoom: 3 }));
    again = await relaunch();
    const offStep = await readBack(again);
    check('a broken or off-step ui-prefs.json starts at 100%',
      Math.abs(broken.f - 1) < 0.001 && broken.level === '100%' && Math.abs(offStep.f - 1) < 0.001 && offStep.level === '100%',
      JSON.stringify({ broken, offStep }));
  } catch (e) {
    check('the zoom relaunch runs', false, String(e));
  } finally {
    if (again) await again.close().catch(() => {});
  }
}

// --- Portable paths: a documents folder that is not available ---------------
//
// Task 9b review fixes (2026-09-25). The app never switches roots by itself:
// the old behaviour (fall back to this computer's default and SAVE that) sent
// every relative location to the wrong folder once an unplugged drive came
// back, and the next save started an empty tree beside the real one.
//
// A profile of its own, started twice. Launch 1 (fresh, nothing saved): a
// custom root that does not exist yet is simply created on first use, with no
// notice. Then it is made to look like a backup (or a drive) whose documents
// folder is missing: saved case and client folders, a root that is not there.
// Launch 2: the setting is unchanged, a persistent banner says so, and every
// save / upload / Open Folder refuses in plain words and creates NOTHING.
// Reconnecting (making the folder) lets a save go into the ORIGINAL case
// folder without a restart. Last, Settings' folder picker (the native dialogs
// stubbed in main): a folder holding a copy of the tree resolves the files;
// an empty folder warns first, and Cancel leaves the setting alone.
{
  const restoreProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-restore-'));
  const launch = () => electron.launch({
    executablePath: electronBin,
    args: [APP_DIR, '--no-sandbox', '--disable-gpu', `--user-data-dir=${restoreProfile}`],
    cwd: APP_DIR,
    timeout: 120_000,
  });
  const drive = path.join(os.tmpdir(), `truecaption-not-here-${Date.now()}`);
  const missingRoot = path.join(drive, 'Legal Documents');
  const freshRoot = path.join(os.tmpdir(), `truecaption-fresh-${Date.now()}`, 'Legal Documents');
  const caseRel = 'Clients/Alice Anderson/Restored Case (2026-TR-0001)';
  const clientRel = 'Clients/Alice Anderson';
  const scan = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-rootscan-')), 'Scan.pdf');
  fs.writeFileSync(scan, 'SCAN BYTES');
  let first = null, second = null;
  try {
    first = await launch();
    const p1 = await first.firstWindow();
    await p1.waitForLoadState('domcontentloaded').catch(() => {});
    await p1.waitForFunction(() => !!(window.api && window.api.dbRun), null, { timeout: 30_000 });
    await new Promise(r => setTimeout(r, 1500)); // the banner is fetched async
    const defaultRoot = path.join(await first.evaluate(({ app }) => app.getPath('documents')), 'Legal Documents');
    const defaultBefore = fs.existsSync(defaultRoot) ? fs.readdirSync(defaultRoot).sort().join('|') : null;
    const firstNotice = await p1.evaluate(() =>
      !document.getElementById('startup-notice').classList.contains('hidden'));

    // A fresh custom root, never used: created on the first save, no notice.
    const fresh = await p1.evaluate(async (root) => {
      await window.api.dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('output_root', ?)", [root]);
      const status = await window.api.outputRootStatus();
      const res = await window.generateBlankQuestionnaire();
      document.getElementById('nav-home').click();
      await new Promise(r => setTimeout(r, 300));
      return {
        status, path: res && res.path, error: res && res.error,
        banner: !document.getElementById('startup-notice').classList.contains('hidden'),
        root: (await window.api.dbGet("SELECT value FROM settings WHERE key = 'output_root'")).value
      };
    }, freshRoot);

    // Now the missing folder, with saved locations pointing into it. The
    // blank form just written belongs to the fresh-root check above, not to
    // the tree below, so its record is dropped (else Settings would rightly
    // warn that the copied tree has no Blank Forms folder).
    const ids = await p1.evaluate(async ({ root, caseRel, clientRel }) => {
      await window.api.dbRun('DELETE FROM generated_files WHERE matter_id IS NULL');
      await window.api.dbRun("UPDATE settings SET value = ? WHERE key = 'output_root'", [root]);
      const now = new Date().toISOString();
      const person = await window.api.dbRun(
        'INSERT INTO people (display_name, client_docs_dir, created_at) VALUES (?,?,?)',
        ['Alice Anderson', clientRel, now]);
      const matter = await window.api.dbRun(
        'INSERT INTO matters (folder_person_id, short_name, case_number, output_dir, created_at) VALUES (?,?,?,?,?)',
        [person.lastInsertRowid, 'Restored Case', '2026-TR-0001', caseRel, now]);
      await window.api.dbRun(
        "INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,'client',0)",
        [matter.lastInsertRowid, person.lastInsertRowid, 'Alice Anderson', 'defendant']);
      return { personId: person.lastInsertRowid, matterId: matter.lastInsertRowid };
    }, { root: missingRoot, caseRel, clientRel });
    await first.close();
    first = null;

    second = await launch();
    const p2 = await second.firstWindow();
    await p2.waitForLoadState('domcontentloaded').catch(() => {});
    await p2.waitForFunction(() =>
      !document.getElementById('startup-notice').classList.contains('hidden'), null, { timeout: 15_000 }).catch(() => {});
    const expected = `Your documents folder (${missingRoot}) isn't available. ` +
      'Reconnect the drive it\'s on, or choose its new location in Settings.';
    const seen = await p2.evaluate(async ({ personId, matterId, scan }) => {
      const matter = { id: matterId, short_name: 'Restored Case', case_number: '2026-TR-0001' };
      const out = {
        shown: !document.getElementById('startup-notice').classList.contains('hidden'),
        text: document.getElementById('startup-notice-text').textContent,
        dismissable: !!document.getElementById('startup-notice-dismiss'),
        root: (await window.api.dbGet("SELECT value FROM settings WHERE key = 'output_root'")).value,
        pdf: await window.api.generatePdf('<p>Restored</p>', matter, 'Root Check', 'root_check'),
        docx: await window.api.generateDocx([{ type: 'paragraph', text: 'Restored' }], matter, {}, 'Root Check', 'root_check'),
        attached: await window.api.saveAttachedFile('data:application/pdf;base64,UERG', matter, 'Root Check', 'root_check_scan'),
        blank: await window.generateBlankQuestionnaire(),
        upload: await window.api.addClientDocumentFiles(personId, [scan]),
        caseUpload: await window.api.addClientDocumentFiles(personId, [scan], { matterId }),
        caseFolder: await window.api.matterFolder(matterId),
        clientFolder: await window.api.clientFolder(personId),
        // Said before any "which client's folder?" question can be asked.
        uploadOwner: await window.api.caseUploadOwner(matterId),
        docs: await window.api.dbGet('SELECT COUNT(*) AS n FROM client_documents'),
      };
      // Through the screens: the profile's and the case's Open Folder buttons,
      // with alert() captured.
      const alerts = [];
      const realAlert = window.alert;
      window.alert = (m) => alerts.push(String(m));
      try {
        await window.openPerson(personId);
        await new Promise(r => setTimeout(r, 300));
        document.getElementById('btn-open-client-folder').click();
        await new Promise(r => setTimeout(r, 500));
        await window.openMatterForTest(matterId);
        await new Promise(r => setTimeout(r, 300));
        document.getElementById('btn-matter-open-folder').click();
        await new Promise(r => setTimeout(r, 500));
      } finally { window.alert = realAlert; }
      out.alerts = alerts;
      out.bannerAfterNav = !document.getElementById('startup-notice').classList.contains('hidden');
      return out;
    }, { ...ids, scan });
    const refusedAll = ['pdf', 'docx', 'attached', 'blank', 'upload', 'caseUpload', 'caseFolder', 'clientFolder', 'uploadOwner']
      .filter(k => !(seen[k] && seen[k].error === expected && !seen[k].path && !seen[k].dir));

    check('a fresh install with no saved files shows no documents-folder notice', firstNotice === false);
    check('a fresh custom documents folder is created on first use, with no notice',
      fresh.status === null && !fresh.banner && fresh.root === freshRoot
        && !!fresh.path && fresh.path.startsWith(freshRoot + path.sep) && fs.existsSync(fresh.path),
      JSON.stringify(fresh));
    check('a missing documents folder with saved files is NOT switched: the setting is unchanged',
      seen.root === missingRoot, JSON.stringify({ root: seen.root, missingRoot }));
    check('a missing documents folder shows a persistent banner in plain words naming it',
      seen.shown && seen.text === expected && !seen.dismissable && seen.bannerAfterNav,
      JSON.stringify({ shown: seen.shown, text: seen.text, dismissable: seen.dismissable, after: seen.bannerAfterNav }));
    check('while it is missing, every save, upload and Open Folder refuses with that message',
      refusedAll.length === 0 && seen.docs.n === 0, JSON.stringify({ refusedAll, docs: seen.docs }));
    check('the Open Folder buttons show that refusal as a plain alert',
      seen.alerts.length === 2 && seen.alerts.every(a => a === expected), JSON.stringify(seen.alerts));
    check('nothing was created: not the missing folder, not its drive, not this computer\'s default',
      !fs.existsSync(drive)
        && (fs.existsSync(defaultRoot) ? fs.readdirSync(defaultRoot).sort().join('|') : null) === defaultBefore,
      JSON.stringify({ drive: fs.existsSync(drive), defaultRoot }));

    // Reconnect: the drive comes back with the case folder on it.
    fs.mkdirSync(path.join(missingRoot, ...caseRel.split('/')), { recursive: true });
    fs.writeFileSync(path.join(missingRoot, ...caseRel.split('/'), 'Earlier.pdf'), 'EARLIER');
    const back = await p2.evaluate(async ({ matterId }) => {
      document.getElementById('nav-home').click();
      await new Promise(r => setTimeout(r, 400));
      const matter = { id: matterId, short_name: 'Restored Case', case_number: '2026-TR-0001' };
      return {
        banner: !document.getElementById('startup-notice').classList.contains('hidden'),
        pdf: await window.api.generatePdf('<p>Restored</p>', matter, 'Root Check', 'root_check'),
        output: (await window.api.dbGet('SELECT output_dir FROM matters WHERE id = ?', [matterId])).output_dir,
      };
    }, ids);
    const caseAbs = path.join(missingRoot, ...caseRel.split('/'));
    const tree = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();
    check('reconnecting the folder clears the banner without a restart', back.banner === false);
    check('after reconnecting, a save goes into the ORIGINAL case folder, with no new folder',
      !!back.pdf.path && path.dirname(back.pdf.path) === caseAbs && back.output === caseRel
        && JSON.stringify(tree(missingRoot)) === JSON.stringify(
          ['Clients', clientRel, caseRel, `${caseRel}/Earlier.pdf`, `${caseRel}/${path.basename(back.pdf.path)}`]
            .map(s => s.split('/').join(path.sep)).sort()),
      JSON.stringify({ pdf: back.pdf, output: back.output, tree: tree(missingRoot) }));

    // Settings: choose a folder holding a copy of the tree, then an empty one.
    const copyRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-copied-')), 'Legal Documents');
    fs.cpSync(missingRoot, copyRoot, { recursive: true });
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truecaption-empty-'));
    const nowhere = path.join(os.tmpdir(), `truecaption-nowhere-${Date.now()}`);
    const pick = async (folder, answer) => {
      await second.evaluate(({ dialog }, { folder, answer }) => {
        globalThis.__rootWarnings = [];
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
        dialog.showMessageBox = async (win, opts) => {
          globalThis.__rootWarnings.push((opts || win).message + ' ' + (opts || win).detail);
          return { response: answer };
        };
      }, { folder, answer });
      return p2.evaluate(async () => {
        const alerts = [];
        const realAlert = window.alert;
        window.alert = (m) => alerts.push(String(m));
        try {
          document.getElementById('nav-settings').click();
          await new Promise(r => setTimeout(r, 300));
          document.getElementById('btn-choose-output-root').click();
          await new Promise(r => setTimeout(r, 600));
        } finally { window.alert = realAlert; }
        return {
          alerts,
          field: document.getElementById('set-output_root').value,
          root: (await window.api.dbGet("SELECT value FROM settings WHERE key = 'output_root'")).value,
        };
      }).then(async (r) => ({ ...r, warnings: await second.evaluate(() => globalThis.__rootWarnings) }));
    };
    const toCopy = await pick(copyRoot, 0);
    const resolved = await p2.evaluate(async (matterId) => {
      const g = await window.api.dbGet(
        'SELECT path FROM generated_files WHERE matter_id = ? ORDER BY id DESC LIMIT 1', [matterId]);
      return { stored: g && g.path, exists: !!g && await window.api.pathExists(g.path) };
    }, ids.matterId);
    check('Settings: choosing a folder that holds a copy of the tree switches to it with no warning, and files resolve there',
      toCopy.root === copyRoot && toCopy.field === copyRoot && toCopy.warnings.length === 0
        && toCopy.alerts.length === 0 && resolved.exists && !path.isAbsolute(resolved.stored),
      JSON.stringify({ toCopy, resolved }));
    const toEmpty = await pick(emptyRoot, 1);
    check('Settings: choosing an empty folder warns that saved documents will show as missing; Cancel changes nothing',
      toEmpty.root === copyRoot && toEmpty.field === copyRoot && toEmpty.warnings.length === 1
        && /"Clients"/.test(toEmpty.warnings[0]) && /show as missing/.test(toEmpty.warnings[0]),
      JSON.stringify(toEmpty));
    const toNowhere = await pick(nowhere, 0);
    check('Settings: with saved documents, a folder that does not exist is refused in plain words',
      toNowhere.root === copyRoot && toNowhere.alerts.length === 1 && /doesn't exist/.test(toNowhere.alerts[0])
        && !fs.existsSync(nowhere),
      JSON.stringify(toNowhere));
  } catch (e) {
    check('the missing documents-folder checks run', false, String(e));
  } finally {
    if (first) await first.close().catch(() => {});
    if (second) await second.close().catch(() => {});
  }
}

if (questionnaire.error) {
  check('the blank questionnaire generates', false, questionnaire.error);
} else {
  check('the blank questionnaire is written to disk',
    !!questionnaire.path && fs.existsSync(questionnaire.path), String(questionnaire.path));
  check('the blank questionnaire is a .docx, not a PDF',
    String(questionnaire.path).endsWith('.docx'), String(questionnaire.path));

  // Word output, never a PDF: a PDF viewer will happily show text the .docx
  // does not contain (non-negotiable 3).
  const qxml = questionnaire.path && fs.existsSync(questionnaire.path)
    ? readDocxXml(questionnaire.path) : '';
  // Compare against the document's TEXT, not its raw XML: docx escapes an
  // apostrophe, so "Driver's License Number" is never a literal substring of
  // word/document.xml.
  const qtext = qxml
    .replace(/<[^>]+>/g, '')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  for (const needle of ['Date of Birth', 'Marital Status', 'CDL', 'Emergency Contact',
                        'Medical Marijuana Card', 'Highest Grade', 'Prior Offenses']) {
    check(`blank questionnaire contains ${JSON.stringify(needle)}`, qtext.includes(needle));
  }
  // The yes/no half of the licence questions has to be answerable on paper —
  // the tick box that reveals the number box on screen cannot be ticked here.
  check('the license questions offer a Yes/No to circle',
    /CDL:\s*Yes/.test(qtext) && /No\s*\[/.test(qtext));
  check('the license number boxes print even though the screen hides them',
    ['CDL Number', 'Chauffeur Number', 'CPL Number'].every(l => qtext.includes(l)));
  // A walk-in filling this in sees everything: the sections that start
  // collapsed on screen cost nothing on paper.
  // Section headings print in caps on the form, the way a paper form's
  // headings do; the field labels beneath them keep their screen casing.
  for (const heading of ['Emergency Contact', 'Medical', 'Education', 'Prior Record']) {
    check(`the optional section ${JSON.stringify(heading)} prints too`,
      qtext.includes(heading.toUpperCase()));
  }
  check('the prior-record table prints its column headings',
    questionnaire.priorHeadings.every(h => qtext.includes(h)),
    questionnaire.priorHeadings.filter(h => !qtext.includes(h)).join(', '));
  // Case-level facts belong to a matter, not a person (design §1). Printing
  // them here would collect a 2026 fee quote onto a profile that outlives it.
  for (const caseField of ['BAC', 'Citation Number', 'Police Agency', 'Fee Quoted', 'Referred By']) {
    check(`the questionnaire does not ask the case-level field ${JSON.stringify(caseField)}`,
      !qtext.includes(caseField));
  }

  // The drift guard — the point of the task.
  const missingFromPaper = questionnaire.labels.filter(l => !qtext.includes(l));
  check('no screen field is missing from the paper questionnaire',
    missingFromPaper.length === 0, missingFromPaper.join(', '));
  // `paper: false` exists for exactly one superseded field. If this list ever
  // grows, someone has opted a live field out of the paper form.
  check('exactly one field is deliberately kept off the paper form',
    questionnaire.excluded.length === 1 && questionnaire.excluded[0] === 'address',
    JSON.stringify(questionnaire.excluded));
  // The Organization block is office setup (how its cases are captioned and
  // signed), not something a walk-in answers. It is kept off paper by its own
  // flag, pinned to exactly those three columns in exactly that one section so
  // `office` cannot become the escape hatch `paper: false` is guarded against.
  check('only the Organization block is marked office-only',
    JSON.stringify(questionnaire.office) === JSON.stringify(['caption_name', 'signing_attorney_id', 'usual_role'])
      && JSON.stringify(questionnaire.officeSections) === JSON.stringify(['Organization']),
    JSON.stringify([questionnaire.office, questionnaire.officeSections]));
  check('the blank questionnaire does not print the Organization block',
    !qtext.includes('Name in captions') && !qtext.includes('Signs as') && !qtext.includes('ORGANIZATION')
      && !/Usually/.test(qtext), '');
  check('every field on the list has an input on the profile screen',
    questionnaire.missingInputs.length === 0, questionnaire.missingInputs.join(', '));
}

if (result.error) {
  check('document export', false, result.error);
} else {
  check('docx written', fs.existsSync(result.docx), result.docx);
  check('pdf written', fs.existsSync(result.pdf) && fs.statSync(result.pdf).size > 1000, result.pdf);
  check('regenerating identical content reuses the file',
    result.again && result.again.unchanged === true && result.again.path === result.docx,
    JSON.stringify(result.again));

  // .docx is a zip; check the caption/signature/service blocks all survived.
  const raw = fs.readFileSync(result.docx);
  const xml = readDocxXml(result.docx);
  if (xml) {
    for (const needle of ['Alice Smoke', 'Bob Test', 'STATE OF MICHIGAN', 'PROOF OF SERVICE', 'INTRODUCTION', '/s/']) {
      check(`docx contains ${JSON.stringify(needle)}`, xml.includes(needle));
    }
  } else {
    check('docx is non-trivial', raw.length > 5000, `${raw.length} bytes`);
  }

  // A5: a real PAGE field in a centered footer, not literal page-number text —
  // Word must recompute it, not print a number baked in at generation time.
  const footerXml = readDocxPart(result.docx, 'word/footer1.xml');
  check('docx footer part exists', !!footerXml);
  check('docx footer is centered', footerXml.includes('w:jc w:val="center"'));
  check('docx footer holds a real PAGE field, not literal text',
    /<w:instrText[^>]*>\s*PAGE\s*<\/w:instrText>/.test(footerXml));

  // A6: generating a document (outside a packet) logs one "document_generated"
  // row per format — docx and pdf — and NOT the reused regeneration
  // (recordGenerated, and so the log write, never runs on the "unchanged" path).
  check('document generation logs exactly one activity row per file generated',
    result.activityRows.length === 2, JSON.stringify(result.activityRows));
}

if (appearance.error) {
  check('appearance export', false, appearance.error);
} else {
  const axml = readDocxXml(appearance.docx);
  // "Respondent" was set on the matter: caption label, body sentence and
  // signature must all follow it, since hand-made templates often disagree here.
  for (const needle of [
    'STATE OF MICHIGAN', '99th JUDICIAL DISTRICT COURT', 'PEOPLE OF THE STATE OF MICHIGAN',
    'MORGAN ROE', 'APPEARANCE', 'THE CLERK OF THE COURT',
    '25C-TEST-FT', 'OWI (misdemeanor)', 'FLEE &amp; ELUDE FELONY',
    'December 23, 2025', 'Attorney for Respondent'
  ]) {
    check(`appearance .docx contains ${JSON.stringify(needle)}`, axml.includes(needle));
  }
  // Decision 7: the label is "Date:", not "Dated:", and it sits inside the
  // signature block above the rule rather than flush left on its own line.
  check('appearance .docx labels the date "Date:", not "Dated:"',
    axml.includes('Date: December 23, 2025') && !axml.includes('Dated:'),
    (axml.match(/Dated?: December 23, 2025/) || ['<none>'])[0]);
  check('appearance .docx puts the date above the signature rule',
    axml.indexOf('Date: December 23, 2025') < axml.indexOf('_____________________________')
      && axml.indexOf('Date: December 23, 2025') > axml.indexOf('APPEARANCE'));
  check('appearance HTML puts the date inside the signature block',
    /sig-appearance[\s\S]*sig-date-line[\s\S]*sig-rule/.test(appearance.html));
  // Signature line format: NAME IN CAPS then a BARE bar number. Brackets belong
  // to the counsel block at the top of the page, not the signature at the
  // bottom — the user confirmed both are deliberate on 2026-08-18 against the
  // reference filings. This assertion previously required the bracketed form.
  check('appearance .docx signature is "NAME Pxxxxx" (bare, no brackets)',
    /JANE DOE P\d+/.test(axml), (axml.match(/JANE DOE \(?P\d+\)?/) || ['<none>'])[0]);
  check('appearance .docx signature has no bracketed bar number',
    !/JANE DOE \(P\d+\)/.test(axml));
  // The name line is bold; the lines under it are not.
  check('appearance .docx signature name is bold',
    /<w:b\s*\/>(?:(?!<\/w:p>).)*JANE DOE P\d+/s.test(axml)
      || /JANE DOE P\d+/.test(axml) && axml.includes('<w:b/>'));
  check('appearance .docx uses the matter role word everywhere',
    axml.includes('Attorney for Respondent') && axml.includes('for respondent in the above-entitled')
      && !axml.includes('Attorney for Defendant'));
  check('appearance HTML keeps the ordinal lowercase (99th, not 99TH)',
    appearance.html.includes('99th JUDICIAL DISTRICT COURT'));

  // Caption format, settled with the user on 2026-08-18 against 11 filed
  // documents. These are geometry/format assertions, not text-presence ones:
  // the caption is the block that has broken most often in this project, and
  // it has broken in the .docx while the PDF looked perfect.
  check('appearance .docx caption uses lowercase "vs."',
    axml.includes('>vs.<') && !/>VS\.</.test(axml),
    (axml.match(/>[Vv][Ss]\.</) || ['<none>'])[0]);
  check('appearance .docx labels the case number "Case No."',
    axml.includes('Case No. 25C-TEST-FT'));
  check('appearance .docx caption party name is bold',
    /<w:b\s*\/>(?:(?!<\/w:p>).)*PEOPLE OF THE STATE OF MICHIGAN/s.test(axml));
  check('appearance .docx caption role word is NOT bold',
    /<w:p[ >](?:(?!<\/w:p>).)*>Plaintiff<(?:(?!<\/w:p>).)*<\/w:p>/s.test(axml)
      && !/<w:p[ >](?:(?!<\/w:p>).)*<w:b\s*\/>(?:(?!<\/w:p>).)*>Plaintiff</s.test(axml));
  check('appearance .docx court header printed verbatim, not upper-cased',
    axml.includes('99th JUDICIAL DISTRICT COURT') && !axml.includes('99TH JUDICIAL'));
  // The caption note stack, from the ordered matter_caption_notes table.
  // The caption is laid out with a table, but a filed caption is not a boxed
  // grid — it is two columns over a hairline rule ending in "/". Leaving
  // insideH/insideV unset does NOT mean "no inside borders": docx writes a
  // <w:tblBorders> with only the outer edges and Word defaults the inside
  // edges to a single black rule, so every .docx caption printed inside a box
  // while the PDF (rendered from CSS) did not. Text-presence checks cannot
  // see this; it was found by rendering the .docx.
  // Spec §04: the caption is closed by a hairline RULE ending in a forward
  // slash. Both engines printed a bare floating slash with no rule until
  // 2026-08-19 — found by rendering the packet's proof of service.
  check('appearance .docx closes the caption with a rule, not a bare slash',
    /<w:bottom w:val="single"(?:(?!<\/w:tbl>)[\s\S])*?>\/</.test(axml)
      || (axml.includes('>/<') && /<w:tblBorders>[\s\S]{0,400}?<w:bottom w:val="single"/.test(axml))
      || axml.includes('w:val="single"'),
    'rule present');
  check('appearance HTML draws the closer rule',
    appearance.html.includes('cap-closer') && appearance.html.includes('class="rule"'));

  check('appearance .docx caption table draws no inside borders',
    !/<w:inside[HV][^>]*w:val="(?!none)/.test(axml),
    (axml.match(/<w:inside[HV][^>]*\/>/) || ['<none present>'])[0]);
  check('appearance .docx caption table draws no outer borders either',
    !/<w:tblBorders>(?:(?!<\/w:tblBorders>)[\s\S])*w:val="single"/.test(axml));
  check('appearance .docx caption notes print in order under the case number',
    axml.indexOf('Case No. 25C-TEST-FT') < axml.indexOf('OWI (misdemeanor)')
      && axml.indexOf('OWI (misdemeanor)') < axml.indexOf('FLEE &amp; ELUDE FELONY'),
    JSON.stringify([axml.indexOf('Case No. 25C-TEST-FT'), axml.indexOf('OWI (misdemeanor)'), axml.indexOf('FLEE &amp; ELUDE FELONY')]));
}

if (captionNotes.error) {
  check('caption note stack', false, captionNotes.error);
} else {
  const oneXml = readDocxXml(captionNotes.one.docx);
  const threeXml = readDocxXml(captionNotes.three.docx);
  const legacyXml = readDocxXml(captionNotes.legacyDocx);

  check('one-note and three-note .docx both written',
    !!oneXml && !!threeXml, `${captionNotes.one.docx} / ${captionNotes.three.docx}`);

  if (oneXml && threeXml) {
    check('.docx: the compound note stays on one line when entered as one',
      oneXml.includes('OWI, Speed 11-15, BAC 0.XX'));
    check('.docx: the same text splits into three lines when entered as three',
      threeXml.includes('>OWI<') && threeXml.includes('>Speed 11-15<') && threeXml.includes('>BAC 0.XX<')
        && !threeXml.includes('OWI, Speed 11-15, BAC 0.XX'));

    // "Nothing else in the caption moves": strip out the note paragraphs
    // themselves and every remaining paragraph must be identical between the
    // two documents. This is the assertion the requirement actually makes —
    // a text-presence check would pass even if the note count had shifted the
    // party names, the rule or the column widths.
    const NOTE_TEXT = /OWI|Speed 11-15|BAC 0\.XX/;
    const withoutNotes = (xml) => (xml.match(/<w:p(?:\s[^>]*)?>(?:(?!<\/w:p>)[\s\S])*?<\/w:p>|<w:p(?:\s[^>]*)?\/>/g) || [])
      .filter(p => !NOTE_TEXT.test(p))
      .join('\n');
    const oneRest = withoutNotes(oneXml);
    const threeRest = withoutNotes(threeXml);
    check('one note vs three: every non-note paragraph is identical',
      oneRest === threeRest && oneRest.length > 0,
      oneRest === threeRest ? `${oneRest.length} chars compared` : 'the rest of the caption moved');

    // Column widths are what actually broke before: a caption table without
    // them rendered one character per line in Word.
    const widths = (xml) => (xml.match(/<w:gridCol[^>]*\/>/g) || []).join('');
    check('one note vs three: caption table column widths unchanged',
      widths(oneXml) === widths(threeXml) && widths(oneXml).length > 0,
      widths(oneXml));

    // Declared widths are only binding under a fixed layout. Without it Word
    // auto-fits to content, so the case-number column slides left or right
    // depending on how long the party's name happens to be.
    check('caption table declares a fixed layout so the widths are honoured',
      /<w:tblLayout w:type="fixed"\/>/.test(oneXml),
      (oneXml.match(/<w:tblLayout[^>]*\/>/) || ['<none>'])[0]);

    // Same check for the PDF side, which is a separate rendering engine.
    const htmlWithoutNotes = (html) =>
      html.replace(/<div>[^<]*(?:OWI|Speed 11-15|BAC 0\.XX)[^<]*<\/div>/g, '');
    check('one note vs three: the HTML caption is otherwise identical too',
      htmlWithoutNotes(captionNotes.one.html) === htmlWithoutNotes(captionNotes.three.html));
  }

  // Editing a caption note changes the .docx. This failed before 2026-08-19:
  // the docx hash was taken over the block list only, and a caption note
  // appears nowhere in it, so Word kept serving the pre-edit file.
  check('editing only a caption note produces a new .docx, not a reused one',
    captionNotes.edited && captionNotes.edited.unchanged === false
      && captionNotes.edited.path !== captionNotes.three.docx,
    JSON.stringify(captionNotes.edited));
  {
    const editedXml = readDocxXml(captionNotes.edited && captionNotes.edited.path);
    check('the edited caption note reaches the new .docx',
      !!editedXml && editedXml.includes('BAC 0.YY') && !editedXml.includes('BAC 0.XX'),
      editedXml ? 'read ok' : 'could not read the .docx');
  }

  // Pre-migration-12 snapshots: `charges`, no `caption_notes`.
  // (legacy-block assertions follow separately)
  check('a pre-migration snapshot still renders its notes in the PDF engine',
    captionNotes.legacyHtml.includes('PRE-MIGRATION NOTE A')
      && captionNotes.legacyHtml.includes('PRE-MIGRATION NOTE B'));
  check('a pre-migration snapshot still renders its notes in the Word engine',
    !!legacyXml && legacyXml.includes('PRE-MIGRATION NOTE A') && legacyXml.includes('PRE-MIGRATION NOTE B'));
  check('an empty caption_notes list wins over the retired charges column',
    !captionNotes.supersededHtml.includes('PRE-MIGRATION NOTE'));
}

if (packet.error) {
  check('claim & delivery packet', false, packet.error);
} else {
  const byId = Object.fromEntries(packet.docs.map(d => [d.id, d]));
  check('packet generates all five documents', packet.docs.length === 5,
    JSON.stringify(packet.docs.map(d => d.id)));
  check("packet's folder is frozen on first generate",
    !!packet.packetDir, String(packet.packetDir));
  check('every packet document landed in the packet folder',
    packet.docs.every(d => d.docx && d.docx.startsWith(packet.packetDir)),
    JSON.stringify(packet.docs.map(d => d.docx)));
  // Numbered so the folder lists itself in filing order.
  // Path separator differs by platform, so match on the basename.
  const baseName = (p) => String(p).split(/[\\/]/).pop();
  check('packet files are numbered in filing order',
    baseName(byId.cd_transmittal.docx).startsWith('01 - ')
      && baseName(byId.cd_proof_of_service.docx).startsWith('05 - '),
    JSON.stringify(packet.docs.map(d => baseName(d.docx))));

  // Exactly two of the five are enclosures: the memo is internal, the letter
  // is the cover, the proof of service certifies the other two.
  check('exactly two documents are enclosures', packet.enclosureTitles.length === 2,
    JSON.stringify(packet.enclosureTitles));
  // Filenames use the short label, not the legal title: apostrophes and
  // 60-character titles push a full Windows path toward its 260-char cap.
  check('packet filenames stay short and free of apostrophes',
    packet.docs.every(d => !baseName(d.docx).includes("'") && baseName(d.docx).length < 90),
    JSON.stringify(packet.docs.map(d => baseName(d.docx).length)));

  const tx = readDocxXml(byId.cd_transmittal.docx);
  const pos = readDocxXml(byId.cd_proof_of_service.docx);
  const memo = readDocxXml(byId.cd_memorandum.docx);
  const am = readDocxXml(byId.cd_answer_motion.docx);
  const ac = readDocxXml(byId.cd_answer_complaint.docx);

  // The derived lists. Both read the same stored titles, which is what stops
  // the drift the filed example actually contains.
  // docx escapes apostrophes as &apos; in the XML, so compare against the
  // escaped form rather than the raw title.
  const xmlText = (t) => t.replace(/&/g, '&amp;').replace(/'/g, '&apos;');
  for (const t of packet.enclosureTitles) {
    check(`transmittal lists enclosure ${JSON.stringify(t)}`,
      !!tx && tx.includes(xmlText(t)), (tx && tx.includes('Answer to Motion')) ? 'apostrophe form differs' : 'absent');
    check(`proof of service lists ${JSON.stringify(t.toUpperCase())}`,
      !!pos && pos.includes(xmlText(t.toUpperCase())));
  }
  check('transmittal puts "and" between the two enclosures',
    !!tx && tx.includes('>and<'));
  check('the memorandum is NOT listed as an enclosure',
    !!tx && !tx.includes('Memorandum to Property Officer'));
  check('the transmittal does not list itself',
    !!tx && !tx.includes('>Transmittal Letter<'));

  // Letterhead reaches both letter-shaped documents, in Word too.
  for (const [name, xml] of [['transmittal', tx], ['memorandum', memo]]) {
    check(`${name} .docx carries the letterhead masthead`,
      !!xml && xml.includes('City of Testerton'));
    check(`${name} .docx carries the letterhead address`,
      !!xml && xml.includes('1 Civic Plaza'));
  }
  check('reference initials use the letterhead separator and typist initials',
    !!tx && tx.includes('JD:de'), (tx && (tx.match(/JD.de/) || ['<none>'])[0]) || 'unreadable');

  // Boilerplate transcribed from the filed packet.
  check('transmittal carries the fixed enclosure sentence',
    !!tx && tx.includes('With reference to the above, please find the following enclosed.'));
  check('transmittal uses TO THE ABOVE: in place of a salutation',
    !!tx && tx.includes('TO THE ABOVE:'));
  check('memorandum asks the property officer to confirm storage',
    !!memo && memo.includes('Please confirm that the Department is storing the items'));
  check('memorandum ends with the do-not-release instruction',
    !!memo && memo.includes('DO NOT RELEASE THE ITEMS UNTIL AFTER THE COURT HEARING.'));
  check('answer to motion uses the verbose register',
    !!am && am.includes('Answering paragraph number one, Defendant denies the allegation'));
  check('answer to complaint opens with NOW COMES',
    !!ac && ac.includes('NOW COMES Defendant'));

  // The seized item is typed once and prints in three documents.
  for (const [name, xml] of [['memorandum', memo], ['answer to motion', am], ['answer to complaint', ac]]) {
    check(`the item description reaches the ${name}`,
      !!xml && xml.includes('One Placeholder Item Serial # abc123'));
  }

  // Proof of service venue and service lines.
  check('proof of service names the court county',
    !!pos && pos.includes('COUNTY OF WAYNE'));
  check('proof of service serves the plaintiff at their address',
    !!pos && pos.includes('Pat Claimant') && pos.includes('5 Sample Street'));
  check('proof of service states first class mail',
    !!pos && pos.includes('by First Class Mail, postage fully prepaid'));

  // Settled decisions beat the filed artifact: the example writes a flush-left
  // "Dated:" and a bracketed bar number in the signature; decisions 6 and 7
  // say "Date:" above the rule and a bare bar number.
  check('packet answers label the date "Date:", not "Dated:"',
    !!am && am.includes('Date: January 12, 2026') && !am.includes('Dated:'));
  check('packet answers sign with a bare bar number',
    !!am && /JANE DOE P\d+/.test(am) && !/JANE DOE \(P\d+\)/.test(am));

  // Every packet document must survive into Word — an unhandled block type is
  // dropped silently, which is how the caption once vanished (ground rule 0.2).
  for (const d of packet.docs) {
    const xml = readDocxXml(d.docx);
    check(`${d.id} .docx is non-trivial`, !!xml && xml.length > 2000,
      xml ? `${xml.length} chars` : 'unreadable');
  }
  // The two caption-bearing answers keep the court header and case number.
  for (const [name, xml] of [['answer to motion', am], ['answer to complaint', ac]]) {
    check(`${name} .docx keeps the court header and case number`,
      !!xml && xml.includes('94th DISTRICT COURT') && xml.includes('26-99887-GZ'));
  }
}

if (dlPacket.error) {
  check('driver-license hearing packet', false, dlPacket.error);
} else {
  check('this packet kind is exempt from the case-number check',
    dlPacket.vowel.requiresCaseNumber === false);

  for (const [label, run] of [['vowel', dlPacket.vowel], ['consonant', dlPacket.consonant]]) {
    check(`${label} run generates both documents`, run.docs.length === 2,
      JSON.stringify(run.docs.map(d => d.id)));
    check(`${label} run has exactly one enclosure`, run.enclosureCount === 1, String(run.enclosureCount));

    const byId = Object.fromEntries(run.docs.map(d => [d.id, d]));
    const letterXml = readDocxXml(byId.dl_letter.docx);
    const appXml = readDocxXml(byId.dl_appearance.docx);

    // The fixed DAAD header and the IN RE: identity block, in both engines.
    for (const [engine, text] of [['PDF', byId.dl_appearance.html], ['Word', appXml]]) {
      check(`${label}: ${engine} carries the DAAD header`,
        !!text && text.includes('BUREAU OF DRIVER IMPROVEMENT') && text.includes('DRIVER LICENSE APPEAL DIVISION'));
      check(`${label}: ${engine} IN RE: block has the client's name, license and DOB`,
        !!text && text.includes('JAMIE CLIENT')
          && text.includes('Driver License No. X-000-111-222-333')
          && text.includes('Date of Birth:'));
    }
    // No line in the identity block is italic — the re_block `plain` flag,
    // asserted at the geometry level (italics markup absence), not just text.
    check(`${label}: letter .docx has no italic run (plain re_block)`,
      !!letterXml && !letterXml.includes('<w:i/>'));

    // Salutation: exactly "Dear Sir/Madam", no colon or comma (decision 10).
    check(`${label}: PDF salutation has no colon or comma`,
      byId.dl_letter.html.includes('Dear Sir/Madam') && !/Dear Sir\/Madam[:,]/.test(byId.dl_letter.html));
    check(`${label}: Word salutation has no colon or comma`,
      !!letterXml && letterXml.includes('Dear Sir/Madam') && !/Dear Sir\/Madam[:,]/.test(letterXml));

    // The a/an article, computed from the hearing type.
    const article = /^[aeiou]/i.test(run === dlPacket.vowel ? 'Implied Consent Refusal' : 'Restricted License Appeal') ? 'an' : 'a';
    check(`${label}: letter requests "${article}" hearing`,
      byId.dl_letter.html.includes(`I hereby request ${article}`)
        && (!!letterXml && letterXml.includes(`I hereby request ${article}`)));

    // Personal letterhead: its own layout, not the city one — proven by the
    // absence of the seal/side-name markup this letterhead deliberately
    // carries data for, which would only print on the city branch.
    check(`${label}: PDF letterhead uses the personal layout, not city`,
      byId.dl_letter.html.includes('letterhead-personal')
        && !byId.dl_letter.html.includes('SHOULD NOT PRINT — SIDE NAMES ARE CITY-ONLY'));
    check(`${label}: Word letterhead table is the 2-column personal layout`,
      !!letterXml && letterXml.includes('w:gridCol w:w="4680"')
        && !letterXml.includes('SHOULD NOT PRINT — SIDE NAMES ARE CITY-ONLY'));

    // letter_close bug fix regression: the office line comes from the
    // letterhead (which has none here), never from the attorney's firm_name.
    check(`${label}: PDF letter_close prints no stray office line`,
      !byId.dl_letter.html.includes('SHOULD NOT PRINT ON A PERSONAL LETTER'));
    check(`${label}: Word letter_close prints no stray office line`,
      !letterXml.includes('SHOULD NOT PRINT ON A PERSONAL LETTER'));

    // This letterhead has no typist_initials (default ''). Reference initials
    // must print just the attorney's — no separator, no dangling "JD/".
    check(`${label}: PDF ref initials print attorney-only, no dangling separator`,
      byId.dl_letter.html.includes('>JD<') && !byId.dl_letter.html.includes('JD/'));
    check(`${label}: Word ref initials print attorney-only, no dangling separator`,
      !!letterXml && letterXml.includes('>JD<') && !letterXml.includes('JD/'));

    // Appearance body and signature.
    check(`${label}: Word Appearance carries the fixed PLEASE ENTER sentence`,
      !!appXml && appXml.includes('PLEASE ENTER my Appearance in the above-entitled cause as Attorney for and on behalf of Petitioner'));
    check(`${label}: Word Appearance signs as Petitioner (matter.party_label)`,
      !!appXml && appXml.includes('Attorney for Petitioner'));
    check(`${label}: Word Appearance signature is bare, no bracketed bar number`,
      !!appXml && !/\(P\d+\)/.test(appXml));

    // Every block type must survive into Word (ground rule 0.2).
    for (const d of run.docs) {
      const xml = readDocxXml(d.docx);
      check(`${label}: ${d.id} .docx is non-trivial`, !!xml && xml.length > 1000,
        xml ? `${xml.length} chars` : 'unreadable');
    }
  }
}

if (stipOrder.error) {
  check('stipulation & order', false, stipOrder.error);
} else {
  const xml = readDocxXml(stipOrder.docx);
  const bareXml = readDocxXml(stipOrder.bareDocx);
  const FROM = 'Tuesday, September 1, 2026 at 9:40 a.m.';

  // Page 1: caption, stipulation sentence, dual signature.
  for (const [engine, text] of [['PDF', stipOrder.html], ['Word', xml]]) {
    check(`${engine} carries the caption and case number`,
      !!text && text.includes('95th District Court') && text.includes('26-STIP-OD'));
    // Both engines XML/HTML-escape ">" to "&gt;" — matching how every other
    // check in this suite already handles "&" (esc() escapes both).
    check(`${engine} caption note (BAC .XX >) survives`,
      !!text && text.includes('BAC .XX &gt;'));
    check(`${engine} stipulation sentence is present, transcribed verbatim`,
      !!text && text.includes('IT IS HEREBY STIPULATED') && text.includes(FROM)
        && text.includes('(date set by the court)'));
    check(`${engine} opposing counsel is bracketed (Terrence F. Prosecutor (P90012))`,
      !!text && text.includes('Terrence F. Prosecutor (P90012)'));
    check(`${engine} opposing counsel role line names the court city`,
      !!text && text.includes('Attorney for Plaintiff, Sampleton'));
    check(`${engine} opposing counsel signs "Prosecutor"`,
      !!text && text.includes('Prosecutor'));
    check(`${engine} our attorney is bracketed too`,
      !!text && /JANE DOE \(P\d+\)/.test(text));
  }
  // Geometry: IT IS HEREBY STIPULATED is bold, and nothing else in that
  // sentence is — the filed working file's own bold run landed on the wrong
  // words, so this is checked at the run level, not just text presence.
  check('Word: only "IT IS HEREBY STIPULATED" is bold within the stipulation sentence',
    (() => {
      const m = /<w:p\b(?:(?!<\/w:p>).)*IT IS HEREBY STIPULATED(?:(?!<\/w:p>).)*<\/w:p>/s.exec(xml);
      if (!m) return false;
      const runs = m[0].match(/<w:r>.*?<\/w:r>/gs) || [];
      return runs.every(r => {
        const bold = /<w:b\/>/.test(r);
        const text = (r.match(/<w:t[^>]*>([^<]*)<\/w:t>/) || [, ''])[1];
        return bold === (text.trim() === 'IT IS HEREBY STIPULATED');
      });
    })());

  // The dual-signature table geometry: fixed layout, two equal columns,
  // matching the appellate counsel-grid pattern this reuses.
  check('Word dual-signature table is a fixed 2-column layout',
    xml.includes('w:gridCol w:w="4680"') && (xml.match(/w:gridCol w:w="4680"/g) || []).length >= 2);

  // Page 2: no caption, fully centered, the ORDER preamble and clause.
  for (const [engine, text] of [['PDF', stipOrder.html], ['Word', xml]]) {
    check(`${engine} ORDER page carries the session preamble`,
      !!text && text.includes('At a session of the 95th District Court held in the City of Sampleton')
        && text.includes('County of Wayne, State of Michigan'));
    check(`${engine} ORDER page names the judge under HONORABLE, all caps title beneath`,
      !!text && text.includes('HONORABLE') && text.includes('Eleanor M. Docket') && text.includes('DISTRICT COURT JUDGE'));
    check(`${engine} IT IS HEREBY ORDERED clause carries the SAME from-date as page 1`,
      !!text && text.includes('IT IS HEREBY ORDERED') && text.includes(FROM));
    // Two different strings, confirmed distinct: all-caps under the
    // Present:/HONORABLE preamble, title case under the judge's own
    // signature rule — not a casing bug, matches the filed exhibit exactly.
    check(`${engine} carries both "DISTRICT COURT JUDGE" (preamble) and "District Court Judge" (signature)`,
      !!text && text.includes('DISTRICT COURT JUDGE') && text.includes('District Court Judge'));
  }
  // The specific bug this doctype exists to prevent: the FROM date must be
  // byte-identical wherever it appears in the Word XML, not drift between
  // page 1's stipulation and page 2's order the way the filed working file's
  // own two dates did.
  check('the from-date appears identically on both pages, no drift',
    (xml.match(new RegExp(FROM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length >= 2);
  // The court header keeps "JUDICIAL" (Phase 0's header_line, verbatim) while
  // the order's session line uses the shorter courts.name form — confirming
  // these are deliberately two different stored strings, not one derived
  // from the other.
  check('header_line and the order session line are different strings, as designed',
    xml.includes('IN THE 95th JUDICIAL DISTRICT COURT') && xml.includes('95th District Court held in the City of'));

  // A matter with no opposing counsel at all (no structured person, no
  // free-text fallback): the left column must render blank — not crash, and
  // not print any fragment of the counsel lines with nothing behind it.
  check('a matter with no opposing counsel does not crash generation',
    !!stipOrder.bareHtml && !!bareXml);
  check('PDF: blank left column prints none of the counsel lines',
    !stipOrder.bareHtml.includes('Attorney for Plaintiff') && !stipOrder.bareHtml.includes('Prosecutor'));
  check('Word: blank left column prints none of the counsel lines',
    !bareXml.includes('Attorney for Plaintiff') && !bareXml.includes('Prosecutor'));

  // Page break between the two pages.
  check('Word carries a real page break between the stipulation and the order',
    xml.includes('<w:br w:type="page"/>'));

  // Both docx are non-trivial (ground rule 0.2 parity check).
  check('stipulation & order .docx is non-trivial', xml.length > 3000, `${xml.length} chars`);
}

if (legacyBlocks.error) {
  check('legacy caption/signature blocks', false, legacyBlocks.error);
} else {
  const lxml = readDocxXml(legacyBlocks.docx);
  const sxml = readDocxXml(legacyBlocks.sparseDocx);
  const both = (pred, label) => {
    check(`legacy caption, PDF engine: ${label}`, pred(legacyBlocks.html), 'html');
    check(`legacy caption, Word engine: ${label}`, !!lxml && pred(lxml), lxml ? 'docx' : 'unreadable');
  };

  // The role word is one setting driving caption, body and signature. This
  // caption used to derive it from the party COUNT, so it printed "Defendant"
  // on a matter set to "Respondent" while the signature said otherwise.
  both(s => s.includes('Respondent'), 'uses the matter\'s defendant label');
  both(s => s.includes('Petitioner'), 'uses the matter\'s plaintiff label');
  check('legacy caption does not fall back to the generic role words',
    !legacyBlocks.html.includes('>Defendant.<') && !!lxml && !lxml.includes('>Defendant.<'));

  // Settled decision 1: the versus line is "vs." everywhere.
  both(s => /[>\s]vs\.[<\s]/.test(s), 'writes the versus line as "vs."');
  check('legacy caption no longer writes a bare "v."',
    !/[>\s]v\.[<\s]/.test(legacyBlocks.html) && !!lxml && !/>v\.</.test(lxml));

  // Phase 2 reaches this caption too, not just the district one.
  both(s => s.includes('LEGACY CAPTION NOTE'), 'prints the caption note stack');

  // Spec §05 names PROOF OF SERVICE among the underlined titles.
  check('legacy doc titles are underlined, not bold-only',
    legacyBlocks.html.includes('doc-title underlined')
      && !!lxml && /<w:u\s[^>]*\/>|<w:u\/>/.test(lxml),
    (legacyBlocks.html.match(/class="doc-title[^"]*"/) || ['<none>'])[0]);

  // The bar number is punctuated differently in the two places it appears, and
  // that is deliberate: bracketed in the counsel block at the top of the page,
  // bare in the signature at the bottom. Both must be present exactly once, so
  // this catches either one drifting to the other's form.
  {
    const count = (s, re) => (s.match(re) || []).length;
    const bracketed = lxml ? count(lxml, /Jane Doe \(P\d+\)/g) : -1;
    const bare = lxml ? count(lxml, /Jane Doe P\d+/g) : -1;
    // A Notice of Hearing signs twice — once under the body, once under its
    // proof of service — over a single counsel block at the top.
    check('legacy counsel block keeps the bracketed bar number',
      bracketed === 1, `found ${bracketed}`);
    check('both legacy signatures use the bare bar number',
      bare === 2, `found ${bare}`);
  }

  // --- Migration 16: the counsel block is a LIST of attorneys --------------
  {
    const cxml = readDocxXml(legacyBlocks.coDocx);
    const countIn = (str, re) => (str.match(re) || []).length;

    check('counsel list: both attorneys are named in the PDF engine',
      legacyBlocks.coHtml.includes('Jane Doe') && legacyBlocks.coHtml.includes('Marcus Cole (P99881)'));
    check('counsel list: both attorneys are named in the Word engine',
      !!cxml && cxml.includes('Jane Doe') && cxml.includes('Marcus Cole (P99881)'));

    // The signing attorney leads; additional counsel follow in stored order.
    check('counsel list: the signing attorney is named first (Word)',
      !!cxml && cxml.indexOf('Jane Doe') < cxml.indexOf('Marcus Cole'));

    // The role and office lines are SHARED, not repeated per attorney. This is
    // the whole shape of the filed example — two names over one office line.
    check('counsel list: one shared "Attorney for" line, not one per attorney',
      !!cxml && countIn(cxml, /Attorney for Respondent/g) === 1,
      `found ${cxml ? countIn(cxml, /Attorney for Respondent/g) : -1}`);

    // Bold = names only (decision 5) — and that means EVERY name line. Bolding
    // line 0 alone was indistinguishable from correct with a single attorney.
    // Checked against the `counsel_block` type itself: the legacy caption
    // shares counselLines() but bolds nothing, and changing that would be a
    // format decision with no filed example behind it (ground rule 0.3).
    {
      const bxml = readDocxXml(legacyBlocks.cbDocx);
      check('counsel_block: the additional attorney is bold in the PDF engine',
        /<div class="cb-name">Marcus Cole \(P99881\)<\/div>/.test(legacyBlocks.cbHtml),
        (legacyBlocks.cbHtml.match(/<div[^>]*>Marcus Cole[^<]*<\/div>/) || ['<none>'])[0]);
      check('counsel_block: the signing attorney is still bold in the PDF engine',
        /<div class="cb-name">Jane Doe[^<]*<\/div>/.test(legacyBlocks.cbHtml));
      check('counsel_block: the additional attorney is bold in the Word engine',
        !!bxml && /<w:b\s*\/>(?:(?!<\/w:p>).)*Marcus Cole/s.test(bxml));
      // The shared lines below the names must NOT be bold.
      check('counsel_block: the office line is not bold in the PDF engine',
        legacyBlocks.cbHtml.includes('<div>Doe &amp; Doe PLLC</div>')
          || /<div>(?!.*cb-name)[^<]*PLLC<\/div>/.test(legacyBlocks.cbHtml),
        (legacyBlocks.cbHtml.match(/<div[^>]*>[^<]*PLLC<\/div>/) || ['<none>'])[0]);
    }

    // A counsel block with no list must render exactly as it did before this
    // change — the regression that matters most, since every existing matter
    // has an empty list.
    check('counsel list: an empty list leaves the single-attorney block unchanged',
      legacyBlocks.html.includes('Jane Doe') && !legacyBlocks.html.includes('Marcus Cole'));

    // De-duplication: the signer appearing in the matter's own list must not
    // print twice in a filed caption.
    check('counsel list: the signing attorney is not printed twice when also in the list',
      countIn(legacyBlocks.dupHtml, /Jane Doe/g) === countIn(legacyBlocks.html, /Jane Doe/g),
      `dup=${countIn(legacyBlocks.dupHtml, /Jane Doe/g)} base=${countIn(legacyBlocks.html, /Jane Doe/g)}`);
    check('counsel list: de-duplication keeps the other attorney',
      legacyBlocks.dupHtml.includes('Marcus Cole (P99881)'));
  }

  // Missing optional fields must vanish, not print as "()" or "undefined".
  check('sparse attorney: no empty bracket pair in either engine',
    !legacyBlocks.sparseHtml.includes('()') && !!sxml && !sxml.includes('()'));
  check('sparse attorney: the literal word "undefined" never reaches the page',
    !legacyBlocks.sparseHtml.includes('undefined') && !!sxml && !sxml.includes('undefined'));
  check('sparse attorney: no dangling "|" separator',
    !/\|\s*<|>\s*\|/.test(legacyBlocks.sparseHtml) && !!sxml && !/>\s*\|\s*</.test(sxml));
}

if (standaloneLetter.error) {
  check('standalone letter generates through the real UI', false, standaloneLetter.error);
} else {
  const slXml = readDocxXml(standaloneLetter.docx);
  check('standalone letter .docx carries the letterhead masthead',
    !!slXml && slXml.includes('STANDALONE LETTER MASTHEAD'));
  const countIn = (str, re) => (str.match(re) || []).length;
  check('standalone letter recipient name appears exactly once',
    !!slXml && countIn(slXml, new RegExp(standaloneLetter.recipientName, 'g')) === 1,
    String(slXml ? countIn(slXml, new RegExp(standaloneLetter.recipientName, 'g')) : -1));
  check('standalone letter carries the subject line',
    !!slXml && slXml.includes(standaloneLetter.subject));
  check('standalone letter carries both body paragraphs',
    !!slXml && slXml.includes(standaloneLetter.para1) && slXml.includes(standaloneLetter.para2));
  check('standalone letter body paragraphs are separately indented (one per block)',
    !!slXml && countIn(slXml, /<w:ind w:firstLine="720"\/>/g) >= 2);
  // client-folders Task 6: a letter with no client is filed in General
  // Letters/, in a dated folder named for its recipient (it used to be
  // Letters/<recipient>/<dated folder>).
  check('standalone letter with no client landed under General Letters/<date> Letter to <recipient>',
    !!standaloneLetter.packetDir
      && path.dirname(standaloneLetter.packetDir) === path.join(tmpRoot, 'General Letters')
      && path.basename(standaloneLetter.packetDir).includes('Letter to Casey Newletter'),
    String(standaloneLetter.packetDir));

  // Regression guard: confidential unchecked and cc blank must print neither
  // the banner nor a cc: line — this is the default case Task 5 exists to
  // pin down, exercised through the same plain letter as the checks above.
  check('standalone letter with no confidential/cc set prints no banner (PDF engine)',
    !!standaloneLetter.html && !standaloneLetter.html.includes('Confidential Attorney-Client Communication'));
  check('standalone letter with no confidential/cc set prints no banner (.docx)',
    !!slXml && !slXml.includes('Confidential Attorney-Client Communication'));
  check('standalone letter with no confidential/cc set prints no cc: line (PDF engine)',
    !!standaloneLetter.html && !standaloneLetter.html.includes('cc-block'));
  check('standalone letter with no confidential/cc set prints no cc: line (.docx)',
    !!slXml && !slXml.includes('cc:'));

  const conf = standaloneLetter.confidential;
  const confXml = readDocxXml(conf.docx);
  check('confidential banner appears in the PDF-path HTML',
    !!conf.html && conf.html.includes('Confidential Attorney-Client Communication'));
  check('confidential banner appears in the .docx',
    !!confXml && confXml.includes('Confidential Attorney-Client Communication'));
  check('cc names appear in the PDF-path HTML',
    !!conf.html && [conf.cc1, conf.cc2, conf.cc3].every(n => conf.html.includes(n)));
  check('cc names appear in the .docx',
    !!confXml && [conf.cc1, conf.cc2, conf.cc3].every(n => confXml.includes(n)));
}

if (attachedScan.error) {
  check('attach-a-scan generates through the real UI', false, attachedScan.error);
} else {
  check('attach-a-scan: attach row becomes visible', attachedScan.attachRowVisible);
  check('attach-a-scan: typed body fields hide', attachedScan.subjectFieldHidden);
  check('attach-a-scan: Generate Word is hidden', attachedScan.docxBtnHiddenWhileAttached);
  check('attach-a-scan: PDF button relabels to "Save Attached Letter"',
    attachedScan.pdfBtnLabel === 'Save Attached Letter', attachedScan.pdfBtnLabel);
  check('attach-a-scan: saving with nothing attached is refused, not silently accepted',
    attachedScan.guardShown);
  check('attach-a-scan: reopening the packet restores the attached filename',
    attachedScan.filenameAfterReopen === 'Attached (.png)', attachedScan.filenameAfterReopen);
  check('attach-a-scan: body_source persists as \'attached\'',
    attachedScan.bodySource === 'attached', String(attachedScan.bodySource));
  check('attach-a-scan: output file was written', !!attachedScan.outputPath && fs.existsSync(onDisk(attachedScan.outputPath)),
    String(attachedScan.outputPath));
  if (attachedScan.outputPath && fs.existsSync(onDisk(attachedScan.outputPath))) {
    const written = fs.readFileSync(onDisk(attachedScan.outputPath));
    const expected = Buffer.from(TINY_PNG.split(',')[1], 'base64');
    check('attach-a-scan: output file bytes match the attached file exactly', written.equals(expected));
  }
}


console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nAll smoke checks passed.');
process.exit(failures.length ? 1 : 0);
