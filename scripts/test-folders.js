// Pure path rules — no Electron, no database. Run: npm run test:folders
//
// Every expected path is built with path.join, never a hard-coded separator, so
// the same checks pass on the macOS and Windows CI runners.
const path = require('path');
const F = require('../folders');

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(name);
};

const root = path.join('C:', 'Users', 'someone', 'Documents', 'Legal Documents');

// sanitize (moved verbatim from main.js — existing behavior must not change)
check('sanitize strips Windows-illegal characters', F.sanitizeSegment('Smith/Jones: v?', 'x') === 'SmithJones v');
check('sanitize guards reserved names', F.sanitizeSegment('Nul', 'x') === '_Nul');
check('sanitize falls back when empty', F.sanitizeSegment('  ', 'Fallback') === 'Fallback');

// capSegment: cut at a word boundary, never mid-word, no trailing dot/space
const long = 'Exampleton Regional Housing and Community Development Nonprofit Corporation';
const capped = F.capSegment(long, 60);
check('capSegment respects the limit', capped.length <= 60, String(capped.length));
check('capSegment cuts at a word boundary', long.startsWith(capped) && long[capped.length] === ' ', capped);
check('capSegment leaves short names alone', F.capSegment('Alice Anderson', 60) === 'Alice Anderson');
check('capSegment hard-cuts one enormous word', F.capSegment('x'.repeat(90), 60).length === 60);
// a cut can expose a reserved device name; it gets the same "_" guard as
// sanitizeSegment and still fits the limit
const reservedCut = F.capSegment('CON ' + 'x'.repeat(60), 4);
check('capSegment never returns a bare reserved name',
  !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(reservedCut) && reservedCut.length <= 4, reservedCut);
check('capSegment guards a reserved name exposed at a word boundary',
  F.capSegment('COM1 ' + 'z'.repeat(10), 7) === '_COM1', F.capSegment('COM1 ' + 'z'.repeat(10), 7));
check('capSegment cuts one more when the guard would overflow',
  F.capSegment('NUL' + 'q'.repeat(10), 3) === '_NU', F.capSegment('NUL' + 'q'.repeat(10), 3));

// the layout
const clientHome = path.join(root, 'Clients', 'Alice Anderson');
check('client dir', F.clientDir(root, 'Alice Anderson') === clientHome);
check('client dir caps a long org name',
  path.basename(F.clientDir(root, long)).length <= 60);
check('client papers', F.clientPapersDir(clientHome) === path.join(clientHome, 'Client Papers'));
check('case dir with case number',
  F.caseDir(clientHome, 'Speeding', '2026-TR-0142') === path.join(clientHome, 'Speeding (2026-TR-0142)'));
check('case dir keeps the case number when the name is long',
  F.caseDir('X', 'A '.repeat(50).trim(), '2026-TR-0142').endsWith('(2026-TR-0142)'));
check('case dir name capped at 60',
  path.basename(F.caseDir('X', 'A '.repeat(50).trim(), '2026-TR-0142')).length <= 60);
// case_number is free text, so the number is capped too and the whole
// "Name (Number)" segment always fits LIMITS.matter
const longNum = path.basename(F.caseDir('X', 'Speeding Ticket Matter', 'A'.repeat(200)));
check('case dir caps a 200-char case number', longNum.length <= F.LIMITS.matter, String(longNum.length));
check('case dir with a long number still keeps the name', longNum.startsWith('Speeding'), longNum);
const bothLong = path.basename(F.caseDir('X', 'N'.repeat(200), 'A'.repeat(200)));
check('case dir caps a 200-char name + 200-char number', bothLong.length <= F.LIMITS.matter, String(bothLong.length));
check('case dir drops a number that sanitizes to nothing',
  F.caseDir('X', 'Speeding', '///') === path.join('X', 'Speeding')
  && F.caseDir('X', 'Speeding', '   ') === path.join('X', 'Speeding'));
check('case uploads', F.caseUploadsDir('X') === path.join('X', 'Uploads'));
check('no-client dir', F.noClientDir(root) === path.join(root, 'No Client'));
check('client letters', F.clientLettersDir('X') === path.join('X', 'Letters'));
check('general letters', F.generalLettersDir(root) === path.join(root, 'General Letters'));
check('blank forms', F.blankFormsDir(root) === path.join(root, 'Blank Forms'));
check('packet dir name capped at 40',
  path.basename(F.packetDir('X', '2026-09-02', 'Appearance, Discovery Demand and Witness List Packet')).length <= 40);

// A standalone letter's folder names its recipient: letters with no client
// all share General Letters/, so "<date> Letter" alone would put two
// recipients' letters in one folder.
check('letter packet dir names the recipient',
  F.letterPacketDir('X', '2026-09-24', 'Alice Anderson', 1) === path.join('X', '2026-09-24 Letter to Alice Anderson'));
check('letter packet dir numbers a second letter with the same name',
  F.letterPacketDir('X', '2026-09-24', 'Alice Anderson', 2) === path.join('X', '2026-09-24 Letter to Alice Anderson (2)'));
check('letter packet dir with no recipient is just "Letter"',
  F.letterPacketDir('X', '2026-09-24', '', 1) === path.join('X', '2026-09-24 Letter'));
check('letter packet dir sanitizes the recipient',
  F.letterPacketDir('X', '2026-09-24', 'A/B: C', 1) === path.join('X', '2026-09-24 Letter to AB C'));
const longLetter = path.basename(F.letterPacketDir('X', '2026-09-24', 'R'.repeat(80), 12));
check('letter packet dir stays within 40 and keeps its number',
  longLetter.length <= F.LIMITS.packet && longLetter.endsWith(' (12)'), longLetter);

// fitPath: full path <= 250, trims the file stem, keeps " v2" and extension
const deep = path.join(root, 'Clients', 'c'.repeat(60), 'd'.repeat(60), 'e'.repeat(40));
const fitted = F.fitPath(deep, '01 - ' + 'f'.repeat(150) + ' - 2026-09-02', ' v2', 'docx');
check('fitPath keeps the full path within 250', fitted.length <= 250, String(fitted.length));
check('fitPath keeps the version suffix and extension', fitted.endsWith(' v2.docx'), fitted);
// The 250 guarantee holds only when the folder leaves room for the stem. With
// capped client/case/packet segments the only unbounded part is the output
// root the user picked; past that, the stem is floored at 20 characters and
// the path is allowed to run long rather than lose the file name.
const hugeRoot = path.join('C:', 'x'.repeat(400));
const overlong = F.fitPath(hugeRoot, 'f'.repeat(100), ' v2', 'docx');
check('fitPath floors the stem at 20 under a very long root',
  overlong === path.join(hugeRoot, 'f'.repeat(20) + ' v2.docx'), String(overlong.length));
const normalDeep = F.fitPath(
  path.join(root, 'Clients', 'c'.repeat(60), 'd'.repeat(60), 'e'.repeat(40)),
  'f'.repeat(200), ' v12', 'docx');
check('fitPath stays within 250 under a normal root with maximal folders',
  normalDeep.length <= F.LIMITS.fullPath, String(normalDeep.length));
check('fitPath leaves a short path alone',
  F.fitPath(path.join('C:', 'a'), 'Doc', '', 'pdf') === path.join('C:', 'a', 'Doc.pdf'));

// ---- toStored / fromStored: locations are stored relative to the root ------
// Checked on BOTH path flavors explicitly, so the Windows rules are proven on
// a Mac and the posix rules on Windows.
{
  const P = path.posix, W = path.win32;
  const pr = '/Users/someone/Documents/Legal Documents';
  const wr = 'C:\\Users\\someone\\Documents\\Legal Documents';
  const rel = 'Clients/Alice Anderson/Speeding (2026-TR-0142)/Uploads';

  // posix
  check('posix: inside the root -> relative with "/"',
    F.toStored(pr, `${pr}/Clients/Alice Anderson/Speeding (2026-TR-0142)/Uploads`, P) === rel);
  check('posix: a trailing slash on the root is fine',
    F.toStored(pr + '/', `${pr}/Clients/Alice Anderson`, P) === 'Clients/Alice Anderson');
  check('posix: the root itself -> "."', F.toStored(pr, pr, P) === '.');
  check('posix: outside the root stays absolute',
    F.toStored(pr, '/Volumes/Backup/Clients/Alice Anderson', P) === '/Volumes/Backup/Clients/Alice Anderson');
  check('posix: a sibling whose name starts like the root stays absolute',
    F.toStored(pr, `${pr} Old/Clients/X`, P) === `${pr} Old/Clients/X`);
  check('posix: a folder named "..x" inside the root is still inside',
    F.toStored(pr, `${pr}/..x/y`, P) === '..x/y');
  check('posix: already-stored values are unchanged (idempotent)', F.toStored(pr, rel, P) === rel);
  check('posix: null and empty pass through', F.toStored(pr, null, P) === null && F.toStored(pr, '', P) === '');
  check('posix: a Windows-absolute value is left alone on a Mac',
    F.toStored(pr, `${wr}\\Clients\\X`, P) === `${wr}\\Clients\\X`);
  check('posix: fromStored joins under the root',
    F.fromStored(pr, rel, P) === `${pr}/Clients/Alice Anderson/Speeding (2026-TR-0142)/Uploads`);
  check('posix: fromStored leaves an absolute value alone',
    F.fromStored(pr, '/Volumes/Backup/x.pdf', P) === '/Volumes/Backup/x.pdf');
  check('posix: fromStored treats a Windows path as absolute (it will not resolve), never joins it under root',
    F.fromStored(pr, 'C:\\Users\\old\\Documents\\Legal Documents\\Clients\\X', P)
      === 'C:\\Users\\old\\Documents\\Legal Documents\\Clients\\X'
    && F.fromStored(pr, '\\\\server\\share\\x.pdf', P) === '\\\\server\\share\\x.pdf');
  check('posix: fromStored("." ) is the root', F.fromStored(pr, '.', P) === pr);
  check('posix: round trip',
    F.fromStored(pr, F.toStored(pr, `${pr}/General Letters/a b.pdf`, P), P) === `${pr}/General Letters/a b.pdf`);

  // win32
  check('win32: inside the root -> relative with "/"',
    F.toStored(wr, `${wr}\\Clients\\Alice Anderson\\Speeding (2026-TR-0142)\\Uploads`, W) === rel);
  check('win32: containment is case-insensitive (keeps the file\'s own case)',
    F.toStored(wr, 'c:\\users\\SOMEONE\\documents\\legal documents\\Clients\\Alice Anderson', W)
      === 'Clients/Alice Anderson');
  check('win32: forward slashes in the absolute value are accepted',
    F.toStored(wr, 'C:/Users/someone/Documents/Legal Documents/Clients/X', W) === 'Clients/X');
  check('win32: another drive stays absolute',
    F.toStored(wr, 'D:\\Legal Documents\\Clients\\X', W) === 'D:\\Legal Documents\\Clients\\X');
  check('win32: outside the root on the same drive stays absolute',
    F.toStored(wr, 'C:\\Users\\someone\\Desktop\\x.pdf', W) === 'C:\\Users\\someone\\Desktop\\x.pdf');
  check('win32: a UNC path outside the root stays absolute',
    F.toStored(wr, '\\\\server\\share\\x.pdf', W) === '\\\\server\\share\\x.pdf');
  check('win32: already-stored values are unchanged (idempotent)', F.toStored(wr, rel, W) === rel);
  check('win32: fromStored joins with backslashes',
    F.fromStored(wr, rel, W) === `${wr}\\Clients\\Alice Anderson\\Speeding (2026-TR-0142)\\Uploads`);
  check('win32: fromStored leaves an absolute value alone',
    F.fromStored(wr, 'D:\\x\\y.pdf', W) === 'D:\\x\\y.pdf');
  check('win32: a posix-absolute value from a Mac is left alone (will not resolve)',
    F.fromStored(wr, '/Users/old/Documents/Legal Documents/x.pdf', W) === '/Users/old/Documents/Legal Documents/x.pdf');
  check('the same stored value resolves under either platform\'s root',
    F.fromStored(pr, rel, P).endsWith('/Speeding (2026-TR-0142)/Uploads')
      && F.fromStored(wr, rel, W).endsWith('\\Speeding (2026-TR-0142)\\Uploads'));
  check('flavorFor picks win32 for a drive or UNC root, posix otherwise',
    F.flavorFor(wr) === W && F.flavorFor('\\\\server\\share') === W && F.flavorFor(pr) === P);
}

// ---- storedTopFolder: which top-level folders the database points into -----
{
  const P = path.posix, W = path.win32;
  check('storedTopFolder: a relative location names its first folder',
    F.storedTopFolder('Clients/Alice Anderson/Speeding (2026-TR-0142)', P) === 'Clients'
    && F.storedTopFolder('General Letters/2026-01-02 Bob', P) === 'General Letters');
  check('storedTopFolder: absolute values (either platform) and the root itself give null',
    F.storedTopFolder('/Volumes/Backup/x.pdf', P) === null
    && F.storedTopFolder('C:\\Legal Documents\\x.pdf', P) === null
    && F.storedTopFolder('D:\\x', W) === null
    && F.storedTopFolder('.', P) === null
    && F.storedTopFolder('', P) === null && F.storedTopFolder(null, P) === null);
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nAll folder checks passed.');
process.exit(failures.length ? 1 : 0);
