# TrueCaption

<p align="center">
  <img src="assets/icons/icon.png" alt="TrueCaption" width="128">
</p>

<p align="center">
  <strong>A desktop app that types the boring half of a court filing for you.</strong><br>
  Enter a matter once — the caption, counsel block, signature block and proof of
  service come out right every time, in both Word and PDF.
</p>

<p align="center">
  <a href="#license">MIT licensed</a> ·
  Runs entirely offline · macOS &amp; Windows · No account, no server, no telemetry
</p>

---

## TO COME

## Read this before you file anything with it

> This is a formatting tool, not a lawyer and not a filing service. It does
> not check deadlines, court rules, service requirements or the substance of
> what you write. **Read every document before it leaves your office.** The
> software is provided "as is", without warranty of any kind — see
> [LICENSE](LICENSE). Nothing here is legal advice, and using it creates no
> attorney-client relationship with anyone.

## Scope: this is Michigan-shaped

The caption and signature formatting in `document-engine.js` was read off real
Michigan district and appellate filings — court-name casing, role words,
bar-number punctuation, the hairline rule that ends in a forward slash. It is
not a general specification, and it is not configurable.

What *is* general, and what makes this worth reading if you practice
elsewhere:

- **The packet model** — a filing as a set of role-tagged documents, with the
  enclosure list and service list derived from the set rather than typed twice.
- **The render-version cache-busting scheme** — how to make "reuse the
  existing file if nothing changed" safe when *rendering* changes too.
- **The dual PDF/Word render** — one block list, two engines, with a test
  suite that catches the second one silently dropping blocks.

Adapting this to another state means replacing the caption and signature block
builders in `document-engine.js`. The rest of the app — matters, attorneys,
packets, backups, output paths — does not know or care which court it is for.

## Getting started

Requires Node 22 and, on Windows, the build tools `better-sqlite3` needs.

```bash
git clone https://github.com/KarlFarts69/TrueCaption.git
cd TrueCaption
npm install
npm start                # run the app
```

```bash
npm run smoke            # launches the app, drives the real UI, inspects generated files
npm run test:migrations  # proves existing data survives a schema upgrade
```

There is no browser dev mode, on purpose. There used to be, and its second
copy of the schema drifted four tables behind the migrations; worse, its
`window.api || fetch(...)` shim swallowed a fatal renderer error and made a
completely inert app look healthy. The app runs under Electron or not at all.

**Building an installer.** `npm run dist` / `npm run dist:win` invoke
`electron-builder`. `better-sqlite3` is a native module, so a Windows
installer has to be built on Windows — see
`.github/workflows/build-windows.yml` for a runner that does it. The output is
neither code-signed nor notarized, so both platforms warn on first launch —
see [Installing a downloaded build](#installing-a-downloaded-build).

### Installing a downloaded build

Neither installer is signed, so each platform stops the first launch. Nothing
is wrong with the download; this is what unsigned software looks like.

**Windows.** SmartScreen shows "Windows protected your PC" (unknown
publisher). Click **More info**, then **Run anyway**.

**macOS.** Gatekeeper blocks the first launch because the app isn't from an
identified developer, and on recent versions the message is *"TrueCaption is
damaged and can't be opened"* — that is what an unsigned download looks like,
not a corrupt file. Either right-click (or Control-click) the app and choose
**Open**, or open **System Settings → Privacy & Security**, scroll to the
message naming TrueCaption, and click **Open Anyway**. Only the first launch
needs this.

**Using the app** is documented separately, for the person using it rather
than the person editing it: **[HOW-TO-USE.md](HOW-TO-USE.md)**.

---

## How it fits together

| File | Responsibility |
|---|---|
| `main.js` | Electron main process: database, file output, PDF/DOCX generation, backups |
| `preload.js` | The only bridge to the renderer (`window.api`) |
| `renderer.js` | All UI |
| `document-engine.js` | Document templates, packet definitions, and HTML rendering — the shape of each filing |
| `db-migrations.js` | Ordered schema migrations |
| `db-backup.js` | Rolling backups, manual backup, restore |
| `scripts/smoke.mjs` | End-to-end suite: launches the app, drives the UI, opens the generated files |

Code comments refer to a format spec by section (`spec §04`, `decision 7`).
That spec was reverse-engineered from real-world court filings and
is not published with this repository; the rules it settled are restated in
**Document formatting** below.

### Four rules worth keeping

Each of these is a bug that shipped. They are written down because none of
them is obvious from reading the code.

**1. A block type handled in `document-engine.js` must also be handled in
`main.js`'s Word export.** The `.docx` generator switches on block type and
silently drops anything it doesn't recognize. That is how the caption,
signature and proof of service once vanished from Word output while looking
fine in the PDF — seven blocks in, two paragraphs out. The smoke suite asserts
each caption element survives into the `.docx` for exactly this reason.

**2. Never edit or reorder a shipped migration. Append.** Migrations run once,
tracked by SQLite's `user_version`, inside a transaction, with a backup taken
first. `scripts/test-migrations.js` builds a database on the original schema,
fills it with data, upgrades it, and asserts the data survived — it has
already caught one real bug (`""` is an identifier in SQLite, not a string
literal).

**3. Bump `RENDER_VERSION` in `main.js` with any change to what
`generatePdf`/`generateDocx` actually produce.** `resolveOutputPath()` reuses
a matter's existing file when its content hash is unchanged, so a rendering
fix with no *data* change is otherwise invisible: the old, pre-fix file keeps
matching the hash and gets served forever, reported as "No changes —
reusing." This happened for real with the caption `columnWidths` fix.
`RENDER_VERSION` is folded into that hash for exactly this reason.

The same trap has a second mouth. The hash source must be everything the
output is built *from*. `generate-docx` originally hashed the block list
alone — but a block like `{ type: 'district_caption' }` carries no content:
the court header, case number, judge, party names, caption notes and signature
are all resolved from `matter`/`attorney` inside the handler. So none of them
could invalidate the cache, and editing a matter's caption notes handed back
the pre-edit `.docx` while the PDF (hashed on its fully rendered HTML) updated
correctly. The docx hash now covers `{ blocks, matter, attorney }`.

**4. Borderless Word tables need `insideHorizontal` and `insideVertical` set
explicitly.** Setting only the four outer edges to `NONE` still emits a
`<w:tblBorders>` element, and Word's default for the inside edges is a single
black rule — so every caption printed inside a box in the `.docx` while the
PDF had none. `NO_BORDERS` (table) and `NO_CELL_BORDERS` (cell) in `main.js`
are separate for this reason. Nothing in the *text* of the document was wrong,
so no text-presence check could see it — it was caught by rendering the
`.docx` and looking at it.

### Packets

A **packet** is one filing: several documents sent together on one date, into
their own folder (`packets.output_dir`, frozen like a matter's). Packet
definitions live in `DocumentEngine.packets`.

The load-bearing idea is that each document in a packet carries a **role**:

| Role | Meaning |
|---|---|
| `enclosure` | filed and served — appears in both derived lists |
| `internal` | never leaves the office (the memo to the property officer) |
| `cover` | the transmittal letter itself |
| `service` | the proof of service itself |

Because of that, the transmittal letter's enclosure list and the proof of
service's document list are **derived from the packet**, including the `and`
between two items. Both read the same stored title — which is the whole point,
and the drift described at the top of this file is what it prevents.

`generated_files` is keyed on `(matter_id, doc_type, format)`, so packet
documents qualify the key with `@packet<id>` — two packets on one matter
contain the same doc types and would otherwise collide.

### Document formatting

Caption formats are reproduced from actual filings, not invented. Details that
look like mistakes are usually deliberate:

- Court names print **exactly as stored** — upper-casing turns
  `99th JUDICIAL DISTRICT COURT` into `99TH`, which the filings this was
  modeled on never do.
- Document titles are **bold and underlined** — that holds for every filing
  in the source set (`ANSWER TO MOTION`, `PROOF OF SERVICE` and the rest). The
  **one** exception is the appellate cover page, where the title is bold and
  *not* underlined — that is what the `title` block type (as opposed to
  `title_underlined`) exists for.
- The party role word (`Defendant` / `Respondent`) comes from one setting and
  drives the caption, body sentence and signature block together. The
  hand-made templates this replaced contradicted themselves on exactly that —
  and so did the legacy `caption` block, which derived the role word from how
  many parties were on a side and so printed `Defendant` on a matter set to
  `Respondent`, directly above a signature saying `Attorney for Respondent`.
- Caption tables must set `TableLayoutType.FIXED`. Explicit `columnWidths` are
  only a hint without it: Word auto-fits to content, so the same caption sat at
  55/45 for a long party name and collapsed to about 25/75 for a short one.
- The caption and the counsel block are each closed by a **hairline rule ending
  in a forward slash**, not a bare slash. It is drawn as one
  bottom-bordered paragraph with the slash right-aligned on it — deliberately
  *not* as a rule-cell + slash-cell table, because that rule cell is empty and
  an empty cell collapses to zero width in any renderer that auto-fits columns.
- The bar number is punctuated **differently in its two places, deliberately**:
  `(P12345)` in the counsel block at the top of the page, bare `P12345` in the
  signature at the bottom. Both renderers are asserted on this in the smoke
  suite, because the Word export drifted to brackets in both.

### Escaping

Everything interpolated into caption HTML goes through `esc()`. This is a
correctness issue before it is a security one: real data contains ampersands
(`FLEE & ELUDE FELONY`, `ROE & ASSOCIATES P.L.L.C.`) and a `<` in a party name
would swallow the rest of the caption.

---

## Not done yet

- Notice of Hearing, Generic Motion and Brief still use the old generic caption
  rather than the district-court format. They obey the settled decisions (role
  words from the matter, `vs.`, the caption note stack) and match their own
  Word export — but the *layout* (a vertical rule between the columns, a
  trailing comma and full stop after the role words) is still the old invented
  shape, not something read off a filing. They need real filed examples to copy.
- Only Michigan district and appellate formatting is implemented. See
  [Scope](#scope-this-is-michigan-shaped).
- The installer is neither code-signed (Windows) nor notarized (macOS), so both
  platforms warn on first launch. See
  [Installing a downloaded build](#installing-a-downloaded-build).

## Contributing

Issues and pull requests are welcome, particularly:

- **Filed examples from other jurisdictions.** The single biggest constraint on
  this project is that formatting is copied from real filings rather than
  guessed. A redacted example of a correct caption from your state is worth
  more than a patch.
- **A second jurisdiction's caption builder**, proving the seam in
  `document-engine.js` is in the right place.
- **Bug reports with the generated file attached** — for rendering bugs, the
  `.docx` or `.pdf` is the report.

Before opening a PR: `npm run smoke` and `npm run test:migrations` should both
pass, and if you changed what gets rendered, bump `RENDER_VERSION` (rule 3).

Please do not attach anything from a live matter. Use invented names.

## License

MIT — see [LICENSE](LICENSE).

<sub>Happy birthday, Dad :)</sub>
