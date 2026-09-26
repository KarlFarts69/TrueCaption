// Proves an existing database survives an upgrade.
//
// This is the test that protects real client data. Everything else in the app is
// a feature; a migration that drops a matter is unrecoverable.
//
// Run with Electron's node so better-sqlite3's ABI matches:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-migrations.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { migrate, TARGET_VERSION, BASE_SCHEMA, parseLegacyAddress, PATH_COLUMNS } = require('../db-migrations');

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(name);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ldg-migrate-'));
const dbPath = path.join(tmp, 'data.db');

// 1. Build a database on the ORIGINAL shipped schema, with data in it, exactly
//    as a machine that has been in use would look.
{
  const db = new Database(dbPath);
  db.exec(BASE_SCHEMA);
  db.prepare(`INSERT INTO attorneys (name, bar_number, firm_name, is_default) VALUES (?,?,?,1)`)
    .run('Existing Attorney', 'P00001', 'Existing Firm');
  const court = db.prepare('INSERT INTO courts (name) VALUES (?)').run('96th District Court').lastInsertRowid;
  const judge = db.prepare('INSERT INTO judges (name, court_id) VALUES (?,?)').run('Hon. Existing Judge', court).lastInsertRowid;
  // A second judge with no court, already archived: migration 37 must still
  // give it a contact, archived too, working nowhere.
  db.prepare('INSERT INTO judges (name, court_id, archived) VALUES (?, NULL, 1)').run('Hon. Courtless Retired');
  const matter = db.prepare(
    `INSERT INTO matters (short_name, case_number, court_id, judge_id, client_role, caption_style, created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run('Real Client Matter', '2025-CV-9999', court, judge, 'defendant', 'full', '2025-01-01').lastInsertRowid;
  db.prepare('INSERT INTO parties (matter_id, name, side, sort_order) VALUES (?,?,?,0)').run(matter, 'Real Person', 'plaintiff');
  db.prepare('INSERT INTO parties (matter_id, name, side, sort_order) VALUES (?,?,?,1)').run(matter, 'Real Person', 'defendant');
  db.prepare('INSERT INTO documents (matter_id, doc_type, field_data, created_at) VALUES (?,?,?,?)')
    .run(matter, 'motion', '{}', '2025-01-02');
  // user_version stays 0: this database predates the migration system.
  db.close();
}

// 2. Upgrade it.
const db = new Database(dbPath);
let migrated;
try {
  migrated = migrate(db);
  check('migration completes', true, `v${migrated.from} -> v${migrated.to}`);
} catch (e) {
  check('migration completes', false, e.message);
}

// 3. The original data must still be there, unchanged.
check('schema version is current', db.pragma('user_version', { simple: true }) === TARGET_VERSION);
{
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  check('m35: people has org fields',
    ['caption_name', 'signing_attorney_id', 'usual_role'].every(c => cols('people').includes(c)));
  check('m35: matters.folder_person_id exists', cols('matters').includes('folder_person_id'));
  check('m35: packets.client_person_id exists', cols('packets').includes('client_person_id'));
  check('m35: client_documents.stored_dir exists', cols('client_documents').includes('stored_dir'));
  check('m35: existing matter row survived',
    db.prepare("SELECT COUNT(*) c FROM matters WHERE short_name = 'Real Client Matter'").get().c === 1);
}

// Migration 37 (user_version 36): contacts. Judges become contact people, so
// the fixture judge created above must now have a person behind it.
{
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  check('m37: people has the contact columns',
    ['is_contact', 'contact_role', 'works_at_court_id', 'works_at_org_id'].every(c => cols('people').includes(c)),
    JSON.stringify(cols('people').filter(c => c.startsWith('is_') || c.startsWith('works_') || c.startsWith('contact_'))));
  check('m37: judges.person_id exists', cols('judges').includes('person_id'));
  check('m37: courts gains address and phone', ['address', 'phone'].every(c => cols('courts').includes(c)));
  check('m37: contact tables exist',
    ['contact_roles', 'contact_notes', 'contact_links', 'matter_contacts'].every(t => tables.includes(t)),
    JSON.stringify(tables));

  const j = db.prepare("SELECT id, court_id, person_id FROM judges WHERE name = 'Hon. Existing Judge'").get();
  check('m37: the existing judge is linked to a person', !!j && j.person_id != null, JSON.stringify(j));
  const p = j && j.person_id != null ? db.prepare('SELECT * FROM people WHERE id = ?').get(j.person_id) : null;
  check('m37: the judge\'s person is a Judge contact at the judge\'s court, same name',
    !!p && p.is_contact === 1 && p.contact_role === 'Judge' && p.works_at_court_id === j.court_id
      && p.display_name === 'Hon. Existing Judge',
    JSON.stringify(p && { is_contact: p.is_contact, role: p.contact_role, court: p.works_at_court_id, name: p.display_name }));

  const r = db.prepare("SELECT person_id FROM judges WHERE name = 'Hon. Courtless Retired'").get();
  const rp = r && r.person_id != null ? db.prepare('SELECT * FROM people WHERE id = ?').get(r.person_id) : null;
  check('m37: a courtless archived judge gets an archived Judge contact with no works_at',
    !!rp && rp.is_contact === 1 && rp.contact_role === 'Judge' && rp.archived === 1
      && rp.works_at_court_id === null && rp.works_at_org_id === null && rp.display_name === 'Hon. Courtless Retired',
    JSON.stringify(rp && { is_contact: rp.is_contact, role: rp.contact_role, archived: rp.archived,
      court: rp.works_at_court_id, org: rp.works_at_org_id }));

  const roles = db.prepare('SELECT name FROM contact_roles ORDER BY sort_order').all().map(r => r.name);
  check('m37: contact_roles seeded in order',
    roles.join(',') === 'Judge,Magistrate,Clerk,Court Officer,Probation Officer,Prosecutor,Attorney,Adjuster,Other',
    JSON.stringify(roles));

  // A note belongs to a person OR a court — never both, never neither.
  const court = db.prepare('SELECT id FROM courts LIMIT 1').get().id;
  const insNote = db.prepare(
    "INSERT INTO contact_notes (person_id, court_id, note_date, body) VALUES (?, ?, '2026-09-24', 'x')");
  const rejects = (fn) => { try { fn(); return false; } catch { return true; } };
  check('m37: a contact note needs exactly one of person or court',
    rejects(() => insNote.run(null, null)) && rejects(() => insNote.run(p ? p.id : 1, court)),
    'both-null and both-set must be refused');
}
check('matter survived', db.prepare('SELECT COUNT(*) c FROM matters').get().c === 1);
check('matter fields intact',
  db.prepare('SELECT case_number FROM matters').get().case_number === '2025-CV-9999');
check('parties survived', db.prepare('SELECT COUNT(*) c FROM parties').get().c === 2);
check('documents survived', db.prepare('SELECT COUNT(*) c FROM documents').get().c === 1);
check('judges survived', db.prepare('SELECT COUNT(*) c FROM judges').get().c === 2);
check('attorney survived', db.prepare('SELECT COUNT(*) c FROM attorneys').get().c === 1);

// 4. New structures exist and the back-fill ran.
// Contacts (migration 37) are people rows too — the fixture judge is one — so
// the party back-fill is measured on non-contact people only.
check('people back-filled from party names',
  db.prepare('SELECT COUNT(*) c FROM people WHERE is_contact = 0').get().c === 1,
  'both party rows share one name, so they should collapse to one person');
check('parties linked to people',
  db.prepare('SELECT COUNT(*) c FROM parties WHERE person_id IS NOT NULL').get().c === 2);
check('matter_cases back-filled from the single case number',
  db.prepare("SELECT case_number FROM matter_cases WHERE matter_id = (SELECT id FROM matters)").get()?.case_number === '2025-CV-9999');
// Two generic types only. City types carry municipality-specific wording, so
// seeding them would print a placeholder into a filed document.
check('matter types seeded', db.prepare('SELECT COUNT(*) c FROM matter_types').get().c === 2,
  JSON.stringify(db.prepare('SELECT name FROM matter_types').all().map(r => r.name)));

// Migration 10: every existing court gets a header line seeded from its name,
// so upgrading an installed database never blanks the court header.
{
  const courts = db.prepare('SELECT name, header_line FROM courts').all();
  check('courts have a seeded header_line',
    courts.length === 0 || courts.every(c => c.header_line && c.header_line.startsWith('IN THE')),
    JSON.stringify(courts));
  const seeded = courts.find(c => c.name);
  check('header_line preserves the court name exactly (no upper-casing)',
    !seeded || seeded.header_line === `IN THE ${seeded.name}`,
    seeded ? `${seeded.header_line} vs IN THE ${seeded.name}` : 'no courts');
}

// Migration 11: documents gains matter_snapshot / attorney_snapshot /
// filed_at. No back-fill is possible for pre-existing rows (nothing captured
// the matter's state at the time), so they must survive with NULL there —
// not be dropped or errored on.
{
  const cols = db.prepare('PRAGMA table_info(documents)').all().map(c => c.name);
  check('documents has matter_snapshot, attorney_snapshot, filed_at',
    ['matter_snapshot', 'attorney_snapshot', 'filed_at'].every(c => cols.includes(c)),
    JSON.stringify(cols));
  const preExisting = db.prepare("SELECT * FROM documents WHERE doc_type = 'motion'").get();
  check('pre-migration document survived with NULL snapshot columns',
    !!preExisting && preExisting.matter_snapshot == null && preExisting.filed_at == null,
    JSON.stringify(preExisting));
}

// Migration 12: matters.charges (a single TEXT blob split on "\n" at render
// time) becomes an ordered matter_caption_notes table.
//
// The back-fill can only be exercised on a database that HAS charges, and the
// base schema predates that column — so this rewinds a fully migrated database
// to v11, puts charges on the matter, and lets migration 12 run for real.
{
  const cols = db.prepare('PRAGMA table_info(matter_caption_notes)').all().map(c => c.name);
  check('matter_caption_notes exists with note_text and sort_order',
    ['matter_id', 'note_text', 'sort_order'].every(c => cols.includes(c)), JSON.stringify(cols));

  const matterId = db.prepare('SELECT id FROM matters').get().id;
  db.prepare('DELETE FROM matter_caption_notes').run();
  // Blank and whitespace-only lines are exactly what the old textarea let
  // through, and each one used to become an invisible empty caption row.
  db.prepare('UPDATE matters SET charges = ? WHERE id = ?')
    .run('OWI (misdemeanor)\n\n  FLEE & ELUDE FELONY  \n   \nBAC .XX >', matterId);
  db.pragma('user_version = 11');
  migrate(db);

  const notes = db.prepare(
    'SELECT note_text, sort_order FROM matter_caption_notes WHERE matter_id = ? ORDER BY sort_order'
  ).all(matterId);
  check('charges back-filled as ordered note rows, blanks dropped',
    notes.length === 3
      && notes[0].note_text === 'OWI (misdemeanor)'
      && notes[1].note_text === 'FLEE & ELUDE FELONY'
      && notes[2].note_text === 'BAC .XX >',
    JSON.stringify(notes));
  check('note sort_order is 0,1,2 — the order they were typed in',
    notes.map(n => n.sort_order).join(',') === '0,1,2',
    JSON.stringify(notes.map(n => n.sort_order)));
  check('the retired charges column is kept, not dropped',
    db.prepare('PRAGMA table_info(matters)').all().some(c => c.name === 'charges'),
    'it is the recovery copy of what the back-fill rewrote');

  // Re-running must not double the caption. Rewind again with the notes now
  // in place: the matter already has rows, so the back-fill must skip it.
  db.pragma('user_version = 11');
  migrate(db);
  check('back-fill skips a matter that already has notes',
    db.prepare('SELECT COUNT(*) c FROM matter_caption_notes WHERE matter_id = ?').get(matterId).c === 3,
    String(db.prepare('SELECT COUNT(*) c FROM matter_caption_notes').get().c));
}

// Migration 13: packets, packet_documents and letterheads (Phase 3).
{
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  check('packets / packet_documents / letterheads exist',
    ['packets', 'packet_documents', 'letterheads'].every(t => tables.includes(t)),
    JSON.stringify(tables));

  const docCols = db.prepare('PRAGMA table_info(documents)').all().map(c => c.name);
  check('documents gains packet_id and sort_order',
    docCols.includes('packet_id') && docCols.includes('sort_order'), JSON.stringify(docCols));

  // The pre-existing document must survive with a NULL packet_id — an ordinary
  // one-off filing is not part of a packet and never becomes one.
  const preExisting = db.prepare("SELECT * FROM documents WHERE doc_type = 'motion'").get();
  check('a pre-packet document survives with no packet',
    !!preExisting && preExisting.packet_id == null, JSON.stringify(preExisting && preExisting.packet_id));

  // The letterhead's reference separator defaults to the city form; it is
  // deliberately per-letterhead, not global (decision 9).
  const lh = db.prepare("INSERT INTO letterheads (label) VALUES ('Test LH')").run().lastInsertRowid;
  check('letterhead reference separator defaults to ":"',
    db.prepare('SELECT ref_separator FROM letterheads WHERE id = ?').get(lh).ref_separator === ':');

  // A packet's folder is frozen like a matter's, so it starts NULL and is
  // filled in on first generate rather than recomputed.
  const matterId = db.prepare('SELECT id FROM matters').get().id;
  const pk = db.prepare(
    "INSERT INTO packets (matter_id, kind, packet_date) VALUES (?, 'claim_and_delivery', '2026-01-12')"
  ).run(matterId).lastInsertRowid;
  check('a new packet has no frozen output_dir yet',
    db.prepare('SELECT output_dir FROM packets WHERE id = ?').get(pk).output_dir == null);
  check('packet_documents defaults its role to enclosure',
    db.prepare("INSERT INTO packet_documents (packet_id, doc_type, title) VALUES (?, 'x', 'X')").run(pk)
      && db.prepare('SELECT role FROM packet_documents WHERE packet_id = ?').get(pk).role === 'enclosure');
}

// Migration 14: the driver-license hearing request packet. hearing_type,
// client_dob and client_license_number on packets; kind on letterheads.
{
  const pkCols = db.prepare('PRAGMA table_info(packets)').all().map(c => c.name);
  check('packets gains hearing_type, client_dob, client_license_number',
    ['hearing_type', 'client_dob', 'client_license_number'].every(c => pkCols.includes(c)),
    JSON.stringify(pkCols));

  // The letterhead created under migration 13's test predates `kind` — it
  // must upgrade to the city default, not NULL, since renderLetterhead()
  // branches on it and a blank kind must fall through to today's behavior.
  const lhCols = db.prepare('PRAGMA table_info(letterheads)').all().map(c => c.name);
  check('letterheads gains kind', lhCols.includes('kind'), JSON.stringify(lhCols));
  const existingLh = db.prepare("SELECT kind FROM letterheads WHERE label = 'Test LH'").get();
  check('a pre-existing letterhead defaults kind to "city"',
    !!existingLh && existingLh.kind === 'city', JSON.stringify(existingLh));
}

// Migration 15: Phase 4, the stipulation & order. courts.city.
{
  const courtCols = db.prepare('PRAGMA table_info(courts)').all().map(c => c.name);
  check('courts gains city', courtCols.includes('city'), JSON.stringify(courtCols));
}

// Migration 16: a counsel block holds a LIST of attorneys. Matter-scoped, so
// it rides into matter_snapshot with the rest of the matter for free.
{
  const maCols = db.prepare('PRAGMA table_info(matter_attorneys)').all().map(c => c.name);
  check('matter_attorneys exists, matter-scoped and ordered',
    maCols.join(',') === 'id,matter_id,attorney_id,sort_order', JSON.stringify(maCols));
  check('a matter migrated from an earlier version has no additional counsel',
    db.prepare('SELECT COUNT(*) n FROM matter_attorneys').get().n === 0);
}

// Migration 17: the client profile's own fields, plus the people.dob
// normalization. dob was free text whose "YYYY-MM-DD" was only a placeholder,
// and it is about to be prefilled into an ISO date field that documents print,
// so an un-normalized value would put "Invalid Date" into a filing.
{
  const peopleCols = db.prepare('PRAGMA table_info(people)').all().map(c => c.name);
  check('people gains occupation and license_number',
    peopleCols.includes('occupation') && peopleCols.includes('license_number'),
    JSON.stringify(peopleCols));

  // Rewind to v16 with the messy values a free-text box actually produced.
  const cases = [
    ['Iso Already', '1980-03-14', '1980-03-14', 'an ISO value is left alone'],
    ['Us Slashes', '3/14/1980', '1980-03-14', 'US M/D/YYYY is converted'],
    ['Padded Slashes', '03/04/1980', '1980-03-04', 'zero-padded M/D/YYYY is converted'],
    ['Two Digit Year', '3/4/80', '3/4/80', 'a two-digit year is AMBIGUOUS and must be left alone'],
    ['Impossible Date', '2/30/1980', '2/30/1980', 'an impossible date must not roll over to March 1'],
    ['Prose', 'sometime in 1980', 'sometime in 1980', 'unparseable prose is left alone'],
  ];
  const insP = db.prepare('INSERT INTO people (display_name, kind, dob, created_at) VALUES (?,?,?,?)');
  const ids = cases.map(([name, raw]) => insP.run(name, 'individual', raw, '2025-01-01').lastInsertRowid);

  db.pragma('user_version = 16');
  migrate(db);

  cases.forEach(([name, raw, want, why], i) => {
    const got = db.prepare('SELECT dob FROM people WHERE id = ?').get(ids[i]).dob;
    check(`dob normalization: ${why}`, got === want, `${JSON.stringify(raw)} -> ${JSON.stringify(got)}`);
  });

  // Every converted value must be something the document renderer can print.
  // This is the whole point of the migration, so assert it directly rather
  // than trusting the string comparison above.
  const iso = db.prepare('SELECT dob FROM people WHERE display_name = ?').get('Us Slashes').dob;
  const rendered = new Date(iso + 'T12:00:00Z');
  check('a converted dob renders as a real date, not "Invalid Date"',
    !Number.isNaN(rendered.getTime()) && rendered.getUTCFullYear() === 1980
      && rendered.getUTCMonth() === 2 && rendered.getUTCDate() === 14,
    String(rendered));

  // These six fixtures exist only to exercise the normalization. Remove them
  // so the duplicate-row counts further down still measure what they were
  // written to measure.
  const del = db.prepare('DELETE FROM people WHERE id = ?');
  ids.forEach(id => del.run(id));
}

// Migration 18: the intake wizard's Step 1 "Engagement status" field.
{
  const mCols = db.prepare('PRAGMA table_info(matters)').all().map(c => c.name);
  check('matters gains engagement_status', mCols.includes('engagement_status'), JSON.stringify(mCols));
}

// Migration 19: the temporary case-number flag.
{
  const mCols = db.prepare('PRAGMA table_info(matters)').all().map(c => c.name);
  check('matters gains case_number_pending', mCols.includes('case_number_pending'), JSON.stringify(mCols));
  const row = db.prepare('SELECT case_number_pending FROM matters LIMIT 1').get();
  if (row) check('case_number_pending defaults to 0 on an existing row', row.case_number_pending === 0, String(row.case_number_pending));
}

// Migration 20: standalone Letters' recipient_person_id.
{
  const pCols = db.prepare('PRAGMA table_info(packets)').all().map(c => c.name);
  check('packets gains recipient_person_id', pCols.includes('recipient_person_id'), JSON.stringify(pCols));
}

// Migration 21: standalone Letters' subject/letter_body fields.
{
  const pCols = db.prepare('PRAGMA table_info(packets)').all().map(c => c.name);
  check('packets gains subject and letter_body', pCols.includes('subject') && pCols.includes('letter_body'), JSON.stringify(pCols));
}

// Migration 22: City Attorney letter fields (confidential/cc_list) and the
// attach-a-scan columns (body_source/attached_scan_data).
{
  const pCols = db.prepare('PRAGMA table_info(packets)').all().map(c => c.name);
  check('packets gains confidential, cc_list, body_source, attached_scan_data',
    ['confidential', 'cc_list', 'body_source', 'attached_scan_data'].every(c => pCols.includes(c)),
    JSON.stringify(pCols));
  const row = db.prepare('SELECT confidential, body_source FROM packets LIMIT 1').get();
  if (row) {
    check('confidential defaults to 0 on an existing row', row.confidential === 0, String(row.confidential));
    check("body_source defaults to 'typed' on an existing row", row.body_source === 'typed', String(row.body_source));
  }
}

// Migration 23: typist initials belong to the letterhead, same as
// ref_separator (decision 9). Default '' — an empty typist half must print
// the attorney initials with no separator and no dangling "JAD:".
{
  const lhCols = db.prepare('PRAGMA table_info(letterheads)').all().map(c => c.name);
  check('letterheads gains typist_initials', lhCols.includes('typist_initials'), JSON.stringify(lhCols));

  // The letterhead created under migration 13's test predates this column.
  const existingLh = db.prepare("SELECT typist_initials FROM letterheads WHERE label = 'Test LH'").get();
  check('a pre-existing letterhead survives and defaults typist_initials to ""',
    !!existingLh && existingLh.typist_initials === '', JSON.stringify(existingLh));
}

// Migration 24: the client intake questionnaire's person-level fields.
{
  const cols = db.prepare('PRAGMA table_info(people)').all().map(c => c.name);
  const expected = [
    'intake_date', 'street', 'city', 'zip', 'cell_phone', 'home_phone',
    'marital_status', 'citizenship', 'employer',
    'emergency_contact_name', 'emergency_contact_relationship', 'emergency_contact_phone',
    'medical_issues', 'medications', 'medical_marijuana_card',
    'education_college', 'education_high_school', 'education_highest_grade',
    'cdl_license', 'cdl_number', 'chauffeur_license', 'chauffeur_number',
    'cpl_license', 'cpl_number'
  ];
  check('people gains the intake columns',
    expected.every(c => cols.includes(c)),
    expected.filter(c => !cols.includes(c)).join(', ') || 'all present');

  // The person back-filled from migration 2 predates every one of these.
  const p = db.prepare('SELECT * FROM people LIMIT 1').get();
  // display_name alone is not enough — it predates migration 24 and passes even
  // when the migration never ran at all. Assert the NEW columns exist and are
  // null on the pre-existing row: that is what proves the migration reached the
  // end rather than dying partway through.
  check('an existing person survives migration 24 with the new columns present',
    !!p && !!p.display_name && 'intake_date' in p && p.intake_date === null
      && 'street' in p && p.street === null,
    JSON.stringify({ name: p && p.display_name, intake_date: p && p.intake_date, street: p && p.street }));
  check('licence flags default to 0, not null on an existing person',
    p.cdl_license === 0 && p.chauffeur_license === 0 && p.cpl_license === 0,
    `${p.cdl_license}/${p.chauffeur_license}/${p.cpl_license}`);
}

// Migration 25: prior offenses are a list, and they belong to the person —
// a prior record follows a client between cases.
{
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  check('person_priors table exists', tables.includes('person_priors'), JSON.stringify(tables));

  const cols = db.prepare('PRAGMA table_info(person_priors)').all().map(c => c.name);
  check('person_priors has the expected shape',
    ['person_id', 'offense', 'jurisdiction', 'offense_date', 'location', 'disposition', 'sort_order']
      .every(c => cols.includes(c)), JSON.stringify(cols));

  // It must actually accept a row and read back in sort order.
  const pid = db.prepare('SELECT id FROM people LIMIT 1').get().id;
  const ins = db.prepare(`INSERT INTO person_priors
    (person_id, offense, jurisdiction, offense_date, location, disposition, sort_order)
    VALUES (?,?,?,?,?,?,?)`);
  ins.run(pid, 'OWI 1st', '90th District', '2019-04-02', 'Exampleton, MI', 'Plea', 1);
  ins.run(pid, 'Reckless Driving', '98-1 District', '2016-08-11', 'Testerton, MI', 'Dismissed', 0);
  const got = db.prepare('SELECT offense FROM person_priors WHERE person_id = ? ORDER BY sort_order').all(pid);
  check('person_priors round-trips in sort order',
    got.length === 2 && got[0].offense === 'Reckless Driving', JSON.stringify(got));
}

// Migration 26: the client intake questionnaire, case half. These change per
// incident, so they sit on the matter, not the person.
{
  const cols = db.prepare('PRAGMA table_info(matters)').all().map(c => c.name);
  const expected = ['stage', 'bac', 'police_agency', 'citation_number',
                    'date_of_offense', 'referred_by', 'fee_quoted'];
  check('matters gains the case-intake columns',
    expected.every(c => cols.includes(c)),
    expected.filter(c => !cols.includes(c)).join(', ') || 'all present');

  check('the pre-existing matter survives migration 26',
    db.prepare('SELECT case_number FROM matters').get().case_number === '2025-CV-9999');

  // engagement_status (migration 18) answers a DIFFERENT question — whether the
  // attorney took the case. stage must not have displaced it.
  check('engagement_status still exists alongside stage', cols.includes('engagement_status'));

  // No current_charge column: the charge lives in matter_caption_notes.
  check('no duplicate current_charge column was added', !cols.includes('current_charge'));
}

// Migration 27: scanned/attached client paperwork. Files are copied into a
// per-client folder; the DB records the filename, never an absolute path,
// so the set survives being carried to another machine on a USB stick.
{
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  check('client_documents table exists', tables.includes('client_documents'), JSON.stringify(tables));

  const cols = db.prepare('PRAGMA table_info(client_documents)').all().map(c => c.name);
  check('client_documents has the expected shape',
    ['person_id', 'matter_id', 'filename', 'original_name', 'label', 'doc_date', 'added_at']
      .every(c => cols.includes(c)), JSON.stringify(cols));

  const pCols = db.prepare('PRAGMA table_info(people)').all().map(c => c.name);
  check('people gains client_docs_dir', pCols.includes('client_docs_dir'));

  // matter_id is nullable: a scan can belong to the client generally.
  const pid = db.prepare('SELECT id FROM people LIMIT 1').get().id;
  db.prepare(`INSERT INTO client_documents
    (person_id, matter_id, filename, original_name, label, doc_date, added_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(pid, null, 'police-report.pdf', 'Scan_0001.pdf', 'Police report', '2026-03-01', '2026-03-02');
  const d = db.prepare('SELECT * FROM client_documents WHERE person_id = ?').get(pid);
  check('client_documents accepts a row with no matter_id',
    !!d && d.matter_id === null && d.label === 'Police report', JSON.stringify(d));
}

// Migration 28: court dates. On the MATTER, so a client with three cases has
// three streams of dates and the profile can roll up the soonest.
{
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  check('matter_events table exists', tables.includes('matter_events'), JSON.stringify(tables));

  const cols = db.prepare('PRAGMA table_info(matter_events)').all().map(c => c.name);
  check('matter_events has the expected shape',
    ['matter_id', 'event_type', 'event_date', 'event_time', 'location', 'notes', 'done']
      .every(c => cols.includes(c)), JSON.stringify(cols));

  const mid = db.prepare('SELECT id FROM matters LIMIT 1').get().id;
  const ins = db.prepare(`INSERT INTO matter_events
    (matter_id, event_type, event_date, event_time, location, notes, done)
    VALUES (?,?,?,?,?,?,?)`);
  ins.run(mid, 'Pretrial', '2026-09-04', '09:00', '90th District Court', '', 0);
  ins.run(mid, 'Arraignment', '2026-07-01', '13:30', '90th District Court', '', 1);

  // The roll-up query the profile will use: soonest not-yet-done date.
  const next = db.prepare(
    `SELECT event_type, event_date FROM matter_events
     WHERE matter_id = ? AND done = 0 ORDER BY event_date LIMIT 1`).get(mid);
  check('next-date roll-up skips events marked done',
    !!next && next.event_type === 'Pretrial', JSON.stringify(next));
  check('done defaults to 0',
    db.prepare('SELECT done FROM matter_events WHERE event_type = ?').get('Pretrial').done === 0);
}

// 4b. The legacy-address parser, tested directly.
//
// It cannot be tested through the migration: this file asserts COUNT(people) = 1
// below, so inserting address fixtures would break that check. The parser is
// exported for exactly this reason.
//
// The rule under test is "parse the unambiguous, skip everything else". The
// apartment case is the one that regressed once already — a non-greedy .+?
// backtracks past the first comma and files "Apt 4, Exampleton, MI" as the city.
{
  const cases = [
    ['123 Main St\nExampleton, MI 48000',            { street: '123 Main St', city: 'Exampleton, MI', zip: '48000' }],
    ['123 Main St\nExampleton, MI 48000-1234',       { street: '123 Main St', city: 'Exampleton, MI', zip: '48000-1234' }],
    ['PO Box 12\nExampleton, MI 48000',              { street: 'PO Box 12', city: 'Exampleton, MI', zip: '48000' }],
    ['123 Main St\nApt 4, Exampleton, MI 48000',     null],
    ['123 Main St\nSuite 200, Exampleton, MI 48000', null],
    ['123 Main St\nExampleton MI 48000',             null],
    ['123 Main St\nApt 4\nExampleton, MI 48000',     null],
    ['123 Main St, Exampleton, MI 48000',            null],
    ['',                                         null],
    [null,                                       null]
  ];
  const wrong = [];
  for (const [input, want] of cases) {
    const got = parseLegacyAddress(input);
    const ok = want === null
      ? got === null
      : !!got && got.street === want.street && got.city === want.city && got.zip === want.zip;
    if (!ok) wrong.push(`${JSON.stringify(input)} -> ${JSON.stringify(got)}`);
  }
  check('parseLegacyAddress parses the unambiguous and skips the rest',
    wrong.length === 0, wrong.join(' | '));

  // Stated separately because this is the specific regression, not a table row.
  check('an apartment on the city line is skipped, never filed as the city',
    parseLegacyAddress('123 Main St\nApt 4, Exampleton, MI 48000') === null,
    JSON.stringify(parseLegacyAddress('123 Main St\nApt 4, Exampleton, MI 48000')));
}

// Migration 36 (user_version 35): path columns become relative to the output
// root. Rewind to just before it, plant absolute values, run it, and read them
// back. Run twice — once with a Mac root, once with a Windows root (a Windows
// database migrated on any machine must still compare as Windows).
{
  const M36 = 35; // user_version this migration produces
  const hadRoot = db.prepare("SELECT value FROM settings WHERE key = 'output_root'").get();
  const setRoot = (v) => db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('output_root', ?)").run(v);
  const matterId = db.prepare('SELECT id FROM matters').get().id;

  // One row per path column, all holding `value`. Returns a reader.
  function plant(value) {
    const ids = {};
    ids.person = db.prepare(
      "INSERT INTO people (display_name, kind, client_docs_dir, created_at) VALUES ('M36 Person','individual',?, '2026-01-01')")
      .run(value).lastInsertRowid;
    ids.matter = db.prepare(
      "INSERT INTO matters (short_name, output_dir, created_at) VALUES ('M36 Case', ?, '2026-01-01')").run(value).lastInsertRowid;
    ids.packet = db.prepare(
      "INSERT INTO packets (matter_id, kind, output_dir, created_at) VALUES (?, 'standalone_letter', ?, '2026-01-01')")
      .run(matterId, value).lastInsertRowid;
    ids.upload = db.prepare(
      "INSERT INTO client_documents (person_id, filename, added_at, stored_dir) VALUES (?, 'a.pdf', '2026-01-01', ?)")
      .run(ids.person, value).lastInsertRowid;
    ids.gen = db.prepare(
      "INSERT INTO generated_files (matter_id, doc_type, format, content_hash, path, created_at) VALUES (?, 'm36', 'pdf', 'h', ?, '2026-01-01')")
      .run(matterId, value).lastInsertRowid;
    ids.doc = db.prepare(
      "INSERT INTO documents (matter_id, doc_type, field_data, pdf_path, docx_path, created_at) VALUES (?, 'm36', '{}', ?, ?, '2026-01-01')")
      .run(matterId, value, value).lastInsertRowid;
    const read = () => [
      db.prepare('SELECT client_docs_dir v FROM people WHERE id = ?').get(ids.person).v,
      db.prepare('SELECT output_dir v FROM matters WHERE id = ?').get(ids.matter).v,
      db.prepare('SELECT output_dir v FROM packets WHERE id = ?').get(ids.packet).v,
      db.prepare('SELECT stored_dir v FROM client_documents WHERE id = ?').get(ids.upload).v,
      db.prepare('SELECT path v FROM generated_files WHERE id = ?').get(ids.gen).v,
      db.prepare('SELECT pdf_path v FROM documents WHERE id = ?').get(ids.doc).v,
      db.prepare('SELECT docx_path v FROM documents WHERE id = ?').get(ids.doc).v,
    ];
    const remove = () => {
      db.prepare('DELETE FROM documents WHERE id = ?').run(ids.doc);
      db.prepare('DELETE FROM generated_files WHERE id = ?').run(ids.gen);
      db.prepare('DELETE FROM client_documents WHERE id = ?').run(ids.upload);
      db.prepare('DELETE FROM packets WHERE id = ?').run(ids.packet);
      db.prepare('DELETE FROM matters WHERE id = ?').run(ids.matter);
      db.prepare('DELETE FROM people WHERE id = ?').run(ids.person);
    };
    return { read, remove };
  }
  const rerun = () => { db.pragma(`user_version = ${M36 - 1}`); migrate(db); };

  check('m36: the fixture covers every listed path column', PATH_COLUMNS.length === 7,
    JSON.stringify(PATH_COLUMNS));

  const cases = [
    // [label, root, planted value, expected after]
    ['mac: inside the root becomes relative with "/"', '/Users/alice/Documents/Legal Documents',
      '/Users/alice/Documents/Legal Documents/Clients/Alice Anderson/Speeding (2026-TR-0142)',
      'Clients/Alice Anderson/Speeding (2026-TR-0142)'],
    ['mac: outside the root stays absolute', '/Users/alice/Documents/Legal Documents',
      '/Volumes/Other/Clients/Alice Anderson', '/Volumes/Other/Clients/Alice Anderson'],
    ['mac: a sibling folder sharing the prefix stays absolute', '/Users/alice/Documents/Legal Documents',
      '/Users/alice/Documents/Legal Documents Old/Clients/Bob', '/Users/alice/Documents/Legal Documents Old/Clients/Bob'],
    ['windows: inside the root (any case) becomes relative with "/"', 'C:\\Users\\Alice\\Documents\\Legal Documents',
      'c:\\users\\alice\\documents\\legal documents\\Clients\\Acme Holdings LLC\\Letters',
      'Clients/Acme Holdings LLC/Letters'],
    ['windows: another drive stays absolute', 'C:\\Users\\Alice\\Documents\\Legal Documents',
      'D:\\Legal Documents\\Clients\\Acme Holdings LLC', 'D:\\Legal Documents\\Clients\\Acme Holdings LLC'],
    ['mac root: a Windows value is left alone', '/Users/alice/Documents/Legal Documents',
      'C:\\Users\\Alice\\Documents\\Legal Documents\\Clients\\Bob', 'C:\\Users\\Alice\\Documents\\Legal Documents\\Clients\\Bob'],
    ['an already-relative value is left alone', '/Users/alice/Documents/Legal Documents',
      'Clients/Alice Anderson/Letters', 'Clients/Alice Anderson/Letters'],
  ];
  for (const [label, root, value, want] of cases) {
    setRoot(root);
    const fx = plant(value);
    rerun();
    const first = fx.read();
    check(`m36: ${label}`, first.every(v => v === want), JSON.stringify([...new Set(first)]));
    rerun();
    const second = fx.read();
    check(`m36: ${label} — re-running changes nothing`,
      second.every((v, i) => v === first[i]), JSON.stringify([...new Set(second)]));
    fx.remove();
  }

  // NULL and empty stay as they are.
  setRoot('/Users/alice/Documents/Legal Documents');
  const nul = db.prepare(
    "INSERT INTO matters (short_name, output_dir, created_at) VALUES ('M36 Null', NULL, '2026-01-01')").run().lastInsertRowid;
  rerun();
  check('m36: a NULL folder stays NULL',
    db.prepare('SELECT output_dir v FROM matters WHERE id = ?').get(nul).v === null);
  db.prepare('DELETE FROM matters WHERE id = ?').run(nul);

  if (hadRoot) setRoot(hadRoot.value);
  else db.prepare("DELETE FROM settings WHERE key = 'output_root'").run();
  check('m36: back at the current schema version',
    db.pragma('user_version', { simple: true }) === TARGET_VERSION);
}

// Migration 37 (user_version 36): opposing counsel becomes a contact, but a
// person who is a CLIENT on any case stays a client — the People tab lists only
// non-contacts, so flagging a client would hide them from their own list.
{
  const M37 = 36; // user_version this migration produces
  const now = '2026-09-24';
  const oscar = db.prepare(
    "INSERT INTO people (display_name, kind, created_at) VALUES ('Oscar Opposing', 'individual', ?)").run(now).lastInsertRowid;
  const both = db.prepare(
    "INSERT INTO people (display_name, kind, created_at) VALUES ('Carla Clientcounsel', 'individual', ?)").run(now).lastInsertRowid;
  const m1 = db.prepare(
    "INSERT INTO matters (short_name, opposing_counsel_person_id, created_at) VALUES ('M37 Case A', ?, ?)").run(oscar, now).lastInsertRowid;
  const m2 = db.prepare(
    "INSERT INTO matters (short_name, opposing_counsel_person_id, created_at) VALUES ('M37 Case B', ?, ?)").run(both, now).lastInsertRowid;
  const party = db.prepare(
    "INSERT INTO parties (matter_id, name, side, person_id, role, sort_order) VALUES (?, 'Carla Clientcounsel', 'defendant', ?, 'client', 0)")
    .run(m1, both).lastInsertRowid;

  const rerun = () => { db.pragma(`user_version = ${M37 - 1}`); migrate(db); };
  rerun();
  const o = db.prepare('SELECT is_contact, contact_role FROM people WHERE id = ?').get(oscar);
  check('m37: opposing counsel is flagged as an Attorney contact',
    o.is_contact === 1 && o.contact_role === 'Attorney', JSON.stringify(o));
  check('m37: a client who is also opposing counsel somewhere stays a client',
    db.prepare('SELECT is_contact FROM people WHERE id = ?').get(both).is_contact === 0);

  rerun();
  check('m37: re-running creates no duplicate judge contacts',
    db.prepare("SELECT COUNT(*) c FROM people WHERE contact_role = 'Judge'").get().c === 2,
    String(db.prepare("SELECT COUNT(*) c FROM people WHERE contact_role = 'Judge'").get().c));
  check('m37: re-running does not re-seed contact_roles',
    db.prepare('SELECT COUNT(*) c FROM contact_roles').get().c === 9);

  db.prepare('DELETE FROM parties WHERE id = ?').run(party);
  db.prepare('DELETE FROM matters WHERE id IN (?, ?)').run(m1, m2);
  db.prepare('DELETE FROM people WHERE id IN (?, ?)').run(oscar, both);
  check('m37: back at the current schema version',
    db.pragma('user_version', { simple: true }) === TARGET_VERSION);
}

// 5. Migrating again is a no-op, not a duplicate-everything event.
const second = migrate(db);
check('re-running migrations does nothing', second.ran === 0);
check('no duplicate people after second run',
  db.prepare('SELECT COUNT(*) c FROM people WHERE is_contact = 0').get().c === 1);
check('no duplicate contacts after second run',
  db.prepare('SELECT COUNT(*) c FROM people WHERE is_contact = 1').get().c === 2,
  'just the two fixture judges');
check('no duplicate cases after second run', db.prepare('SELECT COUNT(*) c FROM matter_cases').get().c === 1);
check('no duplicate matter types', db.prepare('SELECT COUNT(*) c FROM matter_types').get().c === 2);

db.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(', ')}` : '\nAll migration checks passed.');
process.exit(failures.length ? 1 : 0);
