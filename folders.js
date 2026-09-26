// Where things are saved. Pure functions only — no Electron, no database — so
// the rules are testable with plain Node (scripts/test-folders.js). main.js
// decides WHEN a folder is created and freezes it; this file decides WHAT it
// is called. Layout: see the "Where files are saved" section of HOW-TO-USE.md.
const path = require('path');

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
function sanitizeSegment(value, fallback) {
  let out = String(value == null ? '' : value)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (WINDOWS_RESERVED.test(out)) out = `_${out}`;
  return out || fallback;
}

// Windows still trips over paths past 260 characters (MAX_PATH), and the
// client/case/packet nesting is four levels deep. Every segment is capped when
// the folder is FIRST created; it is frozen after that, so a cap never renames
// anything that already exists.
const LIMITS = { client: 60, matter: 60, packet: 40, fullPath: 250 };

function capSegment(value, max) {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  // Only back up to a space if that keeps most of the name; one enormous
  // word is simply hard-cut.
  let out = (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[. ]+$/, '');
  // A cut can leave a bare device name ("CON ..." -> "CON"), so guard it the
  // same way sanitizeSegment does, and cut one more if the "_" overflows.
  if (WINDOWS_RESERVED.test(out)) out = `_${out}`.slice(0, max);
  return out;
}

const seg = (value, fallback, max) => capSegment(sanitizeSegment(value, fallback), max);

const clientDir = (root, name) => path.join(root, 'Clients', seg(name, 'Client', LIMITS.client));
const clientPapersDir = (dir) => path.join(dir, 'Client Papers');
const clientLettersDir = (dir) => path.join(dir, 'Letters');
const caseUploadsDir = (dir) => path.join(dir, 'Uploads');
const noClientDir = (root) => path.join(root, 'No Client');
const generalLettersDir = (root) => path.join(root, 'General Letters');
const blankFormsDir = (root) => path.join(root, 'Blank Forms');

// The case number is what tells two cases for one client apart, so the NAME
// is shortened to make room for it first. The number is free text, though, so
// it gets its own cap: "Name (Number)" never exceeds LIMITS.matter, and a
// number that sanitizes to nothing adds no empty "()".
const CASE_NUMBER_MAX = 30;
function caseDir(parent, shortName, caseNumber) {
  const cleanNum = capSegment(sanitizeSegment(caseNumber, ''), CASE_NUMBER_MAX);
  const num = cleanNum ? ` (${cleanNum})` : '';
  const name = capSegment(sanitizeSegment(shortName, 'Untitled Case'), LIMITS.matter - num.length);
  return path.join(parent, `${name}${num}`);
}

function packetDir(parent, date, label) {
  return path.join(parent, seg([date, label].filter(Boolean).join(' '), 'Packet', LIMITS.packet));
}

// A standalone letter's own folder: "<date> Letter to <Recipient>". Letters
// with no client all share General Letters/ (and a client's letters share
// their Letters/), so the recipient is what keeps two letters written on the
// same day apart. n > 1 adds " (n)" for a second letter to the same person on
// the same day; the name is shortened to make room, never the number.
function letterPacketDir(parent, date, recipient, n) {
  const tag = n > 1 ? ` (${n})` : '';
  const who = sanitizeSegment(recipient, '');
  const name = [date, who ? `Letter to ${who}` : 'Letter'].filter(Boolean).join(' ');
  return path.join(parent, `${seg(name, 'Letter', LIMITS.packet - tag.length)}${tag}`);
}

// Last line of defense on the whole path: trim the file-name STEM (never the
// folder, which may already be frozen; never the " v2" or the extension).
// The stem is never cut below 20 characters, so the <= LIMITS.fullPath promise
// holds only when `dir` leaves room for it. With the client/case/packet caps
// above, dir is at most root + 171 characters ("Clients" + 60 + 60 + 40 and
// separators), so with a " v2.docx" ending that means an output root of about
// 50 characters or less. A longer root (the user's choice)
// can produce a path past 250; we keep a readable file name rather than
// shrink it to nothing.
function fitPath(dir, stem, suffix, ext) {
  const fixed = dir.length + 1 + suffix.length + 1 + ext.length;
  const room = Math.max(20, LIMITS.fullPath - fixed);
  const s = stem.length > room ? capSegment(stem, room) : stem;
  return path.join(dir, `${s}${suffix}.${ext}`);
}

// ---- Stored form of a location ---------------------------------------------
// Every folder and file location the database keeps (matters.output_dir,
// packets.output_dir, people.client_docs_dir, client_documents.stored_dir,
// generated_files.path, documents.pdf_path / docx_path) is stored RELATIVE to
// the output root, with "/" separators on every platform:
//   Clients/Alice Anderson/Speeding (2026-TR-0142)/Uploads
// so a backup restored on another computer (other user name, other drive,
// Mac <-> Windows) still finds every file once the Legal Documents folder is
// copied across and the output root points at it. A location OUTSIDE the root
// (a root the user moved, a file kept elsewhere) stays absolute.
//
// `p` is the path flavor (path.posix / path.win32); main.js leaves it at the
// platform default, the tests and the migration pass one explicitly.

// A Windows drive path or UNC share. Recognized on every platform: read on a
// Mac, "C:\Users\..." is not path.posix-absolute, and must never be joined
// under the root as if it were a relative name.
const WINDOWS_ABSOLUTE = /^([A-Za-z]:[\\/]|\\\\)/;
const looksAbsolute = (value, p) => p.isAbsolute(value) || WINDOWS_ABSOLUTE.test(value);

// The flavor a stored root was written in — for code (the migration) that may
// read a database made on the other platform.
const flavorFor = (root) => (WINDOWS_ABSOLUTE.test(String(root || '')) ? path.win32 : path.posix);

function toStored(root, abs, p = path) {
  if (abs == null || abs === '') return abs;
  const value = String(abs);
  // Already relative (stored) — idempotent.
  if (!looksAbsolute(value, p)) return value;
  // A root this flavor cannot read (a Windows root on a Mac) cannot contain
  // anything we can prove, so the value stays as it is.
  if (!root || !p.isAbsolute(String(root))) return value;
  if (p === path.posix && WINDOWS_ABSOLUTE.test(value)) return value;
  // path.win32.relative compares case-insensitively, as Windows does.
  const rel = p.relative(String(root), value);
  if (rel === '') return '.';
  if (p.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${p.sep}`)) return value;
  return rel.split(p.sep).join('/');
}

function fromStored(root, stored, p = path) {
  if (stored == null || stored === '') return stored;
  const value = String(stored);
  // Absolute (outside the root, or written before relative storage) is left
  // alone — including a Windows path read on a Mac, which will simply not be
  // found rather than being joined under this machine's root.
  if (looksAbsolute(value, p)) return value;
  if (!root) return value;
  return p.join(String(root), ...value.split('/'));
}

// The top-level folder a stored location lives in ("Clients", "No Client",
// "General Letters", ...), or null for an absolute value (outside the root, so
// not the root's business) and for "." (the root itself). Settings uses the
// set of these to tell whether a newly chosen documents folder actually holds
// the tree the database points into.
function storedTopFolder(stored, p = path) {
  if (stored == null || stored === '') return null;
  const value = String(stored);
  if (looksAbsolute(value, p)) return null;
  const first = value.split('/').find(s => s && s !== '.');
  return first || null;
}

module.exports = {
  storedTopFolder,
  LIMITS, sanitizeSegment, capSegment, clientDir, clientPapersDir, clientLettersDir,
  caseDir, caseUploadsDir, noClientDir, generalLettersDir, blankFormsDir, packetDir, letterPacketDir,
  fitPath, toStored, fromStored, flavorFor
};
