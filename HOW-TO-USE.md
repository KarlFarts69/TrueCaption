# TrueCaption — How to Use It

This app builds court documents from information you enter once, so the caption,
signature block and proof of service are typed correctly every time.

Everything is stored **on this computer**. Nothing goes to the internet.

---

## The one-time setup

Do this once. It takes about ten minutes.

### 1. Your signing details — the **My Office** tab

**My Office** holds your signing profiles: who signs, and under which office.
Click **Add Signing Profile** and fill in your details:

| Field | What goes in it | Example |
|---|---|---|
| Signs As | A short name for this profile, so you can tell profiles apart | `Exampleton City Attorney` |
| Name | Your name as it prints | `Jane A. Attorney` |
| Bar Number | | `P12345` |
| Firm / Office Line | The line printed **above** your name | `Exampleton City Attorney` |
| Firm Address | Street on one line, city/state/zip on the next | `123 Main Street`<br>`Exampleton, MI 48000` |
| Firm Phone | | `(555) 123-4567` |
| Firm Email | Leave blank if you don't want it on filings | |
| Signature Image | Optional. A scan of your signature, placed above the line | |

**If you sign under more than one office**, open the one you've made and click
**Duplicate**. It keeps your name, bar number and signature, and you only change
the office line and address. Tick *"Pre-select this one when generating"* on
whichever you use most.

### 2. Your kinds of work — **Settings → Matter Types**

A matter type is a kind of work — Criminal Defense, Civil, Prosecution,
Appellate. It fills in two things on a new matter, and the matter can change
either: what the caption says above the plaintiff (the **caption authority**),
and which signing profile signs.

Two are set up already (Criminal Defense, Civil Litigation). Add others as you
need them:

| Name | Caption authority | Signs as |
|---|---|---|
| `Criminal Defense` | `PEOPLE OF THE STATE OF MICHIGAN` | your usual profile |
| `Civil` | *(blank — the plaintiffs print instead)* | your usual profile |

> **Type the authority line exactly as it should print.** It goes onto the
> document character for character.

A matter type does **not** decide where files are saved — they go under the
client (see *Where files are saved* below). And **a city or business you work
for is not a matter type**: set it up as an Organization client (see
*Organization clients* below).

### 3. Where documents are saved — **Settings → Documents Folder**

Defaults to `Documents\Legal Documents`. Leave it unless you want them elsewhere.
What goes inside it is described under *Where files are saved* below.

If you move that folder (a new computer, another drive), click **Choose
Folder…** and pick where it is now; your saved documents are found there. If
the folder you pick doesn't hold your existing documents, the app warns you
first. If the folder is on a drive that isn't plugged in, a yellow note at the
top of the screen says so, and nothing is saved until the drive is back (or
you choose its new location) — the app never starts a new, empty folder in
its place.

---

## Day to day

### Making a document

1. **Matters** tab → **New Matter**
2. Fill in:
   - **Matter Type** — fills in the caption authority and the signing profile
   - **Our Client Role** — which side you are on: Plaintiff or Defendant. A
     new matter starts blank and must be chosen; it decides the
     "Attorney for …" line
   - **Matter Name** — for you, not printed (e.g. `Roe`)
   - **Case Number**, **Court** — the court name prints exactly as typed, so
     write it the way the court does: `99th JUDICIAL DISTRICT COURT`. Each
     court has its own page — **Contacts → Courts**, click the court (or
     **New Court**) — where you set, once per court, its **Header line** (the
     line printed beneath STATE OF MICHIGAN, exactly as typed, e.g.
     `IN THE 96th District Court`), its **City**, used by the Stipulation and
     Order's ORDER page (`held in the City of ___`), and its **County**, used
     by every proof of service (`COUNTY OF ___`). The page also keeps the
     court's address, phone and notes, and lists the people who work there
     and your cases in it. A judge's name is edited on the judge's own contact
     page.
   - **Plaintiffs / Defendants** — start typing a name; anyone used before will
     appear in the list. Click **+ Add "…"** for someone new.
   - **Defendant Side Label** — `Defendant` or `Respondent`. This one setting
     controls the caption, the sentence in the body, and the signature block, so
     they can never disagree with each other.
   - **Caption Notes** — the lines that print under the case number and judge.
     Charges go here. Click **+** for each one, and use **↑ ↓** to put them in
     the order you want them printed. A compound charge is your choice: one
     note reading `OWI, Speed 11-15, BAC 0.XX`, or three separate notes —
     nothing else in the caption moves either way. Pasting several lines at
     once splits them into separate notes.
3. **Save Matter**
4. **Generate Document…**
5. Pick the **Document Type**, fill the fields, then **Generate PDF** or
   **Generate Word**
6. Click **Open Document** to see it, or **Show in Folder** to find it on disk.
   The **Open Folder** button at the top of a matter opens its folder too.

Every file you've ever generated for a matter — PDF and Word, going back as
far as it goes — is also listed on that matter's page under **Files on
Disk**, each with its own **Open** and **Show in Folder**. You don't have to
regenerate something just to open it again.

### The yellow "Check before filing" box

If something is missing — no court, no case number, a placeholder still in the
caption — a yellow box lists it before you generate. It doesn't stop you; it just
means the document will have a gap in it.

### Regenerating

Generating the same document twice does **not** make a duplicate. If nothing
changed, it reuses the file and tells you. If something did change, it saves a
new one ending `v2`, `v3` — the old version is never overwritten.

---

## Where files are saved

Everything the app writes or keeps goes under the Documents Folder
(`Documents\Legal Documents` unless you changed it), filed under the client it
belongs to:

```
Legal Documents/
  Clients/
    Alice Anderson/
      Client Papers/                    scans not tied to a case
      Letters/                          letters for this client
        2026-01-12 Letter to Bob Baker/
      Anderson (2026-CV-0101)/          one folder per case
        Uploads/                        scans attached to this case
        2026-01-05 Claim & Delivery Response/   a packet
        ...                             single documents sit here, loose
  General Letters/                      letters with no client
  No Client/
    Roe (2026-CR-0202)/                 a case saved with no client, by choice
  Blank Forms/                          the printable blank questionnaire
```

- **A folder is set once.** The first time anything is saved for a case, its
  folder is made and remembered. It does not move afterward — not if you
  rename the client, change the case number, or change the matter type.
- **Long names are shortened** so the whole path stays short enough for
  Windows. Two clients with the same name get separate folders: the second
  one's folder has a number after the name.
- **Letters** go in the client's **Letters** folder when you pick a client on
  **New Letter** (it is picked for you when the person you're writing to is
  already a client), or in **General Letters** when you don't.
- **Scans** you add from Home's **Add Documents**, or on a client's profile,
  are *copied* in: to the case's **Uploads** folder when you attach them to a
  case, otherwise to the client's **Client Papers**.

### "Which client's folder should this case be saved in?"

A case has one folder. When a case has exactly one client, that's whose folder
it goes in, and the app doesn't ask. When it has **more than one** — say
Alice Anderson and Bob Baker are co-plaintiffs — the first time you save
something for it, the app asks which client's folder to use. Pick one; it
won't ask again for that case.

The other client still sees the case on their profile, under **Cases**, with
an **Open Folder** link that opens the same folder. Nothing is copied, so
there is only ever one version of each file.

If the case has no client at all, the same question offers **No Client**, and
the case is saved under `No Client/`.

---

## Organization clients

A city, township, business or nonprofit you work for is a client like any
other — open **+ New Client** (or **People → New Person**) and set **Type** to
**Organization**. Three extra fields appear, all optional:

| Field | What it does | Example |
|---|---|---|
| Name in captions | How the organization's name prints as a party | `PEOPLE OF THE CITY OF EXAMPLETON` |
| Signs as | The signing profile used on its cases | `Exampleton City Attorney` |
| Usually | The side it is usually on, filled in as **Our Client Role** | Plaintiff |

Each of these only **fills in** a new case for that organization; the case can
change any of them. If you prosecute for two cities, make two Organization
clients (City of Exampleton, City of Sampleton), each with its own caption name
and signing profile — not two matter types. Their files go under
`Clients/City of Exampleton/` like any other client's.

Date of birth, and the cell-phone reminder, don't apply to an organization and
are left off its profile.

---

## Packets — filing several documents at once

A **packet** is one filing: several documents that go out together on the same
date, saved into their own folder inside the matter.

Two are set up:

- **Claim & Delivery Response** — five documents: a transmittal letter to the
  court and the other side, a memorandum to the property officer, two
  answers, and a proof of service.
- **Driver License Hearing Request** — two documents: a covering letter to
  the Department of State's Driver Assessment and Appeal Division, and an
  Appearance and Request for Hearing. No case number — there isn't one yet at
  this stage, so the app doesn't ask for one on this packet.

**You fill in one form, once.** For claim & delivery, the date, the case
number and the description of the seized item go in a single place and print
into every document that needs them; the letter's list of what is enclosed,
and the proof of service's list of what was served, are **worked out by the
app from what is in the packet** — you never type them, so they can never
disagree with each other. For a driver license hearing, the date, the hearing
type (e.g. "Implied Consent Refusal"), and the client's date of birth and
license number go in once and print into both documents.

1. Open the matter → **Packets** → **+**
2. Pick the letterhead, fill in the date and the packet's own fields
3. **Generate Packet (Word)** — every document in the packet is written at
   once, numbered in filing order, into one folder
4. **Show Packet Folder** to find them

The yellow "Check before filing" box works here too: it tells you if there is no
letterhead, no item description or no date before you print anything.

### Letterheads — **Settings → Letterheads**

Letters and memoranda print on a letterhead — and there are two different
shapes, set by the **Kind** dropdown on each letterhead:

- **City** — the name across the top, the office lines, the address, the
  seal, and the names down the left-hand side. This is what claim & delivery
  uses.
- **Personal** — your name at the left, "Attorney at Law" beneath it, your
  address on the right. No seal, no names down the side. This is what the
  driver license hearing letter uses.

Add one of each you write from.

Everything prints **exactly as you type it**.

One setting to know about: **reference initials separator**. That is the mark in
`ABC:de` at the bottom left of a letter. City letterhead uses a colon, personal
letterhead uses a slash — that difference is deliberate, so it belongs to the
letterhead rather than being set once for everything.

---

## People — the client profile

The **People** tab is everyone you've named on a matter. Open a person to see
their whole file: who they are, what cases they're on, what you've sent out for
them, and what paper you've collected.

### The intake questionnaire

The left-hand side is the intake form, in sections. The everyday ones are open;
**Emergency Contact**, **Medical**, **Education** and **Prior Record** start
folded away. A folded section with something in it shows a small blue dot in its
heading, so you can see there *is* medical history without opening it.

**Licences stay open on purpose.** A CDL changes the whole shape of a drunk
driving case, so it's the first thing you see, not something you have to dig for.

Everything on this side follows the *person*, not the case — date of birth,
address, employer, priors. A client who comes back in two years on a new charge
already has all of it.

**Charge, BAC, citation number, police agency, date of offense, fee quoted and
referred-by are not here.** Those belong to one incident, so they live on the
**matter**. That's deliberate: a fee you quoted in 2026 shouldn't still be
sitting on the client's profile in 2028 as though it were current.

### Prior Record

**Add prior** puts a row in. One line per prior — offense, court, date, place,
disposition. As many as you need.

### On paper instead

**Print Blank Questionnaire** in the toolbar prints the same form for a client to
fill in by hand in the waiting room. It's built from the same list as the screen,
so the paper and the app can never drift apart.

### The right-hand side

**Cases** — every matter this person is on, with its next court date shown right
on the row. A date shown in red has already gone by. Once anything has been
saved for a case, its row has an **Open Folder** link — on a case shared with
another client, that opens the one folder the case is saved in.

**Work Product** — everything the app has produced for this client: court filings
*and* letters together, newest first. Click any of them to open it.

**Documents** — paper you've collected. Drag a scan onto the panel, or use
**Add Document…**. The file is *copied* into that client's folder, so tidying
up your scanner's output folder later can't break anything. Give each one a label
and a date, and attach it to one of their cases if it belongs to one.

**Open** opens the file. **Reveal** shows it in Explorer. **Remove** takes it off
the list — the file itself stays in the Clients folder. The app never deletes
your scans.

### Court dates

Court dates go on the **matter**, not the person, so a client with three cases
has three sets of dates. Open the matter and find **Court Dates**, then
**Add Court Date**: type, date, time, place, and a **Done** tick once it's been
and gone. A done date stops counting as the next one without being deleted.

The soonest one that isn't ticked shows on the client's profile and in a
**Next date** column on the People list, which you can sort by. Anything overdue
sorts to the top in red.

The **Calendar** tab (next to Matters) shows every court date on a month
calendar; click one to open its matter. Home's **View Calendar** link opens the
same calendar.

If a court date has passed and the case still says it's at that stage, the matter
shows a quiet note pointing it out. **It never changes the stage itself** — the
app has no way of knowing whether a hearing was adjourned, waived, or resolved
with a plea, and a wrong stage on a criminal file is worse than an old one.

### Adding someone mid-filing

Typing a new name into a party box and clicking **+ Add** creates them and
**keeps you where you are** — it won't throw away the filing you're partway
through. A note appears under the box: *"John Smith added — name only.
↗ open profile"*. Click that when you're ready to fill in the rest, and if you
have unsaved work it will offer to save first.

### Archiving

**Nothing is ever deleted** — people, judges, courts and matters are *archived*.
They disappear from the dropdowns, but old documents keep showing the right name.
Tick "Show archived" to bring one back. A court is archived and restored at the
bottom of its page; a judge at the bottom of the judge's contact page.

Archive sits at the **bottom** of the client profile, well away from Save, and it
asks first — by name, so you can see who's about to disappear from your pickers.
Restore doesn't ask; putting someone back isn't dangerous.

---

## Contacts and courts

The **Contacts** tab is everyone on a case who isn't your client — judges,
clerks, opposing counsel, probation officers, adjusters, anyone you deal with
professionally. Clients stay in **People**; contacts have their own list so
the two never mix.

**A contact's Role** (Judge, Clerk, Attorney, Probation Officer, and so on)
comes from a pick-list you can add to from the contact page itself — type a
new one into **Role** and choose **Add role…**.

**Works at** is one box for both courts and organizations (law firms,
adjusters' offices). Start typing and pick from the list; if two places share
a name, courts and organizations both show their city (for example "(court,
Sampleton)" or "(organization, Exampleton)") so you can tell them apart.

### Judges are contacts too

Making a contact's Role **Judge** also makes them a judge you can pick on a
case — their name is what prints in captions. Editing the name here updates
every case's caption that uses this judge, right away. Change a judge's Role
away from Judge and they drop out of the judge picker (existing captions keep
printing their name); change it back and they're restored.

### Court pages

Every court has its own page: name, the header line that prints under STATE
OF MICHIGAN exactly as typed, city, county, address and phone. It lists
everyone whose **Works at** points here, and every case filed in this court.
Archive a court from the bottom of its own page — it disappears from the
court picker, but cases already filed there keep printing its name.

### Notes are private — they never print

Both a contact's page and a court's page have a **Notes** section — dated,
free-text notes for the office only (parking, how someone prefers to be
reached, a clerk's quirks). **These notes never appear on any document.**
They're read straight into the app's screens and nowhere near what a filing
renders from.

### Connecting contacts, and cases

**Connected to**, on a contact's page, links two contacts to each other with a
short label ("her clerk", "co-counsel") — the link shows on both pages.

**Cases**, on a contact's page, lists every case this contact is on — as the
judge, as opposing counsel, or added by hand — with the case number and how
they're involved. **Add to case** puts a contact on a case that doesn't
already put them there automatically; it refuses if they're already on that
case some other way.

### Who's involved, on the case itself

Open a case and its **Who's involved** box shows the court, judge and
opposing counsel it already has, plus anyone added by hand, each with their
latest note on one line. **+ Add contact** picks an existing contact or makes
a new one on the spot; **Remove** takes someone off this one case without
touching their contact page.

---

## Backing up — please read this one

Your matters live in a single file on this computer. The app copies it
automatically every time it starts and keeps the last ten copies — but those
copies sit on the **same hard drive**. If that drive dies, they die with it.

So every so often: **Settings → Back Up Now…** and save it to OneDrive, or a USB
stick. That's the copy that survives a dead computer.

To move everything to a different computer, take that file to the new machine
and use **Settings → Restore From Backup…**.

---

## If something goes wrong

**"Cannot open your data" on startup.** The app is telling you it did *not*
change anything. Close it and open it again. If it keeps happening, use
**Restore From Backup** and pick the newest file from the backups folder it
names on screen.

**The caption says `[COURT]` or `[CITY]`.** Something wasn't filled in. `[COURT]`
means the matter has no court set. `[CITY]` means a matter type still has
placeholder text in it — fix it in **Settings → Matter Types**.

**A document opened in the wrong program.** Windows decides that, not the app.
Right-click the file → Open With → choose Word or Acrobat → tick "Always use".
