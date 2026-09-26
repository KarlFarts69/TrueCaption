// Schema versioning for the app database.
//
// The original initDb() only ran CREATE TABLE IF NOT EXISTS, which cannot add a
// column to a table that already exists. Shipping an update to a machine that
// already holds real matters would silently skip the change. These ordered
// migrations fix that: each runs once, inside a transaction, tracked by SQLite's
// own user_version pragma.
//
// Rules for adding a migration:
//   - Append to the end. Never edit or reorder an existing entry; installs in
//     the wild have already run them.
//   - Make it idempotent where cheap (IF NOT EXISTS, column checks).
//   - Never DROP or DELETE user data. Retirement is `archived = 1`.

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS courts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, county TEXT, type TEXT, archived INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS judges (id INTEGER PRIMARY KEY, name TEXT NOT NULL, court_id INTEGER REFERENCES courts(id), archived INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS attorneys (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, bar_number TEXT, firm_name TEXT,
    firm_address TEXT, firm_phone TEXT, firm_email TEXT, is_default INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS matters (
    id INTEGER PRIMARY KEY, short_name TEXT NOT NULL, case_number TEXT,
    court_id INTEGER REFERENCES courts(id), judge_id INTEGER REFERENCES judges(id),
    client_role TEXT, caption_style TEXT DEFAULT 'full', opposing_counsel TEXT, notes TEXT,
    archived INTEGER DEFAULT 0, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS parties (
    id INTEGER PRIMARY KEY, matter_id INTEGER REFERENCES matters(id),
    name TEXT NOT NULL, side TEXT NOT NULL, sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY, matter_id INTEGER REFERENCES matters(id), doc_type TEXT NOT NULL,
    field_data TEXT NOT NULL, body_text TEXT, pdf_path TEXT, docx_path TEXT,
    created_at TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

function addColumn(db, table, column, decl) {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

// Splits a legacy two-line address blob ("123 Main St\nExampleton, MI 48000") into
// street/city/zip, or returns null when the shape is anything but unambiguous.
//
// Exported so the parse rules can be tested directly against many address
// shapes. They cannot be tested through the migration itself: the migration
// test asserts COUNT(people) = 1, so a fixture row would break it.
//
// The city segment is [^,]+ rather than a non-greedy .+? on purpose. A .+?
// backtracks past the first comma, so "Apt 4, Exampleton, MI 48000" would match
// with city = "Apt 4, Exampleton, MI" — filing an apartment number under City.
// That is exactly the ambiguous shape this is supposed to skip, and it would
// surface as an editable "City" box holding an apartment number, one careless
// human edit away from losing it. A comma on line two now means "leave it
// alone", consistent with what the back-fill promises.
function parseLegacyAddress(text) {
  const lines = String(text == null ? '' : text).split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length !== 2) return null;
  const m = /^([^,]+),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(lines[1]);
  if (!m) return null;
  return { street: lines[0], city: `${m[1].trim()}, ${m[2]}`, zip: m[3] };
}

const MIGRATIONS = [
  // 1 — the schema the app originally shipped with.
  (db) => {
    db.exec(BASE_SCHEMA);
  },

  // 2 — people as reusable records, linked to matters through parties.
  //     parties.name is retained as a snapshot so renaming a person later does
  //     not rewrite what an already-generated document said.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        id INTEGER PRIMARY KEY,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'individual',
        firm_name TEXT, address TEXT, phone TEXT, email TEXT, dob TEXT,
        notes TEXT,
        archived INTEGER DEFAULT 0,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_people_name ON people(display_name);
    `);
    addColumn(db, 'parties', 'person_id', 'INTEGER REFERENCES people(id)');
    addColumn(db, 'parties', 'role', "TEXT DEFAULT 'opposing_party'");
    db.exec('CREATE INDEX IF NOT EXISTS idx_parties_person ON parties(person_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_parties_matter ON parties(matter_id)');

    // Back-fill: every distinct party name already on file becomes a person,
    // and existing party rows link to it. Nothing is deleted.
    // Single quotes: SQLite treats "" as an identifier, not a string literal.
    const existing = db.prepare("SELECT DISTINCT name FROM parties WHERE name IS NOT NULL AND TRIM(name) <> ''").all();
    const findPerson = db.prepare('SELECT id FROM people WHERE display_name = ?');
    const insPerson = db.prepare('INSERT INTO people (display_name, kind, created_at) VALUES (?, ?, ?)');
    const linkParty = db.prepare('UPDATE parties SET person_id = ? WHERE name = ? AND person_id IS NULL');
    for (const row of existing) {
      const found = findPerson.get(row.name);
      const id = found ? found.id : insPerson.run(row.name, 'individual', new Date().toISOString()).lastInsertRowid;
      linkParty.run(id, row.name);
    }

    // Matter-level case description. Charges belong to the case, not the person.
    addColumn(db, 'matters', 'case_description', 'TEXT');
  },

  // 3 — matter types, and support for matters that carry more than one case
  //     number/judge (appellate posture: the appeal plus the case below).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS matter_types (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        side TEXT NOT NULL DEFAULT 'defense',
        caption_authority TEXT,
        attorney_id INTEGER REFERENCES attorneys(id),
        default_court_id INTEGER REFERENCES courts(id),
        opposing_side_default TEXT,
        folder_name TEXT,
        doc_type_ids TEXT,
        sort_order INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS matter_cases (
        id INTEGER PRIMARY KEY,
        matter_id INTEGER REFERENCES matters(id),
        label TEXT,
        case_number TEXT,
        court_id INTEGER REFERENCES courts(id),
        judge_id INTEGER REFERENCES judges(id),
        sort_order INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_matter_cases_matter ON matter_cases(matter_id);
    `);

    addColumn(db, 'matters', 'matter_type_id', 'INTEGER REFERENCES matter_types(id)');

    // Every existing matter's single case number becomes its first case row.
    // matters.case_number / court_id / judge_id are left in place so older code
    // paths keep working; matter_cases is the authoritative list going forward.
    const matters = db.prepare('SELECT id, case_number, court_id, judge_id FROM matters').all();
    const insCase = db.prepare(
      'INSERT INTO matter_cases (matter_id, label, case_number, court_id, judge_id, sort_order) VALUES (?,?,?,?,?,0)'
    );
    const already = db.prepare('SELECT COUNT(*) c FROM matter_cases WHERE matter_id = ?');
    for (const m of matters) {
      if (already.get(m.id).c === 0) {
        insCase.run(m.id, null, m.case_number || null, m.court_id || null, m.judge_id || null);
      }
    }

    // Generic starter types only. Deliberately no real names, addresses, bar
    // numbers or letterhead here — that is personal data and would live in git
    // history forever. It gets entered in the app and moved between machines
    // with Back Up Now / Restore.
    const typeCount = db.prepare('SELECT COUNT(*) c FROM matter_types').get().c;
    if (typeCount === 0) {
      const ins = db.prepare(
        `INSERT INTO matter_types (name, side, caption_authority, opposing_side_default, folder_name, sort_order)
         VALUES (?,?,?,?,?,?)`
      );
      // Only types whose wording is universally correct. City types are added
      // by hand in Settings, because their authority line and folder name are
      // specific to the municipality and a placeholder would otherwise print
      // straight into a filed document.
      ins.run('Criminal Defense', 'defense', 'PEOPLE OF THE STATE OF MICHIGAN', 'prosecution', 'Criminal Defense', 1);
      ins.run('Civil Litigation', 'plaintiff', null, 'defendant', 'Civil', 2);
    }

    // Tracks what was generated, so regenerating identical content can reuse the
    // existing file rather than making a near-duplicate. The hash is of the
    // SOURCE (html / block JSON), not the output bytes: PDFs embed a creation
    // timestamp, so output bytes differ on every run even for identical input.
    db.exec(`
      CREATE TABLE IF NOT EXISTS generated_files (
        id INTEGER PRIMARY KEY,
        matter_id INTEGER REFERENCES matters(id),
        doc_type TEXT,
        format TEXT,
        content_hash TEXT,
        path TEXT,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_generated_lookup
        ON generated_files(matter_id, doc_type, format);
    `);
  },

  // 4 — caption fields taken from reference filings.
  (db) => {
    // "Defendant" vs "Respondent". One setting drives the caption label, the
    // body sentence and the signature block, so they cannot disagree — hand-made
    // templates often contradict each other on exactly this.
    addColumn(db, 'matters', 'party_label', "TEXT DEFAULT 'Defendant'");
    // Per-matter override of the matter type's authority line, for the odd case
    // that does not match the type default.
    addColumn(db, 'matters', 'caption_authority', 'TEXT');
    // Charges / offenses, printed in the caption's right column beneath the
    // case number ("OWI (misdemeanor)", "FLEE & ELUDE FELONY").
    addColumn(db, 'matters', 'charges', 'TEXT');
    db.prepare("UPDATE matters SET party_label = 'Defendant' WHERE party_label IS NULL").run();
  },

  // 5 — appellate work. On appeal both sides carry compound roles
  //     ("Plaintiff – Appellee" / "Defendant – Appellant") and both counsel
  //     blocks print side by side in the caption, so opposing counsel becomes a
  //     structured person rather than a free-text blob.
  (db) => {
    addColumn(db, 'matters', 'plaintiff_label', "TEXT DEFAULT 'Plaintiff'");
    addColumn(db, 'matters', 'opposing_counsel_person_id', 'INTEGER REFERENCES people(id)');
    addColumn(db, 'matters', 'oral_argument', 'INTEGER DEFAULT 0');
    addColumn(db, 'matter_cases', 'judge_name', 'TEXT');
    // Opposing counsel print with a bar number in the caption block.
    addColumn(db, 'people', 'bar_number', 'TEXT');
    db.prepare("UPDATE matters SET plaintiff_label = 'Plaintiff' WHERE plaintiff_label IS NULL").run();
  },

  // 6 — scanned signature image. Word-built appearances often embed one directly above
  //     the signature rule (INCLUDEPICTURE in the .doc), so the generated
  //     documents need somewhere to put it.
  //
  //     Stored as a data: URI on the attorney record rather than a file path:
  //     a path would break the moment the image is moved or the database is
  //     restored onto another machine, which is exactly how this app is
  //     delivered.
  (db) => {
    addColumn(db, 'attorneys', 'signature_image', 'TEXT');
  },

  // 7 — an attorney row is really "one signing identity": the same person can
  //     sign as Exampleton City Attorney, as Sampleton City Attorney, or from
  //     private practice. Name, bar number and signature stay the same; only the
  //     office block changes. `label` is what the lists and pickers show, so
  //     three rows do not all read as the same name.
  (db) => {
    addColumn(db, 'attorneys', 'label', 'TEXT');
    // Seed a sensible label from whatever distinguishes the row today.
    db.prepare(
      `UPDATE attorneys
       SET label = COALESCE(NULLIF(TRIM(firm_name), ''), NULLIF(TRIM(name), ''), 'Signing Profile')
       WHERE label IS NULL OR TRIM(label) = ''`
    ).run();
  },

  // 8 — the seeded "Municipality A/B" matter types were placeholders that read
  //     as real config: they produced folders called "City A" and captions
  //     reading "PEOPLE OF THE CITY OF [CITY]" in finished documents. Remove
  //     them, but only while they are untouched and unused, so an edited or
  //     in-use row is never destroyed.
  (db) => {
    const placeholders = db.prepare(
      `SELECT id FROM matter_types
       WHERE name IN ('City Attorney — Municipality A', 'City Attorney — Municipality B')
         AND caption_authority = 'PEOPLE OF THE CITY OF [CITY]'`
    ).all();
    const inUse = db.prepare('SELECT COUNT(*) c FROM matters WHERE matter_type_id = ?');
    const del = db.prepare('DELETE FROM matter_types WHERE id = ?');
    for (const row of placeholders) {
      if (inUse.get(row.id).c === 0) del.run(row.id);
    }
  },

  // 9 — a matter's document folder was recomputed from short_name, case_number
  //     and the matter type's folder_name on every single generate call, so
  //     editing any of those made the *next* document land in a brand-new
  //     folder while everything already generated stayed behind in the old
  //     one. The folder is now decided once and stored on the matter, so it
  //     stops moving around underneath the user.
  (db) => {
    addColumn(db, 'matters', 'output_dir', 'TEXT');

    // Existing matters: freeze onto wherever their most recent generated file
    // already sits, so upgrading does not itself relocate anything already on
    // disk. Matters with nothing generated yet stay NULL and get a folder
    // assigned (and frozen) the first time something is generated for them.
    const nodePath = require('path');
    const lastFile = db.prepare(
      `SELECT matter_id, path FROM generated_files
       WHERE id IN (SELECT MAX(id) FROM generated_files GROUP BY matter_id)`
    ).all();
    const setDir = db.prepare('UPDATE matters SET output_dir = ? WHERE id = ?');
    for (const row of lastFile) {
      if (row.path) setDir.run(nodePath.dirname(row.path), row.matter_id);
    }
  },

  // 10 — the court header line, stored verbatim.
  //
  //     Decided with the user 2026-08-18 after reading 11 filed documents: a
  //     "judicial district court", a "circuit court" and a state agency are
  //     different institutions that each name themselves their own way, not
  //     three spellings of one thing. So there is no rule to compute. Each
  //     court carries the exact line it wants printed under STATE OF MICHIGAN
  //     and the renderers emit it unchanged — which also means an unfamiliar
  //     court can never be mangled.
  //
  //     Seeded from the existing name so nothing regresses: a court stored as
  //     "96th District Court" becomes "IN THE 96th District Court", which is
  //     what the old `IN THE ${name}` interpolation already produced.
  (db) => {
    addColumn(db, 'courts', 'header_line', 'TEXT');
    const courts = db.prepare('SELECT id, name FROM courts').all();
    const setHeader = db.prepare('UPDATE courts SET header_line = ? WHERE id = ?');
    for (const c of courts) {
      if (c.name) setHeader.run(`IN THE ${c.name}`, c.id);
    }
  },

  // 11 — documents becomes a self-contained record of what was generated,
  //      not just the per-doctype form fields.
  //
  //      Before this, `documents` rows only stored `field_data` (the values
  //      typed into the doc-type's own fields, e.g. "dated"). The caption,
  //      signature and body are actually built from the matter and attorney
  //      at generation time (gatherRenderData() in renderer.js), and none of
  //      that was ever captured. Reopening an old document's field values and
  //      clicking Generate again silently re-read the matter's CURRENT state
  //      — so editing the matter after filing something could change what a
  //      "regenerate" produces. matter_snapshot / attorney_snapshot fix that:
  //      once a document exists, its own content is frozen to what was
  //      actually resolved at the time, independent of later matter edits.
  //
  //      filed_at is separate from created_at because "generated" and
  //      "filed" are different facts — a document can be generated and
  //      revised several times before it is actually filed.
  //
  //      No back-fill: existing documents rows get NULL in all three columns,
  //      which is correct — nothing read them before, so nothing regresses.
  (db) => {
    addColumn(db, 'documents', 'matter_snapshot', 'TEXT');
    addColumn(db, 'documents', 'attorney_snapshot', 'TEXT');
    addColumn(db, 'documents', 'filed_at', 'TEXT');
  },

  // 12 — the caption's right-hand column is a STACK, not fixed fields.
  //
  //      Read off 11 filed documents: the number of lines under the case
  //      number varies from one to four, and the user already files charge
  //      information in that slot ("BAC .XX >", "Overweight"). So charges are
  //      not a separate concept needing their own home in the template — they
  //      are note lines appended to the identifier stack, which is exactly
  //      what the design sketch showed with its Note 1 / Note 2 / Note 3
  //      slots.
  //
  //      matters.charges was a single TEXT blob split on "\n" at render time.
  //      That renders correctly but is not a list: it cannot be reordered, a
  //      stray blank line becomes an invisible empty caption row, and nothing
  //      else can feed it (a charge picker is meant to, later). An ordered
  //      table replaces it.
  //
  //      matters.charges is DELIBERATELY NOT DROPPED. It is the pre-migration
  //      copy of the data this back-fill rewrites, kept so a bad back-fill is
  //      recoverable. It is RETIRED: nothing may read it except the legacy
  //      fallback in the renderers, which exists only for documents whose
  //      matter_snapshot was captured before this migration and therefore
  //      carries `charges` with no `caption_notes`.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS matter_caption_notes (
        id INTEGER PRIMARY KEY,
        matter_id INTEGER REFERENCES matters(id),
        note_text TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_caption_notes_matter
        ON matter_caption_notes(matter_id);
    `);

    // Back-fill, preserving the order the lines were typed in. Idempotent: a
    // matter that already has note rows is left alone, so re-running never
    // doubles anyone's caption.
    if (hasColumn(db, 'matters', 'charges')) {
      const matters = db.prepare(
        "SELECT id, charges FROM matters WHERE charges IS NOT NULL AND TRIM(charges) <> ''"
      ).all();
      const already = db.prepare('SELECT COUNT(*) c FROM matter_caption_notes WHERE matter_id = ?');
      const ins = db.prepare(
        'INSERT INTO matter_caption_notes (matter_id, note_text, sort_order) VALUES (?,?,?)'
      );
      for (const m of matters) {
        if (already.get(m.id).c > 0) continue;
        const lines = String(m.charges).split('\n').map(s => s.trim()).filter(Boolean);
        lines.forEach((text, i) => ins.run(m.id, text, i));
      }
    }
  },

  // 13 — packets (Phase 3), and the letterhead profile they need.
  //
  //      A packet is a FILING: several documents sent together on one date,
  //      in one envelope, into one folder. Read off two filed claim & delivery
  //      packets six weeks apart — they are the same five documents in the
  //      same order with the same sentences, and only the plaintiff, case
  //      number, date and seized item differ.
  //
  //      The load-bearing column is packet_documents.role. In the filed
  //      example the packet is five documents but only TWO are enclosures:
  //      the transmittal letter addresses the court and the plaintiff, the
  //      memorandum goes internally to the property officer and is never
  //      filed, and the proof of service certifies the two answers. Because
  //      each document knows its own role, the transmittal's enclosure list
  //      and the proof of service's document list are DERIVED — including the
  //      "and" between two items — instead of being typed and drifting apart.
  //
  //      letterheads is the "city profile" from the plan's §4, pulled forward
  //      from Phase 6 because the transmittal letter and the memorandum
  //      cannot render without one. Only the fields those two documents
  //      actually consume are added; the rest waits for Phase 6, so this does
  //      not become a table of columns nothing reads.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS letterheads (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL,
        masthead TEXT,
        office_lines TEXT,
        address TEXT,
        phone TEXT,
        fax TEXT,
        seal_image TEXT,
        side_names TEXT,
        ref_separator TEXT NOT NULL DEFAULT ':',
        archived INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS packets (
        id INTEGER PRIMARY KEY,
        matter_id INTEGER REFERENCES matters(id),
        kind TEXT NOT NULL,
        label TEXT,
        packet_date TEXT,
        letterhead_id INTEGER REFERENCES letterheads(id),
        item_description TEXT,
        recipient_name TEXT,
        recipient_address TEXT,
        court_recipient_name TEXT,
        court_recipient_address TEXT,
        memo_to TEXT,
        output_dir TEXT,
        created_at TEXT,
        filed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_packets_matter ON packets(matter_id);

      CREATE TABLE IF NOT EXISTS packet_documents (
        id INTEGER PRIMARY KEY,
        packet_id INTEGER REFERENCES packets(id),
        doc_type TEXT NOT NULL,
        title TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'enclosure',
        sort_order INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_packet_documents_packet
        ON packet_documents(packet_id);
    `);

    // Generated documents can now belong to a packet. Nullable: a one-off
    // Appearance is still a document with no packet, and every existing row
    // stays exactly as it is.
    addColumn(db, 'documents', 'packet_id', 'INTEGER REFERENCES packets(id)');
    addColumn(db, 'documents', 'sort_order', 'INTEGER DEFAULT 0');
  },

  // 14 — the driver-license hearing request packet. hearing_type/client_dob/
  //      client_license_number are packet-scoped, not on `people`: every
  //      other packet-specific fact (item_description, recipient_name) is
  //      already a flat column on `packets`, filled in fresh per filing
  //      through the generic packet-field UI, not threaded through
  //      people/parties. `letterheads.kind` distinguishes the city letterhead
  //      (masthead centered, seal, side names — what claim & delivery already
  //      uses) from a personal letterhead (name at left, no seal, no side
  //      names), which are structurally different layouts, not variants of
  //      one shape. Ships with the UI that reads/writes each column.
  (db) => {
    addColumn(db, 'packets', 'hearing_type', 'TEXT');
    addColumn(db, 'packets', 'client_dob', 'TEXT');
    addColumn(db, 'packets', 'client_license_number', 'TEXT');
    addColumn(db, 'letterheads', 'kind', "TEXT NOT NULL DEFAULT 'city'");
  },

  // 15 — Phase 4, the stipulation & order. The ORDER page needs "held in the
  //      City of [X]"; `courts.county` already existed (base schema) for
  //      "County of [Y]" but had NO UI anywhere to set it — a live ground-rule
  //      violation predating this phase, so it prints "COUNTY OF ____________"
  //      on every proof of service until fixed. Both ship with the UI that
  //      sets them, in the same change (renderer.js's court-management row).
  (db) => {
    addColumn(db, 'courts', 'city', 'TEXT');
  },

  // 16 — a counsel block holds a LIST of attorneys, not one (build plan §4).
  //      A filed answer stacks two attorneys of the same office above the
  //      office line; the app could only ever print the one selected at
  //      generation time.
  //
  //      Counsel of record is a property of the CASE, not of each filing —
  //      the same attorneys appear on every paper in the matter — so this is
  //      matter-scoped, alongside parties/matter_cases/matter_caption_notes,
  //      and NOT a per-document field. That also means it rides into
  //      matter_snapshot for free (renderer.js folds it into `m` exactly as
  //      it already does caption_notes), so an already-generated document
  //      keeps the counsel list it was filed with.
  //
  //      The signing attorney stays per-document and is NOT stored here: this
  //      table is the ADDITIONAL counsel printed beneath them.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS matter_attorneys (
        id INTEGER PRIMARY KEY,
        matter_id INTEGER NOT NULL REFERENCES matters(id),
        attorney_id INTEGER NOT NULL REFERENCES attorneys(id),
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_matter_attorneys_matter
        ON matter_attorneys(matter_id, sort_order);
    `);
  },

  // 17 — the client profile's own fields (app-shell design §3).
  //
  //      license_number here DELIBERATELY REVERSES build-plan §12, which kept
  //      it packet-scoped. That was overruled on 2026-08-20 for a reason
  //      §12 did not weigh: intake. A license number that can only be entered
  //      from inside a filing defeats the point of a client screen.
  //
  //      §12's actual guarantee is untouched — the person is only the MASTER
  //      copy. The packet still keeps and freezes its own value, so an
  //      already-generated document never changes. Do not "fix" this back.
  (db) => {
    addColumn(db, 'people', 'occupation', 'TEXT');
    addColumn(db, 'people', 'license_number', 'TEXT');

    // people.dob has always been a free-text box whose "YYYY-MM-DD" was only a
    // placeholder, and nothing ever read it. It is about to be prefilled into
    // packets.client_dob, which IS an ISO date field rendered as
    // `new Date(dob + 'T12:00:00Z')` — so an un-normalized value would put the
    // literal "Invalid Date" into a filed document.
    //
    // Converted here: ISO (left as-is) and US M/D/YYYY, the convention for a
    // Michigan practice, validated to be a real calendar date.
    // Left ALONE deliberately: anything with a two-digit year. "3/4/80" cannot
    // be resolved without guessing, and a wrong date of birth in a filing is
    // worse than a blank one. The validation resolver reports these instead.
    const rows = db.prepare("SELECT id, dob FROM people WHERE dob IS NOT NULL AND TRIM(dob) <> ''").all();
    const upd = db.prepare('UPDATE people SET dob = ? WHERE id = ?');
    for (const r of rows) {
      const raw = String(r.dob).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) continue;
      const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) continue;
      const [, mm, dd, yyyy] = m;
      const iso = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      // Rejects 2/30/1980 rather than letting Date roll it over to March 1.
      const d = new Date(iso + 'T12:00:00Z');
      if (Number.isNaN(d.getTime()) || d.getUTCMonth() + 1 !== Number(mm) || d.getUTCDate() !== Number(dd)) continue;
      upd.run(iso, r.id);
    }
  },

  // 18 — the intake wizard's Step 1 "Engagement status" (build plan §5,
  //      design notes §5). Display-only: no
  //      rendered document reads this column, so no RENDER_VERSION bump.
  (db) => {
    addColumn(db, 'matters', 'engagement_status', 'TEXT');
  },

  // 19 — the temporary case-number flag. Suppresses matters.case_number from every
  //      printed caption (falls back to the existing blank underscore line)
  //      until the attorney clears it. Default 0 so no existing matter's output
  //      changes. Rendered-output change: RENDER_VERSION bumps in the
  //      commit that gates the caption code, not here.
  (db) => {
    addColumn(db, 'matters', 'case_number_pending', 'INTEGER DEFAULT 0');
  },

  // 20 — standalone Letters. Pure findability link back to People — recipient_name/
  //      recipient_address (existing columns) are still the frozen snapshot
  //      that actually prints; this column is never read by a renderer.
  (db) => {
    addColumn(db, 'packets', 'recipient_person_id', 'INTEGER REFERENCES people(id)');
  },

  // 21 — standalone Letters' own packet fields (subject, body). savePacket()
  //      persists every packet kind's fields through one hardcoded UPDATE, so
  //      unlike every other packet-specific column these two need columns of
  //      their own before that UPDATE can save them at all — without this,
  //      the standalone_letter form would silently drop what was typed.
  (db) => {
    addColumn(db, 'packets', 'subject', 'TEXT');
    addColumn(db, 'packets', 'letter_body', 'TEXT');
  },

  // 22 — City Attorney letter fields, plus the attach-a-scan alternative to typing a
  //      body. confidential/cc_list only mean anything for kind =
  //      'standalone_letter'; body_source/attached_scan_data likewise —
  //      every other packet kind leaves all four null forever.
  (db) => {
    addColumn(db, 'packets', 'confidential', 'INTEGER DEFAULT 0');
    addColumn(db, 'packets', 'cc_list', 'TEXT');
    addColumn(db, 'packets', 'body_source', "TEXT DEFAULT 'typed'");
    addColumn(db, 'packets', 'attached_scan_data', 'TEXT');
  },

  // 23 — typist initials belong to the letterhead, same as ref_separator
  //      (decision 9): the second half of "JAD:mk" varies per letterhead, not
  //      globally. Default '' — an empty typist half prints just the
  //      attorney initials with no separator, not a dangling "JAD:".
  (db) => {
    addColumn(db, 'letterheads', 'typist_initials', "TEXT NOT NULL DEFAULT ''");
  },

  // 24 — the client intake questionnaire, person half. These are the facts
  //      that follow a client between cases: identity, contact, licences,
  //      employment, education, medical, emergency contact. The case half
  //      (charge, BAC, citation number, fee) lands on `matters` in migration 26,
  //      because those change per incident and must not be overwritten when a
  //      client comes back on a new charge.
  //
  //      street/city/zip supersede the single `address` textarea. `address` is
  //      NOT dropped: it stays as the fallback for rows this back-fill cannot
  //      parse, and its one consumer (renderer.js, the standalone-letter
  //      recipient snapshot) is switched to the composed value in the same
  //      commit as the UI change.
  //
  //      Display-only: no renderer reads these columns, so no RENDER_VERSION bump.
  (db) => {
    addColumn(db, 'people', 'intake_date', 'TEXT');
    addColumn(db, 'people', 'street', 'TEXT');
    addColumn(db, 'people', 'city', 'TEXT');
    addColumn(db, 'people', 'zip', 'TEXT');
    addColumn(db, 'people', 'cell_phone', 'TEXT');
    addColumn(db, 'people', 'home_phone', 'TEXT');
    addColumn(db, 'people', 'marital_status', 'TEXT');
    addColumn(db, 'people', 'citizenship', 'TEXT');
    addColumn(db, 'people', 'employer', 'TEXT');
    addColumn(db, 'people', 'emergency_contact_name', 'TEXT');
    addColumn(db, 'people', 'emergency_contact_relationship', 'TEXT');
    addColumn(db, 'people', 'emergency_contact_phone', 'TEXT');
    addColumn(db, 'people', 'medical_issues', 'TEXT');
    addColumn(db, 'people', 'medications', 'TEXT');
    addColumn(db, 'people', 'medical_marijuana_card', 'INTEGER DEFAULT 0');
    addColumn(db, 'people', 'education_college', 'TEXT');
    addColumn(db, 'people', 'education_high_school', 'TEXT');
    addColumn(db, 'people', 'education_highest_grade', 'TEXT');
    addColumn(db, 'people', 'cdl_license', 'INTEGER DEFAULT 0');
    addColumn(db, 'people', 'cdl_number', 'TEXT');
    addColumn(db, 'people', 'chauffeur_license', 'INTEGER DEFAULT 0');
    addColumn(db, 'people', 'chauffeur_number', 'TEXT');
    addColumn(db, 'people', 'cpl_license', 'INTEGER DEFAULT 0');
    addColumn(db, 'people', 'cpl_number', 'TEXT');

    // Existing rows get 0, not NULL, for the flags — a checkbox bound to NULL
    // renders indeterminate and saves back as "unanswered" forever.
    db.exec(`UPDATE people SET
       cdl_license = COALESCE(cdl_license, 0),
       chauffeur_license = COALESCE(chauffeur_license, 0),
       cpl_license = COALESCE(cpl_license, 0),
       medical_marijuana_card = COALESCE(medical_marijuana_card, 0)`);

    // Back-fill street/city/zip from the old address blob where it is
    // unambiguous. Anything else is left for a human — a half-parsed address on
    // a filing is worse than an unparsed one. See parseLegacyAddress.
    const rows = db.prepare("SELECT id, address FROM people WHERE address IS NOT NULL AND TRIM(address) <> ''").all();
    const upd = db.prepare('UPDATE people SET street = ?, city = ?, zip = ? WHERE id = ?');
    for (const r of rows) {
      const parsed = parseLegacyAddress(r.address);
      if (!parsed) continue;
      upd.run(parsed.street, parsed.city, parsed.zip, r.id);
    }
  },

  // 25 — prior offenses. A list, not a field: a client can have five, and each
  //      carries its own jurisdiction/date/location. Attached to the PERSON
  //      rather than the matter because a prior record follows the client —
  //      re-keying it on every new case is the duplication this whole design
  //      exists to remove.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS person_priors (
        id INTEGER PRIMARY KEY,
        person_id INTEGER REFERENCES people(id),
        offense TEXT,
        jurisdiction TEXT,
        offense_date TEXT,
        location TEXT,
        disposition TEXT,
        sort_order INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_person_priors_person ON person_priors(person_id);
    `);
  },

  // 26 — the client intake questionnaire, case half. Deliberately NOT on
  //      `people`: a client who returns in two years on a new charge must not
  //      carry 2026's "fee quoted" on their profile as though it were still true.
  //
  //      `stage` is where the case stands (Not yet charged / Cited, no court
  //      date / Arraignment pending / Pretrial / Post-conviction or PV / Appeal /
  //      Licence restoration). It is NOT engagement_status (migration 18), which
  //      answers whether the firm took the case at all. Both are kept.
  //
  //      There is deliberately no `current_charge` column: charges live in
  //      matter_caption_notes (migration 20) and print in the caption.
  //
  //      Display-only: no renderer reads these, so no RENDER_VERSION bump.
  (db) => {
    addColumn(db, 'matters', 'stage', 'TEXT');
    addColumn(db, 'matters', 'bac', 'TEXT');            // TEXT: ".08", "refused", "n/a"
    addColumn(db, 'matters', 'police_agency', 'TEXT');
    addColumn(db, 'matters', 'citation_number', 'TEXT');
    addColumn(db, 'matters', 'date_of_offense', 'TEXT'); // ISO yyyy-mm-dd
    addColumn(db, 'matters', 'referred_by', 'TEXT');
    addColumn(db, 'matters', 'fee_quoted', 'TEXT');      // TEXT: "$2,500 flat", "TBD"
  },

  // 27 — scanned and attached client paperwork.
  //
  //      Files are COPIED into <output_root>/Clients/<Client Name>/ rather than
  //      linked. Linking would break the moment the scanner's output folder is
  //      tidied, and would point at paths that do not exist on the machine the
  //      USB stick is plugged into. The DB stores `filename` only, relative to
  //      client_docs_dir, for the same reason.
  //
  //      client_docs_dir is FROZEN on first attachment, exactly like
  //      matters.output_dir (main.js getMatterDir). Recomputing it after the
  //      client is renamed would send the next scan to a new folder while every
  //      earlier one stayed behind, invisible.
  //
  //      matter_id is nullable: a retainer agreement belongs to the client,
  //      a police report belongs to one case.
  (db) => {
    addColumn(db, 'people', 'client_docs_dir', 'TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS client_documents (
        id INTEGER PRIMARY KEY,
        person_id INTEGER REFERENCES people(id),
        matter_id INTEGER REFERENCES matters(id),
        filename TEXT NOT NULL,
        original_name TEXT,
        label TEXT,
        doc_date TEXT,
        added_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_client_docs_person ON client_documents(person_id);
      CREATE INDEX IF NOT EXISTS idx_client_docs_matter ON client_documents(matter_id);
    `);
  },

  // 28 — court dates.
  //
  //      A calendar and activity log were deliberately cut in the app-shell
  //      phase. This is intentionally much less: record and roll up. There is
  //      no calendar view, no firm-wide docket, no notifications, and no
  //      computed deadlines — a wrongly computed appeal window is worse than
  //      no appeal window at all.
  //
  //      Dates hang off the matter, not the person, so a client with three
  //      cases has three streams and the profile shows the soonest across all.
  //      On the person they would lose which case each date belongs to.
  //
  //      `done` defaults to 0 and the roll-up reads only `done = 0` rows, so a
  //      hearing that has already happened stops being "next" without being
  //      deleted.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS matter_events (
        id INTEGER PRIMARY KEY,
        matter_id INTEGER REFERENCES matters(id),
        event_type TEXT,
        event_date TEXT,
        event_time TEXT,
        location TEXT,
        notes TEXT,
        done INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_matter_events_matter ON matter_events(matter_id);
      CREATE INDEX IF NOT EXISTS idx_matter_events_date ON matter_events(event_date);
    `);
  },

  // 30 — main.js no longer seeds a fake "Jane Doe" attorney into a fresh
  //      database. Existing databases already have her; delete her, but ONLY
  //      if she still has every exact seeded value AND nothing has ever used
  //      her — a human who edited her fields or generated a document off her
  //      is not touched, even though the name still matches.
  (db) => {
    const row = db.prepare(`
      SELECT id FROM attorneys
       WHERE name = 'Jane Doe' AND bar_number = 'P12345' AND firm_name = 'Doe Law Firm PLLC'
         AND firm_address = '123 Main St, Suite 100
Exampleton, MI 48000'
         AND firm_phone = '(555) 123-4567' AND firm_email = 'jane@doelaw.com'
    `).get();
    if (!row) return;

    const usedByType = db.prepare('SELECT COUNT(*) c FROM matter_types WHERE attorney_id = ?').get(row.id);
    const usedByCoCounsel = db.prepare('SELECT COUNT(*) c FROM matter_attorneys WHERE attorney_id = ?').get(row.id);
    if (usedByType.c > 0 || usedByCoCounsel.c > 0) return;

    db.prepare('DELETE FROM attorneys WHERE id = ?').run(row.id);
  },

  // 31 — A6: a dated activity log, per matter and per client. Append-only —
  //      nothing here is ever updated or deleted. Real events only (document
  //      generated, packet generated, court date added/changed/marked done,
  //      document attached, matter created, stage changed) — never ordinary
  //      field edits, which would make the log too noisy to read.
  //
  //      matter_id and person_id are both nullable: a matter-scoped event
  //      (document generated, stage changed, ...) sets matter_id only — the
  //      client profile rolls it up by joining through parties, so a matter
  //      with several client-parties doesn't need one log row per party. A
  //      client-scoped event with no matter (a scan attached directly to the
  //      person, not a case) sets person_id only.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY,
        matter_id INTEGER REFERENCES matters(id),
        person_id INTEGER REFERENCES people(id),
        event_type TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_log_matter ON activity_log(matter_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_activity_log_person ON activity_log(person_id, created_at);
    `);
  },

  // 32 — A7: payments received, per matter. Flat-fee office, so this tracks
  //      what actually came in, nothing more — no retainer drawdown, no
  //      computed balance against fee_quoted (that field is free text like
  //      "$2,500 flat, TBD after arraignment" and cannot be parsed into a
  //      number to subtract from; decided with the user 2026-08-26). Amounts
  //      are integer cents, never floats.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS matter_payments (
        id INTEGER PRIMARY KEY,
        matter_id INTEGER REFERENCES matters(id),
        amount_cents INTEGER NOT NULL,
        paid_date TEXT,
        notes TEXT,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_matter_payments_matter ON matter_payments(matter_id);
    `);
  },

  // 33 — A10: case transfers. Confirmed by inspection first (per the task):
  //      every generated document already freezes matter_snapshot /
  //      attorney_snapshot at generation time, and the rendered PDF/DOCX
  //      files are static — so an already-generated document already shows
  //      what was true when it was made. No snapshot fix was needed. What
  //      was actually missing is (a) a persistent "assigned attorney" on the
  //      matter at all (there wasn't one — only a matter_type default and a
  //      per-generation dropdown) and (b) a visible history of when court,
  //      judge or attorney changed. This migration adds both.
  //
  //      from_value/to_value store the resolved NAME at the time of the
  //      transfer, not the id — so the history stays readable even if the
  //      court/judge/attorney row is later renamed or archived.
  (db) => {
    addColumn(db, 'matters', 'attorney_id', 'INTEGER REFERENCES attorneys(id)');
    db.exec(`
      CREATE TABLE IF NOT EXISTS matter_transfers (
        id INTEGER PRIMARY KEY,
        matter_id INTEGER REFERENCES matters(id),
        field TEXT NOT NULL,
        from_value TEXT,
        to_value TEXT,
        transferred_on TEXT,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_matter_transfers_matter ON matter_transfers(matter_id);
    `);
  },

  // 34 — A11: scan-and-file reminder. Quiet, dismissible, per generated
  //      document — tracked so it stops asking once dismissed. Distinct from
  //      filed_at (whether it was FILED WITH THE COURT); this is the office's
  //      own housekeeping of the printed copy.
  (db) => {
    addColumn(db, 'documents', 'scan_reminder_done', 'INTEGER DEFAULT 0');
  },

  // 35 — client folders & organization clients (2026-09-24 design).
  //      Everything a client owns now lives under Clients/<Client>/, and a
  //      city is just an Organization client — nothing city-specific.
  //
  //      people.caption_name / signing_attorney_id / usual_role: org-only
  //        defaults that PRE-FILL a new case; the case can override each.
  //      matters.folder_person_id: whose folder a case lives in. Decided once
  //        (asked when the case has several clients). 0 = "No Client".
  //      packets.client_person_id: the client a standalone letter is filed
  //        under; NULL = General Letters.
  //      client_documents.stored_dir: the folder this one file was copied into
  //        (Client Papers or a case's Uploads). NULL = the pre-35 layout, where
  //        every scan sat directly in people.client_docs_dir.
  //
  //      matter_types.folder_name is DEPRECATED from this version: the
  //      case-type folder layer is gone and nothing reads it. Left in place
  //      rather than rebuilt out of the table, because dropping a column in
  //      SQLite means copying the table and it holds user configuration.
  (db) => {
    addColumn(db, 'people', 'caption_name', 'TEXT');
    addColumn(db, 'people', 'signing_attorney_id', 'INTEGER REFERENCES attorneys(id)');
    addColumn(db, 'people', 'usual_role', 'TEXT');
    addColumn(db, 'matters', 'folder_person_id', 'INTEGER');
    addColumn(db, 'packets', 'client_person_id', 'INTEGER REFERENCES people(id)');
    addColumn(db, 'client_documents', 'stored_dir', 'TEXT');
  },

  // 36 (user_version 35) — portable locations. THIS CHANGES WHAT THE PATH
  //      COLUMNS MEAN. Until now each held an ABSOLUTE path on the computer
  //      that wrote it, so a backup restored on another computer (other user
  //      name, other drive, Mac <-> Windows) pointed every Open, Reveal and
  //      "missing" check at the old machine. From this version a location
  //      under the output root is stored RELATIVE to it, "/"-separated on
  //      every platform ("Clients/Alice Anderson/Letters"); main.js resolves
  //      it against this computer's root (storePath / loadPath, built on
  //      folders.js toStored / fromStored). A location outside the root stays
  //      absolute. Columns: people.client_docs_dir, matters.output_dir,
  //      packets.output_dir, client_documents.stored_dir,
  //      generated_files.path, documents.pdf_path, documents.docx_path.
  //
  //      Converts only values under the CURRENT settings.output_root, read in
  //      the flavor that root was written in (a Windows database migrated on a
  //      Mac still compares as Windows, case-insensitively). Everything else
  //      is left exactly as it was. Idempotent: a stored value is already
  //      relative, and toStored leaves it alone.
  (db) => {
    const { toStored, flavorFor } = require('./folders');
    const row = db.prepare("SELECT value FROM settings WHERE key = 'output_root'").get();
    const root = row && row.value;
    if (!root) return;
    const p = flavorFor(root);
    for (const [table, column] of PATH_COLUMNS) {
      if (!hasColumn(db, table, column)) continue;
      const rows = db.prepare(
        `SELECT id, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> ''`).all();
      const set = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
      for (const r of rows) {
        const stored = toStored(root, r.v, p);
        if (stored !== r.v) set.run(stored, r.id);
      }
    }
  },

  // 37 (user_version 36; comment numbers skip 29) — Contacts: judges, clerks,
  //      and everyone who is not a client. Contacts are people rows
  //      (is_contact = 1), so opposing counsel, organizations and search keep
  //      working unchanged. judges.name stays the caption source;
  //      judges.person_id ties it to the contact, and the contact page writes
  //      both names in one transaction.
  //      contact_notes: dated notes on a person OR a court (exactly one set).
  //      Notes are never read by either document renderer.
  //
  //      Back-fill: every judge becomes a Judge contact at its court, and every
  //      opposing counsel is flagged as a contact (role Attorney if blank) —
  //      EXCEPT a person who is a client on any case: the People tab lists
  //      only non-contacts, and a client must never vanish from it.
  //      Idempotent: judges already linked are skipped, roles are INSERT OR
  //      IGNORE, and the flagging UPDATE is a fixed point.
  (db) => {
    addColumn(db, 'people', 'is_contact', 'INTEGER DEFAULT 0');
    addColumn(db, 'people', 'contact_role', 'TEXT');
    addColumn(db, 'people', 'works_at_court_id', 'INTEGER REFERENCES courts(id)');
    addColumn(db, 'people', 'works_at_org_id', 'INTEGER REFERENCES people(id)');
    addColumn(db, 'judges', 'person_id', 'INTEGER REFERENCES people(id)');
    addColumn(db, 'courts', 'address', 'TEXT');
    addColumn(db, 'courts', 'phone', 'TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS contact_roles (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort_order INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS contact_notes (
        id INTEGER PRIMARY KEY,
        person_id INTEGER REFERENCES people(id),
        court_id INTEGER REFERENCES courts(id),
        note_date TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT,
        CHECK ((person_id IS NULL) <> (court_id IS NULL)));
      CREATE INDEX IF NOT EXISTS idx_contact_notes_person ON contact_notes(person_id);
      CREATE INDEX IF NOT EXISTS idx_contact_notes_court ON contact_notes(court_id);
      CREATE TABLE IF NOT EXISTS contact_links (
        id INTEGER PRIMARY KEY,
        a_person_id INTEGER NOT NULL REFERENCES people(id),
        b_person_id INTEGER NOT NULL REFERENCES people(id),
        label TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS matter_contacts (
        id INTEGER PRIMARY KEY,
        matter_id INTEGER NOT NULL REFERENCES matters(id),
        person_id INTEGER NOT NULL REFERENCES people(id),
        label TEXT, sort_order INTEGER DEFAULT 0, created_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_matter_contacts_matter ON matter_contacts(matter_id);
    `);
    const roles = ['Judge', 'Magistrate', 'Clerk', 'Court Officer', 'Probation Officer',
      'Prosecutor', 'Attorney', 'Adjuster', 'Other'];
    const insRole = db.prepare('INSERT OR IGNORE INTO contact_roles (name, sort_order) VALUES (?,?)');
    roles.forEach((r, i) => insRole.run(r, i + 1));

    const now = new Date().toISOString();
    const judges = db.prepare('SELECT id, name, court_id, archived FROM judges WHERE person_id IS NULL').all();
    const insPerson = db.prepare(
      `INSERT INTO people (display_name, kind, is_contact, contact_role, works_at_court_id, archived, created_at)
       VALUES (?, 'individual', 1, 'Judge', ?, ?, ?)`);
    const link = db.prepare('UPDATE judges SET person_id = ? WHERE id = ?');
    for (const j of judges) {
      link.run(insPerson.run(j.name, j.court_id || null, j.archived || 0, now).lastInsertRowid, j.id);
    }
    db.prepare(
      `UPDATE people SET is_contact = 1, contact_role = COALESCE(contact_role, 'Attorney')
        WHERE id IN (SELECT opposing_counsel_person_id FROM matters
                      WHERE opposing_counsel_person_id IS NOT NULL)
          AND id NOT IN (SELECT person_id FROM parties
                          WHERE role = 'client' AND person_id IS NOT NULL)`).run();
  },
];

// Every column that holds a file or folder location (see migration 36). Kept
// here so the migration and its test share one list.
const PATH_COLUMNS = [
  ['people', 'client_docs_dir'],
  ['matters', 'output_dir'],
  ['packets', 'output_dir'],
  ['client_documents', 'stored_dir'],
  ['generated_files', 'path'],
  ['documents', 'pdf_path'],
  ['documents', 'docx_path'],
];

const TARGET_VERSION = MIGRATIONS.length;

// Runs any pending migrations. Returns { from, to, ran }.
// Throws if a migration fails, having rolled that migration back.
function migrate(db, { onBeforeMigrate } = {}) {
  const from = db.pragma('user_version', { simple: true });

  if (from > TARGET_VERSION) {
    // Database written by a newer build. Refuse rather than corrupt it.
    throw new Error(`Database schema v${from} is newer than this app (v${TARGET_VERSION}). Update the app.`);
  }
  if (from === TARGET_VERSION) return { from, to: from, ran: 0 };

  if (from > 0 && typeof onBeforeMigrate === 'function') onBeforeMigrate(from);

  let applied = 0;
  for (let v = from; v < TARGET_VERSION; v++) {
    const step = MIGRATIONS[v];
    const run = db.transaction(() => {
      step(db);
      db.pragma(`user_version = ${v + 1}`);
    });
    run(); // throws -> transaction rolled back, user_version unchanged
    applied++;
  }
  return { from, to: TARGET_VERSION, ran: applied };
}

module.exports = { migrate, TARGET_VERSION, BASE_SCHEMA, parseLegacyAddress, PATH_COLUMNS };
