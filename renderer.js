// The app runs only under Electron, where preload.js exposes window.api.
// There is deliberately no HTTP fallback: the old one silently swallowed a
// fatal renderer error and made a completely broken app look fine in dev.
const appApi = window.api;

document.addEventListener('DOMContentLoaded', () => {
  const views = ['home', 'matters', 'settings', 'matter-detail', 'generate', 'packet', 'attorneys', 'people', 'person-detail', 'contacts', 'contact-detail', 'courts', 'court-detail', 'matter-fork', 'wizard-doctype', 'letter-new', 'calendar', 'add-documents'];

  // Which forms have been typed into since they were last loaded or saved.
  // Only consulted to decide whether leaving needs to ask first.
  const dirtyForms = new Set();
  const markFormClean = (viewId) => dirtyForms.delete(viewId);
  const isFormDirty = (viewId) => dirtyForms.has(viewId);
  ['view-matter-detail', 'view-letter-new'].forEach(viewId => {
    const view = document.getElementById(viewId);
    if (!view) return;
    const mark = () => dirtyForms.add(viewId);
    view.addEventListener('input', mark);
    view.addEventListener('change', mark);
  });

  function showView(id) {
    // A "person added — open profile" note belongs to the form it was raised
    // on. Leaving that form retires it, so coming back later does not offer to
    // open somebody added ten minutes ago.
    clearPersonAddedNotes();
    // The search box's "Show archived" menu never outlives the screen it was
    // opened on.
    document.getElementById('global-search-menu')?.classList.add('hidden');
    // The documents-folder banner is re-checked on every screen change, so a
    // reconnected drive clears it (and a disconnected one raises it) without
    // a restart.
    refreshRootBanner();
    views.forEach(v => {
      const el = document.getElementById('view-' + v);
      if (el) el.classList.add('hidden');
    });
    document.getElementById('view-' + id).classList.remove('hidden');
    
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    // 'person-detail' belongs to the People tab ('nav-people'), not a
    // same-named 'nav-person' tab that doesn't exist — naive split('-')[0]
    // missed this, so search-to-a-client left no tab highlighted. Courts (and,
    // later, a contact's or a court's own page) belong to the Contacts tab.
    const CONTACTS_VIEWS = ['contacts', 'contact-detail', 'courts', 'court-detail'];
    const tabId = id === 'person-detail' ? 'people'
      : CONTACTS_VIEWS.includes(id) ? 'contacts' : id.split('-')[0];
    const activeTab = document.getElementById('nav-' + tabId);
    if (activeTab) activeTab.classList.add('active');

    // Sub-tab row: only People, Contacts and My Office ('attorneys') have
    // one. Show the matching group, hide the others, and mark which sub-tab
    // within it is active.
    document.querySelectorAll('.sub-tab-group').forEach(g => g.classList.add('hidden'));
    document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    if (tabId === 'people') {
      document.getElementById('sub-tabs-people').classList.remove('hidden');
      document.getElementById('sub-people-clients').classList.add('active');
    } else if (tabId === 'contacts') {
      document.getElementById('sub-tabs-contacts').classList.remove('hidden');
      const sub = id.startsWith('court') ? 'sub-contacts-courts' : 'sub-contacts-contacts';
      document.getElementById(sub).classList.add('active');
    } else if (tabId === 'attorneys') {
      document.getElementById('sub-tabs-attorneys').classList.remove('hidden');
      document.getElementById('sub-attorneys-profile').classList.add('active');
    }

    if (id === 'home') loadHome();
    if (id === 'matters') loadMatters();
    if (id === 'settings') loadSettings();
    if (id === 'attorneys') loadAttorneys();
    if (id === 'contacts') loadContacts();
    if (id === 'courts') loadCourts();
    if (id === 'calendar') loadCalendar();
  }

  document.getElementById('nav-home').addEventListener('click', () => showView('home'));
  document.getElementById('nav-matters').addEventListener('click', () => showView('matters'));
  // The calendar is a top-level tab now. Opened from the tab it is a place of
  // its own, like Matters, so it has no Back button; Home's "View Calendar"
  // link still opens it with Back (to Home), since that is where you came from.
  const openCalendar = (withBack) => {
    document.getElementById('btn-back-from-calendar').classList.toggle('hidden', !withBack);
    showView('calendar');
  };
  document.getElementById('nav-calendar').addEventListener('click', () => openCalendar(false));
  document.getElementById('nav-settings').addEventListener('click', () => showView('settings'));
  document.getElementById('nav-attorneys').addEventListener('click', () => showView('attorneys'));
  document.getElementById('nav-people').addEventListener('click', () => { showView('people'); loadPeople(); });
  document.getElementById('sub-people-clients').addEventListener('click', () => { showView('people'); loadPeople(); });
  document.getElementById('nav-contacts').addEventListener('click', () => showView('contacts'));
  document.getElementById('sub-contacts-contacts').addEventListener('click', () => showView('contacts'));
  document.getElementById('sub-contacts-courts').addEventListener('click', () => showView('courts'));
  document.getElementById('sub-attorneys-profile').addEventListener('click', () => showView('attorneys'));
  document.getElementById('home-new-matter').addEventListener('click', () => showView('matter-fork'));
  // Exactly what the People tab's New Person button does.
  document.getElementById('home-new-client').addEventListener('click', () => openPerson(null));
  document.getElementById('home-view-calendar').addEventListener('click', (e) => { e.preventDefault(); openCalendar(true); });
  document.getElementById('btn-back-from-calendar').addEventListener('click', () => showView('home'));

  showView('home');

  // A12: on-request clickthrough tutorial. Never auto-launches — reachable
  // from Home and the "? Help" button only. Each step names a real element
  // id; the smoke suite asserts every one of these still exists, so a UI
  // rename or removal fails the build instead of silently leaving the tour
  // pointing at nothing.
  const TUTORIAL_STEPS = [
    { view: 'attorneys', id: 'nav-attorneys', title: 'Set up your signing profile',
      text: 'Start here, on the My Office tab: click Add Signing Profile and fill in your name, bar number and firm details. This is what signs your documents.' },
    { view: 'home', id: 'home-new-matter', title: 'Make a matter',
      text: 'Every court filing or letter starts here — pick Court Filing or Letter and fill in the details.' },
    { view: 'matters', id: 'nav-matters', title: 'Generate a document',
      text: 'Open any matter from this list, then click Generate Document to produce a filing.' },
    { view: 'settings', id: 'nav-settings', title: 'Find it on disk',
      text: 'Documents Folder, above, is where everything lands. Each client gets a folder under Clients/ inside it, with a folder for each of their cases.' },
    { view: 'settings', id: 'btn-backup-now', title: 'Back up your data',
      text: 'Your matters and people live only on this computer. Use Back Up Now regularly to save a copy somewhere else.' }
  ];
  let tutorialStep = 0;
  // Exposed so the smoke suite can assert every anchored id still exists,
  // reading the real steps rather than a second, driftable copy of them.
  window.__tutorialSteps = TUTORIAL_STEPS;

  function positionTutorialStep() {
    const step = TUTORIAL_STEPS[tutorialStep];
    const target = document.getElementById(step.id);
    const highlight = document.getElementById('tutorial-highlight');
    const callout = document.getElementById('tutorial-callout');
    if (!target) {
      // The anchored element is gone — this is exactly the drift the smoke
      // suite is meant to catch. Fail visibly rather than draw a highlight
      // over nothing.
      document.getElementById('tutorial-title').textContent = 'This step is out of date';
      document.getElementById('tutorial-text').textContent =
        `Nothing on screen matches "${step.id}" anymore. Close this and report it.`;
      highlight.style.display = 'none';
      callout.style.top = '80px';
      callout.style.left = '80px';
      return;
    }
    highlight.style.display = '';
    const r = target.getBoundingClientRect();
    const pad = 4;
    highlight.style.top = `${r.top - pad}px`;
    highlight.style.left = `${r.left - pad}px`;
    highlight.style.width = `${r.width + pad * 2}px`;
    highlight.style.height = `${r.height + pad * 2}px`;

    document.getElementById('tutorial-step-count').textContent =
      `Step ${tutorialStep + 1} of ${TUTORIAL_STEPS.length}`;
    document.getElementById('tutorial-title').textContent = step.title;
    document.getElementById('tutorial-text').textContent = step.text;

    // Prefer just below the target; flip above if that would run off the
    // bottom of the window, and clamp horizontally to stay on screen.
    const calloutHeight = 140;
    let top = r.bottom + 10;
    if (top + calloutHeight > window.innerHeight) top = Math.max(10, r.top - calloutHeight - 10);
    let left = Math.min(r.left, window.innerWidth - 300);
    left = Math.max(10, left);
    callout.style.top = `${top}px`;
    callout.style.left = `${left}px`;

    document.getElementById('btn-tutorial-prev').disabled = tutorialStep === 0;
    document.getElementById('btn-tutorial-next').textContent =
      tutorialStep === TUTORIAL_STEPS.length - 1 ? 'Done' : 'Next →';
  }

  function goToTutorialStep(i) {
    tutorialStep = i;
    showView(TUTORIAL_STEPS[i].view);
    // Let the view's own render settle (e.g. Settings loads its fieldsets
    // async) before measuring where the target actually landed.
    setTimeout(positionTutorialStep, 50);
  }

  function startTutorial() {
    document.getElementById('tutorial-overlay').classList.remove('hidden');
    goToTutorialStep(0);
  }
  function closeTutorial() {
    document.getElementById('tutorial-overlay').classList.add('hidden');
  }

  document.getElementById('btn-start-tutorial').addEventListener('click', startTutorial);
  document.getElementById('home-start-tutorial').addEventListener('click', (e) => { e.preventDefault(); startTutorial(); });
  document.getElementById('btn-tutorial-close').addEventListener('click', closeTutorial);
  document.getElementById('btn-tutorial-prev').addEventListener('click', () => {
    if (tutorialStep > 0) goToTutorialStep(tutorialStep - 1);
  });
  document.getElementById('btn-tutorial-next').addEventListener('click', () => {
    if (tutorialStep < TUTORIAL_STEPS.length - 1) goToTutorialStep(tutorialStep + 1);
    else closeTutorial();
  });
  window.addEventListener('resize', () => {
    if (!document.getElementById('tutorial-overlay').classList.contains('hidden')) positionTutorialStep();
  });

  // HOME
  // Court dates across every non-archived matter, and matters ordered by
  // last-generated-a-document (falling back to created_at for one that has
  // never generated anything). Read-only rollups — nothing here writes.
  async function loadHome() {
    const setupNote = document.getElementById('home-setup-note');
    const attCount = await appApi.dbGet('SELECT COUNT(*) c FROM attorneys');
    if (attCount.c === 0) {
      setupNote.innerHTML = '';
      setupNote.classList.remove('hidden');
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = 'Set up your signing profile';
      link.addEventListener('click', (e) => { e.preventDefault(); showView('attorneys'); });
      setupNote.append('No signing profile yet. ', link, ' on the My Office tab before generating documents.');
    } else {
      setupNote.classList.add('hidden');
    }

    const today = todayISO();
    const eventRows = await appApi.dbAll(
      `SELECT e.event_type, e.event_date, e.done, m.id AS matter_id, m.short_name
         FROM matter_events e JOIN matters m ON m.id = e.matter_id
        WHERE m.archived = 0`);
    const upcoming = eventRows
      .filter(r => !Number(r.done) && isIsoDate(r.event_date))
      .map(r => ({ ...r, event_date: String(r.event_date).trim() }))
      .map(r => ({ ...r, overdue: r.event_date < today }))
      .sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : 0))
      .slice(0, 8);

    const upEl = document.getElementById('home-upcoming');
    upEl.innerHTML = '';
    if (!upcoming.length) {
      upEl.className = 'home-empty';
      upEl.textContent = 'No upcoming court dates.';
    } else {
      upEl.className = '';
      upcoming.forEach(r => {
        const row = document.createElement('div');
        row.className = 'home-row';
        const left = document.createElement('a');
        left.href = '#';
        left.style.color = '#003399';
        left.textContent = r.short_name;
        left.addEventListener('click', (e) => { e.preventDefault(); openMatter(r.matter_id); });
        const right = document.createElement('span');
        if (r.overdue) right.className = 'overdue';
        right.textContent = `${r.event_type || 'Court date'} — ${r.event_date}${r.overdue ? ' (overdue)' : ''}`;
        row.append(left, right);
        upEl.appendChild(row);
      });
    }

    const recentRows = await appApi.dbAll(
      `SELECT m.id, m.short_name, m.case_number,
              COALESCE((SELECT MAX(gf.created_at) FROM generated_files gf WHERE gf.matter_id = m.id), m.created_at) AS touched_at
         FROM matters m
        WHERE m.archived = 0
        ORDER BY touched_at DESC
        LIMIT 8`);
    const recEl = document.getElementById('home-recent');
    recEl.innerHTML = '';
    if (!recentRows.length) {
      recEl.className = 'home-empty';
      recEl.textContent = 'No matters yet.';
    } else {
      recEl.className = '';
      recentRows.forEach(r => {
        const row = document.createElement('div');
        row.className = 'home-row';
        const left = document.createElement('a');
        left.href = '#';
        left.style.color = '#003399';
        left.textContent = r.short_name;
        left.addEventListener('click', (e) => { e.preventDefault(); openMatter(r.id); });
        const right = document.createElement('span');
        right.style.color = '#555';
        right.textContent = r.case_number || '';
        row.append(left, right);
        recEl.appendChild(row);
      });
    }

    const clientRows = await recentClients(8);
    const rcEl = document.getElementById('home-recent-clients');
    rcEl.innerHTML = '';
    if (!clientRows.length) {
      rcEl.className = 'home-empty';
      rcEl.textContent = 'No clients yet.';
    } else {
      rcEl.className = '';
      clientRows.forEach(r => {
        const row = document.createElement('div');
        row.className = 'home-row';
        const left = document.createElement('a');
        left.href = '#';
        left.style.color = '#003399';
        left.textContent = r.display_name;
        left.addEventListener('click', (e) => { e.preventDefault(); openPerson(r.id); });
        const right = document.createElement('span');
        right.style.color = '#555';
        right.textContent = r.latest_case || '';
        row.append(left, right);
        rcEl.appendChild(row);
      });
    }
  }

  // Recently touched CLIENTS, newest first — Home's third list, and the order
  // of the Add Documents client picker.
  //
  // A client is anyone who is role='client' on some case, or has a scan filed
  // under them; a person who only ever appears as an opposing party or a
  // witness never shows up, however recently they were touched. "Touched" is
  // the newest activity_log row about them: addressed to them directly, or
  // about any case they are a party on (matter-scoped events carry no
  // person_id — see migration 31). A client with no activity yet falls back
  // to when they were created. latest_case is their newest non-archived case
  // as the client, or NULL.
  async function recentClients(limit) {
    return appApi.dbAll(
      `SELECT p.id, p.display_name,
              COALESCE(t.touched_at, p.created_at) AS touched_at,
              (SELECT m.short_name FROM parties pa JOIN matters m ON m.id = pa.matter_id
                WHERE pa.person_id = p.id AND pa.role = 'client' AND m.archived = 0
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS latest_case
         FROM people p
         LEFT JOIN (
           SELECT person_id, MAX(created_at) AS touched_at FROM (
             SELECT person_id, created_at FROM activity_log WHERE person_id IS NOT NULL
             UNION ALL
             SELECT pa.person_id, al.created_at FROM activity_log al
               JOIN parties pa ON pa.matter_id = al.matter_id
              WHERE pa.person_id IS NOT NULL
           ) GROUP BY person_id
         ) t ON t.person_id = p.id
        WHERE p.archived = 0
          AND (EXISTS (SELECT 1 FROM parties pa WHERE pa.person_id = p.id AND pa.role = 'client')
               OR EXISTS (SELECT 1 FROM client_documents cd WHERE cd.person_id = p.id))
        ORDER BY touched_at DESC, p.id DESC
        LIMIT ?`, [limit]);
  }

  // A9: month calendar, read-only over matter_events across every
  // non-archived matter. No notifications, no computed deadlines — this is
  // strictly a different way to look at dates that already exist.
  let calMonth = new Date(); // day-of-month is irrelevant; only Y/M are read

  async function loadCalendar() {
    const year = calMonth.getFullYear();
    const month = calMonth.getMonth(); // 0-based
    const label = document.getElementById('cal-month-label');
    label.textContent = calMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`;
    const rows = await appApi.dbAll(
      `SELECT e.matter_id, e.event_type, e.event_date, e.done, m.short_name
         FROM matter_events e JOIN matters m ON m.id = e.matter_id
        WHERE m.archived = 0 AND e.event_date LIKE ? || '%'`, [monthStr]);
    const byDay = new Map();
    rows.forEach(r => {
      if (!isIsoDate(r.event_date)) return;
      const day = Number(r.event_date.slice(8, 10));
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(r);
    });

    const today = todayISO();
    const firstOfMonth = new Date(year, month, 1);
    const startWeekday = firstOfMonth.getDay(); // 0 = Sunday
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const grid = document.getElementById('cal-grid');
    grid.innerHTML = '';
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d => {
      const h = document.createElement('div');
      h.className = 'cal-dow';
      h.textContent = d;
      grid.appendChild(h);
    });

    const totalCells = Math.ceil((startWeekday + daysInMonth) / 7) * 7;
    for (let i = 0; i < totalCells; i++) {
      const dayNum = i - startWeekday + 1;
      const cell = document.createElement('div');
      const inMonth = dayNum >= 1 && dayNum <= daysInMonth;
      cell.className = 'cal-cell' + (inMonth ? '' : ' cal-outside');
      if (inMonth) {
        const iso = `${monthStr}-${String(dayNum).padStart(2, '0')}`;
        if (iso === today) cell.classList.add('cal-today');
        const num = document.createElement('div');
        num.className = 'cal-daynum';
        num.textContent = String(dayNum);
        cell.appendChild(num);
        (byDay.get(dayNum) || []).forEach(r => {
          const ev = document.createElement('span');
          const overdue = !Number(r.done) && iso < today;
          ev.className = 'cal-event' + (Number(r.done) ? ' cal-done' : overdue ? ' cal-overdue' : '');
          ev.title = `${r.short_name} — ${r.event_type || 'Court date'}`;
          ev.textContent = `${r.short_name}${r.event_type ? ' — ' + r.event_type : ''}`;
          ev.addEventListener('click', () => openMatter(r.matter_id));
          cell.appendChild(ev);
        });
      }
      grid.appendChild(cell);
    }
  }

  document.getElementById('btn-cal-prev').addEventListener('click', () => {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
    loadCalendar();
  });
  document.getElementById('btn-cal-next').addEventListener('click', () => {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
    loadCalendar();
  });
  document.getElementById('btn-cal-today').addEventListener('click', () => {
    calMonth = new Date();
    loadCalendar();
  });

  // The documents-folder banner (#startup-notice). See its markup.
  async function refreshRootBanner() {
    const box = document.getElementById('startup-notice');
    if (!box || !appApi.outputRootStatus) return;
    let text = null;
    try { text = await appApi.outputRootStatus(); } catch { return; }
    document.getElementById('startup-notice-text').textContent = text || '';
    box.classList.toggle('hidden', !text);
  }

  // SETTINGS
  async function loadSettings() {
    const rows = await appApi.dbAll('SELECT key, value FROM settings');
    rows.forEach(r => {
      const el = document.getElementById('set-' + r.key);
      if (el) el.value = r.value;
    });
    await renderMatterTypes();
    await renderLetterheads();
  }

  // The first line of a note, for one-line list cells.
  const firstLine = (text) => String(text || '').split(/\r?\n/)[0];

  // Contacts > Contacts: everyone with is_contact = 1. Works at is the court,
  // else the organization, else the firm typed on the person (opposing
  // counsel). Latest note is the newest dated note, first line only.
  //
  // contactsListSeq is bumped on every load: typing fast in the filter starts
  // overlapping loads, and only the newest may paint (two would double rows).
  let contactsListSeq = 0;
  async function loadContacts() {
    const seq = ++contactsListSeq;
    const term = (document.getElementById('contacts-search').value || '').trim().toLowerCase();
    const showArchived = document.getElementById('contacts-show-archived').checked;
    const rows = await appApi.dbAll(
      `SELECT p.id, p.display_name, p.contact_role, p.archived,
              COALESCE(c.name, o.display_name, p.firm_name) AS works_at
         FROM people p
         LEFT JOIN courts c ON c.id = p.works_at_court_id
         LEFT JOIN people o ON o.id = p.works_at_org_id
        WHERE p.is_contact = 1 ${showArchived ? '' : 'AND p.archived = 0'}
        ORDER BY p.display_name COLLATE NOCASE`);
    const filtered = rows.filter(r => !term ||
      [r.display_name, r.contact_role, r.works_at].some(v => (v || '').toLowerCase().includes(term)));
    // One query for every listed contact; latestNotes is the one definition
    // of "latest", shared with the case box.
    const latest = await latestNotes('person_id', filtered.map(r => r.id));
    if (seq !== contactsListSeq) return;
    const list = document.getElementById('contacts-list');
    list.innerHTML = '';
    if (!filtered.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.style.color = '#666';
      td.textContent = term ? 'No contacts match that filter.' : 'No contacts yet.';
      tr.appendChild(td);
      list.appendChild(tr);
      return;
    }
    filtered.forEach((r) => {
      const tr = document.createElement('tr');
      const cell = (text) => { const td = document.createElement('td'); td.textContent = text || ''; return td; };
      const note = cell(latest.has(r.id) ? firstLine(latest.get(r.id).body) : '');
      note.style.color = '#555';
      tr.append(cell(r.display_name + (r.archived ? '  (archived)' : '')), cell(r.contact_role), cell(r.works_at), note);
      tr.addEventListener('click', () => openContact(r.id));
      list.appendChild(tr);
    });
  }

  // Contacts > Courts: the list. A row opens that court's page.
  //
  // courtsListSeq, as contactsListSeq: only the newest load may paint.
  let courtsListSeq = 0;
  async function loadCourts() {
    const seq = ++courtsListSeq;
    const term = (document.getElementById('courts-search').value || '').trim().toLowerCase();
    const showArchived = document.getElementById('courts-show-archived').checked;
    const rows = await appApi.dbAll(
      `SELECT c.id, c.name, c.city, c.county, c.archived,
              (SELECT COUNT(*) FROM people p
                WHERE p.works_at_court_id = c.id AND p.is_contact = 1 AND p.archived = 0) AS people_count,
              (SELECT COUNT(*) FROM matters m WHERE m.court_id = c.id) AS case_count
         FROM courts c
        ${showArchived ? '' : 'WHERE c.archived = 0'}
        ORDER BY c.name COLLATE NOCASE`);
    if (seq !== courtsListSeq) return;
    const list = document.getElementById('courts-list');
    list.innerHTML = '';
    const filtered = rows.filter(r => !term ||
      [r.name, r.city, r.county].some(v => (v || '').toLowerCase().includes(term)));
    if (!filtered.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.style.color = '#666';
      td.textContent = term ? 'No courts match that filter.' : 'No courts yet. They are added as you type them into a case.';
      tr.appendChild(td);
      list.appendChild(tr);
      return;
    }
    for (const r of filtered) {
      const tr = document.createElement('tr');
      const cell = (text, right) => {
        const td = document.createElement('td');
        td.textContent = text == null ? '' : String(text);
        if (right) td.style.textAlign = 'right';
        return td;
      };
      tr.append(cell(r.name + (r.archived ? '  (archived)' : '')), cell(r.city), cell(r.county),
        cell(r.people_count, true), cell(r.case_count, true));
      tr.addEventListener('click', () => openCourt(r.id));
      list.appendChild(tr);
    }
  }

  document.getElementById('contacts-search').addEventListener('input', loadContacts);
  document.getElementById('contacts-show-archived').addEventListener('change', loadContacts);
  document.getElementById('btn-new-contact').addEventListener('click', () => openContact(null));
  document.getElementById('btn-new-court').addEventListener('click', () => openCourt(null));
  document.getElementById('courts-search').addEventListener('input', loadCourts);
  document.getElementById('courts-show-archived').addEventListener('change', loadCourts);

  // --- One name for a judge --------------------------------------------------
  // judges.name is what captions print ("Hon. <name>", joined live), and the
  // judge's contact is a people row linked by judges.person_id. Both rows are
  // always written in ONE transaction, so the two can never disagree: a judge
  // typed on a case is created here; renaming and archiving happen on the
  // judge's contact page (writeContact, btn-archive-contact). Migration 37
  // gave every earlier judge a contact, archived ones included, so every
  // judge is reachable from Contacts (Show archived for a retired one).
  const JUDGE_CONTACT_SQL =
    `INSERT INTO people (display_name, kind, is_contact, contact_role, works_at_court_id, archived, created_at)
     VALUES (?, 'individual', 1, 'Judge', ?, ?, ?)`;

  async function createJudgeWithContact(name, courtId) {
    const { ids } = await appApi.dbTransaction([
      { sql: JUDGE_CONTACT_SQL, params: [name, courtId || null, 0, new Date().toISOString()] },
      { sql: 'INSERT INTO judges (name, court_id, person_id) VALUES (?, ?, last_insert_rowid())',
        params: [name, courtId || null] }
    ]);
    return { personId: ids[0], judgeId: ids[1] };
  }

  // --- Dated notes, on a contact or a court ----------------------------------
  // contact_notes rows belong to exactly one of a person or a court (a CHECK
  // enforces it). Newest first by note_date, then by id, so two notes on the
  // same day keep the order they were written in. Notes live in the app only:
  // nothing here is, or may ever be, read by either document renderer.
  function noteOwner(owner) {
    const personId = Number(owner && owner.personId) || null;
    const courtId = Number(owner && owner.courtId) || null;
    if (personId && courtId) throw new Error('A note belongs to a person or a court, not both.');
    if (personId) return { col: 'person_id', id: personId };
    if (courtId) return { col: 'court_id', id: courtId };
    return null;
  }

  // The one definition of "latest note", shared by the Contacts list, the
  // court page and the case screen. latestNotesFor answers for many owners of
  // both kinds in ONE query: { person_id: Map, court_id: Map }, each a Map of
  // owner id -> { note_date, body }. latestNotes is its one-kind form and
  // latestNote its one-owner form ({ note_date, body } or null).
  async function latestNotesFor(owners) {
    const out = { person_id: new Map(), court_id: new Map() };
    const wanted = {};
    for (const col of Object.keys(owners || {})) {
      if (col !== 'person_id' && col !== 'court_id') throw new Error('Notes belong to a person or a court.');
      const ids = [...new Set((owners[col] || []).map(Number).filter(Boolean))];
      if (ids.length) wanted[col] = ids;
    }
    const cols = Object.keys(wanted);
    if (!cols.length) return out;
    // A note has exactly one owner set, so (person_id, court_id) partitions
    // by owner across both kinds at once.
    const where = cols.map(c => `${c} IN (${wanted[c].map(() => '?').join(', ')})`).join(' OR ');
    const rows = await appApi.dbAll(
      `SELECT person_id, court_id, note_date, body FROM (
         SELECT person_id, court_id, note_date, body,
                ROW_NUMBER() OVER (PARTITION BY person_id, court_id ORDER BY note_date DESC, id DESC) AS rn
           FROM contact_notes WHERE ${where})
        WHERE rn = 1`, cols.flatMap(c => wanted[c]));
    for (const r of rows) {
      const note = { note_date: r.note_date, body: r.body };
      if (r.person_id && wanted.person_id) out.person_id.set(r.person_id, note);
      else if (r.court_id && wanted.court_id) out.court_id.set(r.court_id, note);
    }
    return out;
  }

  async function latestNotes(col, ids) {
    if (col !== 'person_id' && col !== 'court_id') throw new Error('Notes belong to a person or a court.');
    return (await latestNotesFor({ [col]: ids }))[col];
  }

  async function latestNote(owner) {
    const o = noteOwner(owner);
    if (!o) return null;
    return (await latestNotes(o.col, [o.id])).get(o.id) || null;
  }
  window.latestNote = (owner) => latestNote(owner);

  // One render per element at a time: a load that finishes after the element
  // has moved on to another contact or court does not paint over it.
  const notesSeq = new WeakMap();

  async function renderNotes(el, owner) {
    const o = noteOwner(owner);
    const seq = (notesSeq.get(el) || 0) + 1;
    notesSeq.set(el, seq);
    el.dataset.notesFor = o ? `${o.col}:${o.id}` : '';
    if (!o) {
      el.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'home-empty';
      const what = owner && 'courtId' in owner ? 'court' : 'contact';
      empty.textContent = `Save this ${what} first, then add notes to it.`;
      el.appendChild(empty);
      return;
    }
    const notes = await appApi.dbAll(
      `SELECT id, note_date, body FROM contact_notes WHERE ${o.col} = ?
        ORDER BY note_date DESC, id DESC`, [o.id]);
    if (notesSeq.get(el) !== seq) return;
    el.innerHTML = '';
    const again = () => renderNotes(el, owner);
    const stillHere = () => el.dataset.notesFor === `${o.col}:${o.id}`;

    const list = document.createElement('div');
    list.className = 'notes-list';
    if (!notes.length) {
      const empty = document.createElement('div');
      empty.className = 'home-empty';
      empty.textContent = 'No notes yet.';
      list.appendChild(empty);
    }
    for (const n of notes) {
      const row = document.createElement('div');
      row.className = 'home-row';
      row.dataset.noteId = String(n.id);
      const date = document.createElement('span');
      date.className = 'note-date';
      date.textContent = n.note_date;
      const body = document.createElement('span');
      body.className = 'note-body';
      body.textContent = n.body;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        const ok = confirm(`Delete the note from ${n.note_date}?\n\n"${firstLine(n.body)}"\n\nThis cannot be undone.`);
        if (!ok) return;
        await appApi.dbRun('DELETE FROM contact_notes WHERE id = ?', [n.id]);
        if (stillHere()) await again();
      });
      row.append(date, body, del);
      list.appendChild(row);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.textContent = '+ Add note';
    addBtn.dataset.notesAdd = '';

    const form = document.createElement('div');
    form.className = 'notes-add hidden';
    const dateIn = document.createElement('input');
    dateIn.type = 'date';
    dateIn.value = todayISO();
    const text = document.createElement('textarea');
    text.rows = 3;
    text.placeholder = 'Note';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn primary';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const buttons = document.createElement('div');
    buttons.className = 'notes-add-buttons';
    buttons.append(save, cancel);
    form.append(dateIn, text, buttons);

    addBtn.addEventListener('click', () => {
      addBtn.classList.add('hidden');
      form.classList.remove('hidden');
      text.focus();
    });
    cancel.addEventListener('click', () => {
      text.value = '';
      dateIn.value = todayISO();
      form.classList.add('hidden');
      addBtn.classList.remove('hidden');
    });
    let saving = false;
    save.addEventListener('click', async () => {
      if (saving) return; // a double click saves one note, not two
      // Everything read before the first await; the owner is this render's.
      const noteDate = dateIn.value.trim();
      const noteBody = text.value.replace(/\s+$/, '');
      if (!isIsoDate(noteDate)) { alert('Pick a date for the note.'); dateIn.focus(); return; }
      if (!noteBody.trim()) { alert('Type the note before saving.'); text.focus(); return; }
      saving = true;
      try {
        await appApi.dbRun(
          `INSERT INTO contact_notes (${o.col}, note_date, body, created_at) VALUES (?, ?, ?, ?)`,
          [o.id, noteDate, noteBody, new Date().toISOString()]);
      } finally {
        saving = false;
      }
      if (stillHere()) await again();
    });

    el.append(list, addBtn, form);
  }
  window.renderNotes = (el, owner) => renderNotes(el, owner);

  // --- Connected to: person-to-person links ---------------------------------
  // One contact_links row per pair, read from either end: the page shows the
  // OTHER person and the row's label ("her clerk"), the same on both pages.
  // The picker offers contacts and organizations only: a link here is for the
  // working web around a case (a judge and her clerk, an adjuster and the
  // insurer). A client's own people (a spouse, a parent) are client-profile
  // data, and every client in the picker would bury the contacts it is for.
  const linksSeq = new WeakMap();

  async function linkCandidates() {
    const rows = await appApi.dbAll(
      `SELECT id, display_name, kind, is_contact, contact_role, city FROM people
        WHERE archived = 0 AND (is_contact = 1 OR kind = 'organization')
          AND TRIM(COALESCE(display_name, '')) <> ''
        ORDER BY display_name COLLATE NOCASE, id`);
    // An organization's city tells two same-named organizations apart, the
    // same way a court's city does in the Works at box; a plain contact has
    // no such need since their role already reads on the line.
    return rows.map(r => {
      const kind = r.contact_role || (r.kind === 'organization' ? 'organization' : 'contact');
      const city = r.kind === 'organization' ? (r.city || '').trim() : '';
      return { id: r.id, name: r.display_name,
        label: city ? `${r.display_name} (${kind}, ${city})` : `${r.display_name} (${kind})` };
    });
  }

  async function renderContactLinks(el, personId) {
    const seq = (linksSeq.get(el) || 0) + 1;
    linksSeq.set(el, seq);
    el.dataset.linksFor = personId ? String(personId) : '';
    if (!personId) {
      el.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'home-empty';
      empty.textContent = 'Save this contact first, then connect it to other contacts.';
      el.appendChild(empty);
      return;
    }
    const links = await appApi.dbAll(
      `SELECT l.id, l.label, o.id AS other_id, o.display_name, o.is_contact, o.archived
         FROM contact_links l
         JOIN people o ON o.id = CASE WHEN l.a_person_id = ? THEN l.b_person_id ELSE l.a_person_id END
        WHERE l.a_person_id = ? OR l.b_person_id = ?
        ORDER BY o.display_name COLLATE NOCASE, l.id`, [personId, personId, personId]);
    if (linksSeq.get(el) !== seq) return;
    el.innerHTML = '';
    const again = () => renderContactLinks(el, personId);
    const stillHere = () => el.dataset.linksFor === String(personId);

    const list = document.createElement('div');
    list.className = 'links-list';
    if (!links.length) {
      const empty = document.createElement('div');
      empty.className = 'home-empty';
      empty.textContent = 'Not connected to anyone yet.';
      list.appendChild(empty);
    }
    for (const l of links) {
      const row = document.createElement('div');
      row.className = 'home-row';
      row.dataset.linkId = String(l.id);
      const name = document.createElement('a');
      name.href = '#';
      name.style.color = '#003399';
      name.className = 'link-name';
      name.textContent = l.display_name + (l.archived ? '  (archived)' : '');
      // A contact opens their contact page; anyone else (an organization that
      // is a client) opens the client profile.
      name.addEventListener('click', (e) => {
        e.preventDefault();
        if (l.is_contact) openContact(l.other_id); else openPerson(l.other_id);
      });
      const right = document.createElement('span');
      right.className = 'link-right';
      const label = document.createElement('span');
      label.className = 'link-label';
      label.textContent = l.label || '';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn';
      del.textContent = 'Remove';
      del.addEventListener('click', async () => {
        const ok = confirm(`Remove the connection to ${l.display_name}${l.label ? ` ("${l.label}")` : ''}?\n\n` +
          'Both contacts stay; only the connection is removed, from both pages.');
        if (!ok) return;
        await appApi.dbRun('DELETE FROM contact_links WHERE id = ?', [l.id]);
        if (stillHere()) await again();
      });
      right.append(label, del);
      row.append(name, right);
      list.appendChild(row);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.textContent = '+ Connect';
    addBtn.dataset.linksAdd = '';

    const form = document.createElement('div');
    form.className = 'notes-add links-add hidden';
    const combo = document.createElement('div');
    combo.className = 'combobox-wrapper';
    const who = document.createElement('input');
    who.type = 'text';
    who.placeholder = 'A contact or an organization...';
    who.className = 'link-who';
    const whoId = document.createElement('input');
    whoId.type = 'hidden';
    const drop = document.createElement('ul');
    drop.className = 'combobox-dropdown hidden';
    combo.append(who, whoId, drop);
    const labelIn = document.createElement('input');
    labelIn.type = 'text';
    labelIn.className = 'link-label-input';
    labelIn.placeholder = 'How they are connected, e.g. her clerk';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn primary';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const buttons = document.createElement('div');
    buttons.className = 'notes-add-buttons';
    buttons.append(save, cancel);
    form.append(combo, labelIn, buttons);

    async function refresh() {
      const term = who.value.trim().toLowerCase();
      const options = (await linkCandidates()).filter(o => o.id !== personId);
      drop.innerHTML = '';
      options.filter(o => !term || o.label.toLowerCase().includes(term)).slice(0, 50).forEach(o => {
        const li = document.createElement('li');
        li.textContent = o.label;
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          who.value = o.name;
          whoId.value = String(o.id);
          drop.classList.add('hidden');
        });
        drop.appendChild(li);
      });
      drop.classList.toggle('hidden', !drop.children.length);
    }
    who.addEventListener('focus', refresh);
    who.addEventListener('input', () => { whoId.value = ''; refresh(); });
    who.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));

    addBtn.addEventListener('click', () => {
      addBtn.classList.add('hidden');
      form.classList.remove('hidden');
      who.focus();
    });
    const close = () => {
      who.value = '';
      whoId.value = '';
      labelIn.value = '';
      form.classList.add('hidden');
      addBtn.classList.remove('hidden');
    };
    cancel.addEventListener('click', close);

    let saving = false;
    const doSave = async () => {
      if (saving) return; // a double click saves one link, not two
      // Everything read before the first await; the person is this render's.
      const typed = who.value.trim();
      let otherId = Number(whoId.value) || null;
      const linkLabel = labelIn.value.trim() || null;
      if (!typed && !otherId) { alert('Pick who this contact is connected to.'); who.focus(); return; }
      saving = true;
      save.disabled = true;
      try {
        // Typed but not picked: take an exact match (name or list label). The
        // page's own person is in this list on purpose, so typing their own
        // name gets the self-link message rather than "not found".
        if (!otherId) {
          const t = typed.toLowerCase();
          const options = await linkCandidates();
          const byLabel = options.filter(o => o.label.toLowerCase() === t);
          const match = byLabel.length ? byLabel : options.filter(o => o.name.toLowerCase() === t);
          if (match.length > 1) { alert(`More than one contact is called "${typed}". Pick the right one from the list.`); return; }
          if (match.length !== 1) { alert(`Pick who this contact is connected to from the list. "${typed}" is not a contact or an organization.`); return; }
          otherId = match[0].id;
        }
        if (otherId === personId) { alert('A contact cannot be connected to themselves. Pick someone else.'); return; }
        // One statement, so a second save racing this one cannot slip a
        // duplicate in between a check and an insert. Either order counts.
        const res = await appApi.dbRun(
          `INSERT INTO contact_links (a_person_id, b_person_id, label, created_at)
           SELECT ?, ?, ?, ? WHERE ? <> ? AND NOT EXISTS (
             SELECT 1 FROM contact_links
              WHERE (a_person_id = ? AND b_person_id = ?) OR (a_person_id = ? AND b_person_id = ?))`,
          [personId, otherId, linkLabel, new Date().toISOString(), personId, otherId,
           personId, otherId, otherId, personId]);
        if (!res || !res.changes) {
          const other = await appApi.dbGet('SELECT display_name FROM people WHERE id = ?', [otherId]);
          alert(`This contact is already connected to ${(other && other.display_name) || 'them'}. ` +
            'Remove the existing connection first to change its label.');
          return;
        }
      } finally {
        saving = false;
        save.disabled = false;
      }
      if (stillHere()) await again();
    };
    save.addEventListener('click', doSave);
    labelIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doSave(); }
      if (e.key === 'Escape') close();
    });

    el.append(list, addBtn, form);
  }
  window.renderContactLinks = (el, personId) => renderContactLinks(el, personId);

  // --- Contact page: Cases -----------------------------------------------
  // Union of cases where this contact is the judge, the opposing counsel, or
  // added by hand (matter_contacts). Priority when more than one applies:
  // Judge, then Opposing counsel, then the matter_contacts label.
  async function contactCasesRows(personId) {
    const [judgeCases, ocCases, manual] = await Promise.all([
      appApi.dbAll(
        `SELECT m.id, m.short_name, m.case_number, m.archived FROM matters m
           JOIN judges j ON j.id = m.judge_id
          WHERE j.person_id = ?`, [personId]),
      appApi.dbAll(
        `SELECT id, short_name, case_number, archived FROM matters
          WHERE opposing_counsel_person_id = ?`, [personId]),
      appApi.dbAll(
        `SELECT m.id, m.short_name, m.case_number, m.archived, mc.label
           FROM matter_contacts mc JOIN matters m ON m.id = mc.matter_id
          WHERE mc.person_id = ? ORDER BY mc.sort_order, mc.id`, [personId]),
    ]);
    const rows = [];
    const seen = new Set();
    judgeCases.forEach(m => { seen.add(m.id); rows.push({ ...m, how: 'Judge' }); });
    ocCases.forEach(m => { if (seen.has(m.id)) return; seen.add(m.id); rows.push({ ...m, how: 'Opposing counsel' }); });
    manual.forEach(m => { if (seen.has(m.id)) return; seen.add(m.id); rows.push({ ...m, how: m.label || 'Contact' }); });
    rows.sort((a, b) => (a.archived - b.archived) ||
      String(a.short_name || '').localeCompare(String(b.short_name || '')) || a.id - b.id);
    return rows;
  }

  async function matterCandidates() {
    const rows = await appApi.dbAll(
      'SELECT id, short_name, case_number FROM matters WHERE archived = 0 ORDER BY short_name COLLATE NOCASE, id');
    return rows.map(m => {
      const name = m.short_name || `Matter ${m.id}`;
      return { id: m.id, name, label: m.case_number ? `${name} (${m.case_number})` : name };
    });
  }

  async function renderContactCases(el, personId) {
    el.innerHTML = '';
    if (!personId) {
      courtPageEmpty(el, 'Save this contact first, then add them to a case.');
      return;
    }
    const rows = await contactCasesRows(personId);
    const list = document.createElement('div');
    list.className = 'links-list';
    if (!rows.length) courtPageEmpty(list, 'Not on any case yet.');
    rows.forEach(m => {
      list.appendChild(courtPageRow(
        (m.short_name || `Matter ${m.id}`) + (m.archived ? '  (archived)' : ''),
        () => openMatter(m.id),
        [m.case_number, m.how]));
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.textContent = '+ Add to case';
    addBtn.dataset.caseAdd = '';

    const form = document.createElement('div');
    form.className = 'notes-add links-add case-add hidden';
    const combo = document.createElement('div');
    combo.className = 'combobox-wrapper';
    const caseIn = document.createElement('input');
    caseIn.type = 'text';
    caseIn.placeholder = 'A case...';
    caseIn.className = 'link-who case-who';
    const caseId = document.createElement('input');
    caseId.type = 'hidden';
    const drop = document.createElement('ul');
    drop.className = 'combobox-dropdown hidden';
    combo.append(caseIn, caseId, drop);
    const labelIn = document.createElement('input');
    labelIn.type = 'text';
    labelIn.className = 'link-label-input';
    labelIn.placeholder = 'Role on this case (optional), e.g. assigned probation officer';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn primary';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const buttons = document.createElement('div');
    buttons.className = 'notes-add-buttons';
    buttons.append(save, cancel);
    form.append(combo, labelIn, buttons);

    async function refresh() {
      const term = caseIn.value.trim().toLowerCase();
      const options = await matterCandidates();
      drop.innerHTML = '';
      options.filter(o => !term || o.label.toLowerCase().includes(term)).slice(0, 50).forEach(o => {
        const li = document.createElement('li');
        li.textContent = o.label;
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          caseIn.value = o.label;
          caseId.value = String(o.id);
          drop.classList.add('hidden');
        });
        drop.appendChild(li);
      });
      drop.classList.toggle('hidden', !drop.children.length);
    }
    caseIn.addEventListener('focus', refresh);
    caseIn.addEventListener('input', () => { caseId.value = ''; refresh(); });
    caseIn.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));

    addBtn.addEventListener('click', () => {
      addBtn.classList.add('hidden');
      form.classList.remove('hidden');
      caseIn.focus();
    });
    const close = () => {
      caseIn.value = '';
      caseId.value = '';
      labelIn.value = '';
      form.classList.add('hidden');
      addBtn.classList.remove('hidden');
    };
    cancel.addEventListener('click', close);

    let saving = false;
    const doSave = async () => {
      if (saving) return; // a double click adds one row, not two
      // Everything read before the first await; the contact is this render's.
      const typed = caseIn.value.trim();
      let matterId = Number(caseId.value) || null;
      const caseLabel = labelIn.value.trim() || null;
      if (!typed && !matterId) { alert('Pick a case.'); caseIn.focus(); return; }
      saving = true;
      save.disabled = true;
      try {
        if (!matterId) {
          const t = typed.toLowerCase();
          const options = await matterCandidates();
          const byLabel = options.filter(o => o.label.toLowerCase() === t);
          const match = byLabel.length ? byLabel : options.filter(o => o.name.toLowerCase() === t);
          if (match.length > 1) { alert(`More than one case matches "${typed}". Pick the right one from the list.`); return; }
          if (match.length !== 1) { alert(`"${typed}" is not a case. Pick one from the list.`); return; }
          matterId = match[0].id;
        }
        // Already involved on that case in any way (judge, opposing counsel,
        // or a prior matter_contacts row)?
        const already = (await contactCasesRows(personId)).find(r => r.id === matterId);
        if (already) {
          alert(`This contact is already on that case (${already.how}).`);
          return;
        }
        // One statement: a second save racing this one cannot add the same
        // contact to the same case twice.
        await appApi.dbRun(
          `INSERT INTO matter_contacts (matter_id, person_id, label, sort_order, created_at)
           SELECT ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM matter_contacts WHERE matter_id = ?), ?
            WHERE NOT EXISTS (SELECT 1 FROM matter_contacts WHERE matter_id = ? AND person_id = ?)`,
          [matterId, personId, caseLabel, matterId, new Date().toISOString(), matterId, personId]);
      } finally {
        saving = false;
        save.disabled = false;
      }
      if (document.getElementById('con-id').value === String(personId)) await renderContactCases(el, personId);
    };
    save.addEventListener('click', doSave);
    labelIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doSave(); }
      if (e.key === 'Escape') close();
    });

    el.append(list, addBtn, form);
  }
  window.renderContactCases = (el, personId) => renderContactCases(el, personId);

  // --- Who's involved: the case screen's box ----------------------------------
  // Auto rows from the case itself (its court, judge and opposing counsel),
  // then the people added to this case by hand (matter_contacts), each with
  // its latest note on one line. The notes are for the office: they are read
  // here, straight into the DOM, and never into anything a renderer sees.
  // Bumped on every render, so a load that finishes after another case has
  // been opened does not paint over it.
  let whoSeq = 0;

  async function contactCandidates() {
    const rows = await appApi.dbAll(
      `SELECT id, display_name, contact_role FROM people
        WHERE archived = 0 AND is_contact = 1 AND TRIM(COALESCE(display_name, '')) <> ''
        ORDER BY display_name COLLATE NOCASE, id`);
    return rows.map(r => ({ id: r.id, name: r.display_name,
      label: r.contact_role ? `${r.display_name} (${r.contact_role})` : r.display_name }));
  }

  // The case's own court / judge / opposing counsel, as they are saved. The
  // judge links to their contact (judges.person_id); a judge row somehow
  // without one still shows, unlinked.
  async function whosInvolvedRows(matterId) {
    const [auto, manual] = await Promise.all([
      appApi.dbGet(
        `SELECT m.court_id, c.name AS court_name,
                j.id AS judge_id, j.name AS judge_name, j.person_id AS judge_person_id,
                jp.archived AS judge_archived,
                oc.id AS oc_id, oc.display_name AS oc_name, oc.is_contact AS oc_is_contact, oc.archived AS oc_archived
           FROM matters m
           LEFT JOIN courts c ON c.id = m.court_id
           LEFT JOIN judges j ON j.id = m.judge_id
           LEFT JOIN people jp ON jp.id = j.person_id
           LEFT JOIN people oc ON oc.id = m.opposing_counsel_person_id
          WHERE m.id = ?`, [matterId]),
      appApi.dbAll(
        `SELECT mc.id AS link_id, mc.label, p.id, p.display_name, p.contact_role, p.is_contact, p.archived
           FROM matter_contacts mc JOIN people p ON p.id = mc.person_id
          WHERE mc.matter_id = ? ORDER BY mc.sort_order, mc.id`, [matterId]),
    ]);
    const rows = [];
    if (auto && auto.court_id && auto.court_name) {
      rows.push({ kind: 'court', id: auto.court_id, name: auto.court_name, role: 'Court' });
    }
    if (auto && auto.judge_id && auto.judge_name) {
      rows.push({ kind: 'person', id: auto.judge_person_id || null, name: auto.judge_name, role: 'Judge',
        isContact: 1, archived: auto.judge_archived });
    }
    if (auto && auto.oc_id) {
      rows.push({ kind: 'person', id: auto.oc_id, name: auto.oc_name, role: 'Opposing counsel',
        isContact: auto.oc_is_contact, archived: auto.oc_archived });
    }
    // A manual row that repeats someone already shown (the judge, opposing
    // counsel, or an earlier manual row) is not shown twice.
    const seen = new Set(rows.filter(r => r.kind === 'person' && r.id).map(r => r.id));
    for (const m of manual) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      rows.push({ kind: 'person', id: m.id, name: m.display_name, role: m.label || m.contact_role || '',
        isContact: m.is_contact, archived: m.archived, linkId: m.link_id });
    }
    return rows;
  }

  async function renderWhosInvolved(el, matterId) {
    const seq = ++whoSeq;
    // Another case's rows never stay on screen while this one loads.
    if (el.dataset.whoFor !== String(matterId || '')) el.innerHTML = '';
    el.dataset.whoFor = matterId ? String(matterId) : '';
    if (!matterId) {
      el.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'home-empty';
      empty.textContent = 'Save this case first, then add who is involved.';
      el.appendChild(empty);
      return;
    }
    const rows = await whosInvolvedRows(matterId);
    const latest = await latestNotesFor({
      person_id: rows.filter(r => r.kind === 'person').map(r => r.id),
      court_id: rows.filter(r => r.kind === 'court').map(r => r.id),
    });
    if (seq !== whoSeq || el.dataset.whoFor !== String(matterId)) return;
    el.innerHTML = '';
    const again = () => renderWhosInvolved(el, matterId);
    const stillHere = () => el.dataset.whoFor === String(matterId);

    const list = document.createElement('div');
    list.className = 'links-list who-list';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'home-empty';
      empty.textContent = 'No court, judge or contacts on this case yet.';
      list.appendChild(empty);
    }
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'home-row';
      row.dataset.whoKind = r.linkId ? 'added' : (r.kind === 'court' ? 'court' : r.role === 'Judge' ? 'judge' : 'opposing');
      const left = document.createElement('span');
      left.className = 'who-left';
      const nameText = r.name + (r.archived ? '  (archived)' : '');
      let name;
      if (r.id) {
        name = document.createElement('a');
        name.href = '#';
        name.style.color = '#003399';
        name.addEventListener('click', (e) => {
          e.preventDefault();
          if (r.kind === 'court') openCourt(r.id);
          else if (r.isContact) openContact(r.id);
          else openPerson(r.id);
        });
      } else {
        name = document.createElement('span');
      }
      name.className = 'who-name';
      name.textContent = nameText;
      // The side column is narrow: the role sits under the name, the note
      // under that, and only Remove on the right.
      const role = document.createElement('span');
      role.className = 'who-role';
      role.textContent = r.role;
      left.append(name, role);
      const n = (r.kind === 'court' ? latest.court_id : latest.person_id).get(r.id);
      if (n) {
        const note = document.createElement('span');
        note.className = 'who-note';
        note.textContent = `${n.note_date}  ${firstLine(n.body)}`;
        note.title = n.body;
        left.appendChild(note);
      }
      const right = document.createElement('span');
      right.className = 'link-right';
      if (r.linkId) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn';
        del.textContent = 'Remove';
        let removing = false;
        del.addEventListener('click', async () => {
          if (removing) return;
          const ok = confirm(`Remove ${r.name} from this case?\n\n` +
            'They stay in Contacts, with their notes; only their place on this case is removed.');
          if (!ok) return;
          removing = true;
          del.disabled = true;
          try {
            await appApi.dbRun('DELETE FROM matter_contacts WHERE id = ?', [r.linkId]);
          } finally {
            removing = false;
            del.disabled = false;
          }
          if (stillHere()) await again();
        });
        right.appendChild(del);
      }
      row.append(left, right);
      list.appendChild(row);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.textContent = '+ Add contact';
    addBtn.dataset.whoAdd = '';

    const form = document.createElement('div');
    form.className = 'notes-add links-add who-add hidden';
    const combo = document.createElement('div');
    combo.className = 'combobox-wrapper';
    const who = document.createElement('input');
    who.type = 'text';
    who.placeholder = 'A contact, or type a new name...';
    who.className = 'who-who';
    const whoId = document.createElement('input');
    whoId.type = 'hidden';
    const drop = document.createElement('ul');
    drop.className = 'combobox-dropdown hidden';
    combo.append(who, whoId, drop);
    // Shown only for a new contact: the role they are saved with.
    const roleSel = document.createElement('select');
    roleSel.className = 'who-role-select hidden';
    const labelIn = document.createElement('input');
    labelIn.type = 'text';
    labelIn.className = 'who-label-input';
    labelIn.placeholder = 'Role on this case (optional), e.g. assigned probation officer';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn primary';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const buttons = document.createElement('div');
    buttons.className = 'notes-add-buttons';
    buttons.append(save, cancel);
    form.append(combo, roleSel, labelIn, buttons);

    let newName = null;
    const setNew = (nm) => {
      newName = nm;
      roleSel.classList.toggle('hidden', !nm);
    };
    async function fillRoles() {
      const roles = await appApi.dbAll('SELECT name FROM contact_roles ORDER BY sort_order, name COLLATE NOCASE');
      roleSel.innerHTML = '';
      roleSel.appendChild(new Option('Role...', ''));
      roles.forEach(x => roleSel.appendChild(new Option(x.name, x.name)));
    }

    async function refresh() {
      const typed = who.value.trim();
      const term = typed.toLowerCase();
      const options = await contactCandidates();
      drop.innerHTML = '';
      const matches = options.filter(o => !term || o.label.toLowerCase().includes(term)).slice(0, 50);
      matches.forEach(o => {
        const li = document.createElement('li');
        li.textContent = o.label;
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          who.value = o.name;
          whoId.value = String(o.id);
          setNew(null);
          drop.classList.add('hidden');
        });
        drop.appendChild(li);
      });
      if (typed && !options.some(o => o.name.toLowerCase() === term)) {
        const li = document.createElement('li');
        li.className = 'add-new';
        li.textContent = `+ Add "${typed}" as a new contact`;
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          whoId.value = '';
          setNew(typed);
          drop.classList.add('hidden');
          roleSel.focus();
        });
        drop.appendChild(li);
      }
      drop.classList.toggle('hidden', !drop.children.length);
    }
    who.addEventListener('focus', refresh);
    who.addEventListener('input', () => { whoId.value = ''; setNew(null); refresh(); });
    who.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));

    addBtn.addEventListener('click', async () => {
      addBtn.classList.add('hidden');
      form.classList.remove('hidden');
      await fillRoles();
      who.focus();
    });
    const close = () => {
      who.value = '';
      whoId.value = '';
      labelIn.value = '';
      setNew(null);
      form.classList.add('hidden');
      addBtn.classList.remove('hidden');
    };
    cancel.addEventListener('click', close);

    let saving = false;
    const doSave = async () => {
      if (saving) return; // a double click adds one row, not two
      // Everything read before the first await; the case is this render's.
      const typed = who.value.trim();
      let personId = Number(whoId.value) || null;
      const creating = !personId && newName && newName === typed ? newName : null;
      const newRole = roleSel.value || null;
      const caseLabel = labelIn.value.trim() || null;
      if (!typed && !personId) { alert('Pick a contact, or type a new name.'); who.focus(); return; }
      if (creating && !newRole) { alert(`Pick a role for ${creating}.`); roleSel.focus(); return; }
      saving = true;
      save.disabled = true;
      try {
        if (!personId && !creating) {
          const t = typed.toLowerCase();
          const options = await contactCandidates();
          const byLabel = options.filter(o => o.label.toLowerCase() === t);
          const match = byLabel.length ? byLabel : options.filter(o => o.name.toLowerCase() === t);
          if (match.length > 1) { alert(`More than one contact is called "${typed}". Pick the right one from the list.`); return; }
          if (match.length !== 1) { alert(`"${typed}" is not a contact. Pick one from the list, or choose + Add to make a new contact.`); return; }
          personId = match[0].id;
        }
        if (personId) {
          // Already in the box, as the judge, opposing counsel or an added row.
          const already = (await whosInvolvedRows(matterId)).find(r => r.kind === 'person' && r.id === personId);
          if (already) {
            alert(`${already.name} is already on this case${already.role ? ` (${already.role})` : ''}.`);
            return;
          }
        } else {
          personId = (await appApi.dbRun(
            `INSERT INTO people (display_name, kind, is_contact, contact_role, created_at)
             VALUES (?, 'individual', 1, ?, ?)`, [creating, newRole, new Date().toISOString()])).lastInsertRowid;
        }
        // One statement: a second save racing this one cannot add the same
        // person twice.
        await appApi.dbRun(
          `INSERT INTO matter_contacts (matter_id, person_id, label, sort_order, created_at)
           SELECT ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM matter_contacts WHERE matter_id = ?), ?
            WHERE NOT EXISTS (SELECT 1 FROM matter_contacts WHERE matter_id = ? AND person_id = ?)`,
          [matterId, personId, caseLabel, matterId, new Date().toISOString(), matterId, personId]);
      } finally {
        saving = false;
        save.disabled = false;
      }
      if (stillHere()) await again();
    };
    save.addEventListener('click', doSave);
    labelIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doSave(); }
      if (e.key === 'Escape') close();
    });

    el.append(list, addBtn, form);
  }
  window.renderWhosInvolved = (matterId) => renderWhosInvolved(document.getElementById('matter-who'), matterId);

  // --- The contact page ------------------------------------------------------
  const CONTACT_TEXT_FIELDS = ['display_name', 'phone', 'email', 'street', 'city', 'zip'];
  const ADD_ROLE = '__add_role__';
  // Bumped on every openContact, so a load that finishes after the user has
  // opened another contact does not paint over it.
  let contactSeq = 0;

  async function fillContactRoles(selected) {
    const sel = document.getElementById('con-contact_role');
    const roles = await appApi.dbAll('SELECT name FROM contact_roles ORDER BY sort_order, name COLLATE NOCASE');
    const names = roles.map(r => r.name);
    // A role typed before the pick-list existed still shows, rather than
    // silently becoming blank on the next save.
    if (selected && !names.includes(selected)) names.push(selected);
    sel.innerHTML = '';
    const opt = (value, text) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      sel.appendChild(o);
    };
    opt('', '');
    names.forEach(n => opt(n, n));
    opt(ADD_ROLE, 'Add role…');
    sel.value = selected || '';
    sel.dataset.prev = sel.value;
    document.getElementById('con-role-add').classList.add('hidden');
  }

  async function openContact(id) {
    showView('contact-detail');
    const seq = ++contactSeq;
    document.getElementById('con-id').value = id || '';
    // Links box no longer belongs to the previous contact: a Connect save
    // still in flight for them must not re-render it (renderContactLinks
    // sets it again for this contact).
    document.getElementById('contact-links').dataset.linksFor = '';
    const p = id ? await appApi.dbGet(
      `SELECT p.*, c.name AS court_name, o.display_name AS org_name
         FROM people p
         LEFT JOIN courts c ON c.id = p.works_at_court_id
         LEFT JOIN people o ON o.id = p.works_at_org_id
        WHERE p.id = ?`, [id]) : null;
    if (seq !== contactSeq) return;
    CONTACT_TEXT_FIELDS.forEach(f => { document.getElementById('con-' + f).value = (p && p[f]) || ''; });
    document.getElementById('con-works_at').value = (p && (p.court_name || p.org_name)) || '';
    document.getElementById('con-works_at_court_id').value = (p && p.works_at_court_id) || '';
    document.getElementById('con-works_at_org_id').value = (p && p.works_at_org_id) || '';
    await fillContactRoles(p ? p.contact_role : '');
    if (seq !== contactSeq) return;
    document.getElementById('contact-archived-note').textContent =
      p && p.archived ? 'This contact is archived and hidden from the list.' : '';
    document.getElementById('contact-archive-foot').classList.toggle('hidden', !p);
    document.getElementById('btn-archive-contact').textContent = p && p.archived ? 'Restore' : 'Archive';
    await renderContactLinks(document.getElementById('contact-links'), p ? p.id : null);
    if (seq !== contactSeq) return;
    await renderContactCases(document.getElementById('contact-cases'), p ? p.id : null);
    if (seq !== contactSeq) return;
    await renderNotes(document.getElementById('contact-notes'), { personId: p ? p.id : null });
    if (seq !== contactSeq) return;
    if (!p) document.getElementById('con-display_name').focus();
  }
  window.openContact = (id) => openContact(id);

  // Role: "Add role…" opens a one-line box under the select; the new role
  // joins the pick-list for everyone and is selected here.
  (function setupContactRole() {
    const sel = document.getElementById('con-contact_role');
    const box = document.getElementById('con-role-add');
    const input = document.getElementById('con-role-new');
    sel.addEventListener('change', () => {
      if (sel.value === ADD_ROLE) {
        box.classList.remove('hidden');
        input.value = '';
        input.focus();
      } else {
        sel.dataset.prev = sel.value;
        box.classList.add('hidden');
      }
    });
    const cancel = () => { sel.value = sel.dataset.prev || ''; box.classList.add('hidden'); };
    document.getElementById('btn-con-role-cancel').addEventListener('click', cancel);
    const add = async () => {
      const name = input.value.trim();
      if (!name) { cancel(); return; }
      // An existing role typed again (any case) is picked, not duplicated.
      const existing = await appApi.dbGet(
        'SELECT name FROM contact_roles WHERE name = ? COLLATE NOCASE', [name]);
      if (!existing) {
        await appApi.dbRun(
          `INSERT INTO contact_roles (name, sort_order)
           VALUES (?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM contact_roles))`, [name]);
      }
      await fillContactRoles(existing ? existing.name : name);
    };
    document.getElementById('btn-con-role-add').addEventListener('click', add);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
      if (e.key === 'Escape') cancel();
    });
  })();

  // Works at: one box over courts and organizations. Picking fills exactly
  // one of the two hidden ids; typing clears both until something is picked.
  // A court's list label carries its city, so two courts with one name can be
  // told apart: "Name (court, City)". The box itself shows the plain name.
  async function worksAtOptions() {
    const [courts, orgs] = await Promise.all([
      appApi.dbAll('SELECT id, name, city FROM courts WHERE archived = 0 ORDER BY name COLLATE NOCASE, city COLLATE NOCASE'),
      appApi.dbAll(`SELECT id, display_name AS name, city FROM people
                     WHERE kind = 'organization' AND archived = 0 ORDER BY display_name COLLATE NOCASE`)
    ]);
    const cityOf = (c) => (c.city || '').trim();
    return [...courts.map(c => ({ kind: 'court', id: c.id, name: c.name,
      label: cityOf(c) ? `${c.name} (court, ${cityOf(c)})` : `${c.name} (court)` })),
      // Two organizations with the same name are told apart by city, the same
      // as two courts are.
      ...orgs.map(o => ({ kind: 'org', id: o.id, name: o.name,
        label: cityOf(o) ? `${o.name} (organization, ${cityOf(o)})` : `${o.name} (organization)` }))];
  }

  (function setupWorksAt() {
    const input = document.getElementById('con-works_at');
    const courtId = document.getElementById('con-works_at_court_id');
    const orgId = document.getElementById('con-works_at_org_id');
    const drop = document.querySelector('#combo-con-works-at .combobox-dropdown');
    async function refresh() {
      const term = input.value.trim().toLowerCase();
      const options = await worksAtOptions();
      drop.innerHTML = '';
      options.filter(o => !term || o.label.toLowerCase().includes(term)).slice(0, 50).forEach(o => {
        const li = document.createElement('li');
        li.textContent = o.label;
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = o.name;
          courtId.value = o.kind === 'court' ? o.id : '';
          orgId.value = o.kind === 'org' ? o.id : '';
          drop.classList.add('hidden');
        });
        drop.appendChild(li);
      });
      drop.classList.toggle('hidden', !drop.children.length);
    }
    input.addEventListener('focus', refresh);
    input.addEventListener('input', () => { courtId.value = ''; orgId.value = ''; refresh(); });
    input.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));
  })();

  // One save at a time: a double-click must not insert the contact (and its
  // judges row) twice. The flag is the guard; the disabled button is only
  // what the user sees, since anything re-rendering it could re-enable it.
  let contactSaving = false;

  async function saveContact() {
    if (contactSaving) return false;
    // CAPTURE THE ID BEFORE THE FIRST await, and every value with it: a click
    // through to another contact mid-save must not move this save onto it.
    // seq says which opening of the page this save came from — a New Contact
    // opened mid-save has con-id '' too, so the id alone cannot tell.
    const seq = contactSeq;
    const id = Number(document.getElementById('con-id').value) || null;
    const v = Object.fromEntries(CONTACT_TEXT_FIELDS.map(f =>
      [f, document.getElementById('con-' + f).value.trim() || null]));
    const roleSel = document.getElementById('con-contact_role');
    const role = roleSel.value === ADD_ROLE ? (roleSel.dataset.prev || null) : (roleSel.value || null);
    const worksAtText = document.getElementById('con-works_at').value.trim();
    let courtId = Number(document.getElementById('con-works_at_court_id').value) || null;
    let orgId = Number(document.getElementById('con-works_at_org_id').value) || null;
    if (!v.display_name) {
      alert('Type a name before saving.');
      document.getElementById('con-display_name').focus();
      return false;
    }
    const btn = document.getElementById('btn-save-contact');
    contactSaving = true;
    btn.disabled = true;
    try {
      return await writeContact({ seq, id, v, role, worksAtText, courtId, orgId });
    } finally {
      contactSaving = false;
      btn.disabled = false;
    }
  }

  async function writeContact({ seq, id, v, role, worksAtText, courtId, orgId }) {
    // Typed but not picked: take an exact match (the plain name, or the list
    // label with its city), else say so. A half-typed court silently saved as
    // "works nowhere" would be a quiet data loss.
    if (worksAtText && !courtId && !orgId) {
      const typed = worksAtText.toLowerCase();
      const options = await worksAtOptions();
      const byLabel = options.filter(o => o.label.toLowerCase() === typed);
      const match = byLabel.length ? byLabel : options.filter(o => o.name.toLowerCase() === typed);
      if (match.length > 1) {
        alert(`More than one place is called "${worksAtText}". Pick the one ${v.display_name} works at from the list (courts show their city).`);
        return false;
      }
      if (match.length !== 1) {
        alert(`Pick where ${v.display_name} works from the list, or clear the Works at box.`);
        return false;
      }
      if (match[0].kind === 'court') courtId = match[0].id; else orgId = match[0].id;
    }

    const cols = ['display_name', 'contact_role', 'works_at_court_id', 'works_at_org_id', 'phone', 'email', 'street', 'city', 'zip'];
    const vals = [v.display_name, role, courtId, orgId, v.phone, v.email, v.street, v.city, v.zip];
    let savedId = id;
    if (!id) {
      const statements = [{
        sql: `INSERT INTO people (${cols.join(', ')}, kind, is_contact, created_at)
              VALUES (${cols.map(() => '?').join(', ')}, 'individual', 1, ?)`,
        params: [...vals, new Date().toISOString()]
      }];
      // A new Judge contact is also a judge, so it can be picked on a case.
      if (role === 'Judge') {
        statements.push({ sql: 'INSERT INTO judges (name, court_id, person_id) VALUES (?, ?, last_insert_rowid())',
          params: [v.display_name, courtId] });
      }
      savedId = (await appApi.dbTransaction(statements)).ids[0];
    } else {
      const judge = await appApi.dbGet('SELECT id FROM judges WHERE person_id = ?', [id]);
      const statements = [{
        sql: `UPDATE people SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`, params: [...vals, id]
      }];
      if (judge) {
        // The caption source, in the same transaction as the contact. A
        // contact whose role is no longer Judge keeps their judges row (old
        // captions still resolve) but it is archived out of the case pickers;
        // back to Judge, it follows the contact's own archived flag again.
        statements.push({
          sql: `UPDATE judges SET name = ?, court_id = COALESCE(?, court_id),
                  archived = ${role === 'Judge' ? '(SELECT archived FROM people WHERE id = ?)' : '1'}
                WHERE id = ?`,
          params: role === 'Judge' ? [v.display_name, courtId, id, judge.id] : [v.display_name, courtId, judge.id]
        });
      } else if (role === 'Judge') {
        statements.push({
          sql: `INSERT INTO judges (name, court_id, person_id, archived)
                VALUES (?, ?, ?, (SELECT archived FROM people WHERE id = ?))`,
          params: [v.display_name, courtId, id, id] });
      }
      await appApi.dbTransaction(statements);
    }
    // Still on the page this save came from (no contact opened since), or
    // reopened on this same contact mid-save (its load may predate the save)?
    const onScreen = document.getElementById('con-id').value;
    if (seq === contactSeq || (id && onScreen === String(id))) await openContact(savedId);
    return true;
  }

  document.getElementById('btn-save-contact').addEventListener('click', () => { saveContact(); });
  document.getElementById('btn-back-contact').addEventListener('click', () => showView('contacts'));

  // Archive, never delete — the same as a client. A judge's judges row is
  // archived with the contact, so the judge leaves the case pickers too while
  // old captions keep resolving.
  document.getElementById('btn-archive-contact').addEventListener('click', async () => {
    const id = Number(document.getElementById('con-id').value) || null;
    if (!id) return;
    const p = await appApi.dbGet('SELECT archived, display_name FROM people WHERE id = ?', [id]);
    if (!p) return;
    const next = p.archived ? 0 : 1;
    if (next === 1) {
      const who = (p.display_name || '').trim() || 'this contact';
      const ok = confirm(
        `Archive ${who}?\n\n${who} will be hidden from the contacts list and the pickers. ` +
        'Nothing is deleted — existing cases keep resolving, and you can restore them from this page.');
      if (!ok) return;
    }
    // Restoring a contact whose role is no longer Judge leaves their judges
    // row archived (see saveContact): they stay out of the case pickers.
    await appApi.dbTransaction([
      { sql: 'UPDATE people SET archived = ? WHERE id = ?', params: [next, id] },
      { sql: `UPDATE judges SET archived = CASE WHEN (SELECT contact_role FROM people WHERE id = ?) = 'Judge'
                                               THEN ? ELSE 1 END
               WHERE person_id = ?`, params: [id, next, id] }
    ]);
    if (document.getElementById('con-id').value === String(id)) await openContact(id);
  });


  // --- The court page --------------------------------------------------------
  // Name, header line, city and county print on documents (captions join the
  // court live, so an edit here reaches every case in this court); address
  // and phone are for the office. The header line is stored and printed
  // exactly as typed: never upper-cased ("96th", not "96TH").
  const COURT_FIELDS = ['name', 'header_line', 'city', 'county', 'address', 'phone'];
  // Bumped on every openCourt, so a load that finishes after the user has
  // opened another court does not paint over it.
  let courtSeq = 0;

  // A plain list row: a link on the left (#003399), grey detail on the right.
  function courtPageRow(text, onOpen, rightParts) {
    const row = document.createElement('div');
    row.className = 'home-row';
    const a = document.createElement('a');
    a.href = '#';
    a.style.color = '#003399';
    a.textContent = text;
    a.addEventListener('click', (e) => { e.preventDefault(); onOpen(); });
    const right = document.createElement('span');
    right.className = 'link-right';
    rightParts.filter(Boolean).forEach(t => {
      const s = document.createElement('span');
      s.textContent = t;
      right.appendChild(s);
    });
    row.append(a, right);
    return row;
  }

  function courtPageEmpty(el, text) {
    const empty = document.createElement('div');
    empty.className = 'home-empty';
    empty.textContent = text;
    el.appendChild(empty);
  }

  async function openCourt(id) {
    showView('court-detail');
    const seq = ++courtSeq;
    document.getElementById('crt-id').value = id || '';
    const c = id ? await appApi.dbGet('SELECT * FROM courts WHERE id = ?', [id]) : null;
    if (seq !== courtSeq) return;
    COURT_FIELDS.forEach(f => { document.getElementById('crt-' + f).value = (c && c[f]) || ''; });
    document.getElementById('court-archived-note').textContent =
      c && c.archived ? 'This court is archived and hidden from the list and the case court picker.' : '';
    document.getElementById('court-archive-foot').classList.toggle('hidden', !c);
    document.getElementById('btn-archive-court').textContent = c && c.archived ? 'Restore' : 'Archive';

    const peopleEl = document.getElementById('court-people');
    const casesEl = document.getElementById('court-cases');
    const [people, cases] = c ? await Promise.all([
      appApi.dbAll(
        `SELECT id, display_name, contact_role, archived FROM people
          WHERE works_at_court_id = ? AND is_contact = 1
          ORDER BY archived, display_name COLLATE NOCASE, id`, [c.id]),
      appApi.dbAll(
        `SELECT id, short_name, case_number, archived FROM matters
          WHERE court_id = ? ORDER BY archived, short_name COLLATE NOCASE, id`, [c.id]),
    ]) : [[], []];
    const latest = await latestNotes('person_id', people.map(p => p.id));
    if (seq !== courtSeq) return;

    peopleEl.innerHTML = '';
    if (!c) courtPageEmpty(peopleEl, 'Save this court first. A contact joins it through their Works at.');
    else if (!people.length) courtPageEmpty(peopleEl, 'No contacts work here yet. Set a contact\'s Works at to this court.');
    people.forEach(p => {
      const n = latest.get(p.id);
      peopleEl.appendChild(courtPageRow(
        p.display_name + (p.archived ? '  (archived)' : ''), () => openContact(p.id),
        [p.contact_role, n ? `${n.note_date}  ${firstLine(n.body)}` : '']));
    });

    casesEl.innerHTML = '';
    if (!c) courtPageEmpty(casesEl, 'Save this court first.');
    else if (!cases.length) courtPageEmpty(casesEl, 'No cases in this court yet.');
    cases.forEach(m => {
      casesEl.appendChild(courtPageRow(
        (m.short_name || `Matter ${m.id}`) + (m.archived ? '  (archived)' : ''), () => openMatter(m.id),
        [m.case_number]));
    });

    await renderNotes(document.getElementById('court-notes'), { courtId: c ? c.id : null });
    if (seq !== courtSeq) return;
    if (!c) document.getElementById('crt-name').focus();
  }
  window.openCourt = (id) => openCourt(id);

  // One save at a time, as saveContact: a double-click must not insert the
  // court twice.
  let courtSaving = false;

  async function saveCourt() {
    if (courtSaving) return false;
    // CAPTURE THE ID BEFORE THE FIRST await, and every value with it; seq
    // says which opening of the page this save came from.
    const seq = courtSeq;
    const id = Number(document.getElementById('crt-id').value) || null;
    const v = Object.fromEntries(COURT_FIELDS.map(f =>
      [f, document.getElementById('crt-' + f).value.trim() || null]));
    if (!v.name) {
      alert('Type the court\'s name before saving.');
      document.getElementById('crt-name').focus();
      return false;
    }
    const btn = document.getElementById('btn-save-court');
    courtSaving = true;
    btn.disabled = true;
    let savedId = id;
    try {
      const vals = COURT_FIELDS.map(f => v[f]);
      if (id) {
        await appApi.dbRun(
          `UPDATE courts SET ${COURT_FIELDS.map(f => f + ' = ?').join(', ')} WHERE id = ?`, [...vals, id]);
      } else {
        savedId = (await appApi.dbRun(
          `INSERT INTO courts (${COURT_FIELDS.join(', ')}) VALUES (${COURT_FIELDS.map(() => '?').join(', ')})`,
          vals)).lastInsertRowid;
      }
    } finally {
      courtSaving = false;
      btn.disabled = false;
    }
    // Still on the page this save came from, or reopened on this same court
    // mid-save (its load may predate the save)?
    const onScreen = document.getElementById('crt-id').value;
    if (seq === courtSeq || (id && onScreen === String(id))) await openCourt(savedId);
    return true;
  }

  document.getElementById('btn-save-court').addEventListener('click', () => { saveCourt(); });
  document.getElementById('btn-back-court').addEventListener('click', () => showView('courts'));

  // Archive, never delete. An archived court leaves the Courts list and the
  // case court picker; a case already in it keeps printing it.
  document.getElementById('btn-archive-court').addEventListener('click', async () => {
    const id = Number(document.getElementById('crt-id').value) || null;
    if (!id) return;
    const c = await appApi.dbGet('SELECT archived, name FROM courts WHERE id = ?', [id]);
    if (!c) return;
    const next = c.archived ? 0 : 1;
    if (next === 1) {
      const ok = confirm(
        `Archive ${c.name}?\n\nIt will be hidden from the Courts list and the case court picker. ` +
        'Nothing is deleted — cases already in this court still print it, and you can restore it from this page.');
      if (!ok) return;
    }
    await appApi.dbRun('UPDATE courts SET archived = ? WHERE id = ?', [next, id]);
    if (document.getElementById('crt-id').value === String(id)) await openCourt(id);
  });


  // Matter types: kinds of work (Criminal Defense, Civil, Prosecution…), each
  // with a caption authority and a signing profile that pre-fill a new case.
  // They no longer pick a folder — files follow the client (client-folders
  // Task 3) — so matter_types.folder_name has no input here; the column stays,
  // deprecated per migration 35's comment. A city or business the office
  // works for is an Organization client, not a matter type.
  async function renderMatterTypes() {
    const el = document.getElementById('matter-types-manage');
    const [types, atts] = await Promise.all([
      appApi.dbAll('SELECT * FROM matter_types WHERE archived = 0 ORDER BY sort_order, id'),
      appApi.dbAll('SELECT * FROM attorneys ORDER BY id')
    ]);
    el.innerHTML = '';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex; gap:6px; font-size:0.8em; color:#666; margin-bottom:2px;';
    ['Name', 'Caption authority', 'Signs as', ''].forEach((t, i) => {
      const c = document.createElement('div');
      c.textContent = t;
      c.style.flex = i === 3 ? '0 0 64px' : '1';
      head.appendChild(c);
    });
    el.appendChild(head);

    types.forEach(t => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:6px; align-items:center; margin-bottom:4px;';

      const mk = (value, placeholder, column) => {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value || '';
        input.placeholder = placeholder;
        input.style.flex = '1';
        input.style.minWidth = '0';
        input.addEventListener('change', async () => {
          await appApi.dbRun(`UPDATE matter_types SET ${column} = ? WHERE id = ?`, [input.value.trim() || null, t.id]);
        });
        return input;
      };

      const sel = document.createElement('select');
      sel.style.flex = '1';
      sel.style.minWidth = '0';
      sel.appendChild(new Option('— Default attorney —', ''));
      atts.forEach(a => {
        const o = new Option(a.label || a.firm_name || a.name, a.id);
        if (t.attorney_id === a.id) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', async () => {
        await appApi.dbRun('UPDATE matter_types SET attorney_id = ? WHERE id = ?', [sel.value || null, t.id]);
      });

      const del = document.createElement('button');
      del.className = 'btn';
      del.type = 'button';
      del.textContent = 'Archive';
      del.style.flex = '0 0 64px';
      del.addEventListener('click', async () => {
        await appApi.dbRun('UPDATE matter_types SET archived = 1 WHERE id = ?', [t.id]);
        renderMatterTypes();
      });

      row.append(
        mk(t.name, 'Criminal Defense', 'name'),
        mk(t.caption_authority, 'PEOPLE OF THE STATE OF MICHIGAN', 'caption_authority'),
        sel,
        del
      );
      el.appendChild(row);
    });

    if (!types.length) {
      const empty = document.createElement('div');
      empty.style.color = '#666';
      empty.textContent = 'No matter types. Add one for each kind of work, such as Criminal Defense or Civil.';
      el.appendChild(empty);
    }
  }

  document.getElementById('btn-add-matter-type').addEventListener('click', async () => {
    const max = await appApi.dbGet('SELECT COALESCE(MAX(sort_order), 0) AS m FROM matter_types');
    await appApi.dbRun(
      'INSERT INTO matter_types (name, side, opposing_side_default, sort_order) VALUES (?,?,?,?)',
      ['New Matter Type', 'defense', 'prosecution', (max.m || 0) + 1]);
    renderMatterTypes();
  });

  // The documents folder is chosen, never typed: main opens a folder dialog,
  // checks the choice against what is already saved (and warns if existing
  // documents would show as missing), and stores it. See choose-output-root.
  document.getElementById('btn-choose-output-root').addEventListener('click', async () => {
    const res = await appApi.chooseOutputRoot();
    if (res && res.error) alert(res.error);
    if (res && res.root) document.getElementById('set-output_root').value = res.root;
    await refreshRootBanner();
  });

  // ATTORNEYS
  async function loadAttorneys() {
    const list = document.getElementById('attorneys-list');
    const atts = await appApi.dbAll('SELECT * FROM attorneys');
    list.innerHTML = '';
    atts.forEach(a => {
      const tr = document.createElement('tr');
      // textContent: a firm or attorney name containing "&" or "<" must not be
      // parsed as markup (see the same fix in document-engine.js).
      const label = document.createElement('td');
      label.textContent = `${a.label || a.firm_name || 'Signing Profile'}${a.is_default ? '  ★' : ''}`;
      const name = document.createElement('td');
      name.textContent = `${a.name || ''}${a.bar_number ? ` (${a.bar_number})` : ''}`;
      tr.append(label, name);
      tr.style.cursor = 'pointer';
      tr.onclick = () => openAttorney(a);
      list.appendChild(tr);
    });
    document.getElementById('attorney-edit-pane').style.display = 'none';
    document.getElementById('btn-save-attorney').classList.add('hidden');
  }

  function openAttorney(a = null) {
    document.getElementById('attorney-edit-pane').style.display = 'block';
    document.getElementById('btn-save-attorney').classList.remove('hidden');
    document.getElementById('btn-duplicate-attorney').classList.toggle('hidden', !a);
    
    document.getElementById('att-id').value = a ? a.id : '';
    ['label', 'name', 'bar_number', 'firm_name', 'firm_address', 'firm_phone', 'firm_email'].forEach(k => {
      document.getElementById('att-' + k).value = a ? a[k] : '';
    });
    document.getElementById('att-is_default').checked = a ? !!a.is_default : false;
    setSignaturePreview(a ? a.signature_image : '');
  }

  function setSignaturePreview(dataUri) {
    document.getElementById('att-signature_image').value = dataUri || '';
    const img = document.getElementById('att-signature-preview');
    if (dataUri) { img.src = dataUri; img.style.display = ''; }
    else { img.removeAttribute('src'); img.style.display = 'none'; }
    document.getElementById('signature-note').textContent = '';
  }

  // The .docx export's ImageRun forces an exact 180x50 (3.6:1) box, so a
  // signature that isn't already that ratio gets visibly stretched or
  // squished in Word output — cropping to 3.6:1 up front is what keeps that
  // box from distorting anything (see the design doc's corrected §2).
  const SIG_ASPECT = 3.6; // width / height — matches main.js's existing 180x50 docx box
  const SIG_TARGET_W = 360, SIG_TARGET_H = 100; // output pixel size

  let cropState = null; // { left, top, w, h }

  function openCropModal(rawDataUri) {
    const img = document.getElementById('sig-crop-source');
    img.src = rawDataUri;
    img.onload = () => {
      const stage = document.getElementById('sig-crop-stage');
      // Start with a box as large as fits, centered, at the locked aspect ratio.
      const maxW = Math.min(img.naturalWidth, 500);
      const boxW = maxW;
      const boxH = boxW / SIG_ASPECT;
      cropState = { left: (img.naturalWidth - boxW) / 2, top: (img.naturalHeight - boxH) / 2, w: boxW, h: boxH };
      // Scale the displayed image so it's not wildly oversized on screen.
      const displayScale = Math.min(1, 700 / img.naturalWidth);
      img.style.width = `${img.naturalWidth * displayScale}px`;
      stage.dataset.scale = displayScale;
      positionCropBox();
    };
    document.getElementById('sig-crop-modal').classList.remove('hidden');
  }

  function positionCropBox() {
    const scale = parseFloat(document.getElementById('sig-crop-stage').dataset.scale || '1');
    const box = document.getElementById('sig-crop-box');
    box.style.left = `${cropState.left * scale}px`;
    box.style.top = `${cropState.top * scale}px`;
    box.style.width = `${cropState.w * scale}px`;
    box.style.height = `${cropState.h * scale}px`;
  }

  // Drag-to-move only for a first version (resize handles are a nice-to-have,
  // not required — dragging plus a reasonable default box size covers the
  // actual complaint: "too much background", which moving the box already
  // fixes for a typical off-center scan).
  (function wireCropDrag() {
    const box = document.getElementById('sig-crop-box');
    let dragging = false, startX, startY, startLeft, startTop;
    box.addEventListener('mousedown', (e) => {
      dragging = true; startX = e.clientX; startY = e.clientY;
      startLeft = cropState.left; startTop = cropState.top;
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const scale = parseFloat(document.getElementById('sig-crop-stage').dataset.scale || '1');
      cropState.left = Math.max(0, startLeft + (e.clientX - startX) / scale);
      cropState.top = Math.max(0, startTop + (e.clientY - startY) / scale);
      positionCropBox();
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  })();

  function confirmCrop() {
    const img = document.getElementById('sig-crop-source');
    const canvas = document.createElement('canvas');
    canvas.width = SIG_TARGET_W;
    canvas.height = SIG_TARGET_H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, cropState.left, cropState.top, cropState.w, cropState.h, 0, 0, SIG_TARGET_W, SIG_TARGET_H);
    const croppedDataUri = canvas.toDataURL('image/png');
    setSignaturePreview(croppedDataUri);
    document.getElementById('sig-crop-modal').classList.add('hidden');
  }

  document.getElementById('btn-crop-confirm').addEventListener('click', confirmCrop);
  document.getElementById('btn-crop-cancel').addEventListener('click', () => {
    document.getElementById('sig-crop-modal').classList.add('hidden');
  });

  document.getElementById('btn-pick-signature').addEventListener('click', async () => {
    const res = await appApi.pickSignatureImage();
    if (res.error) { document.getElementById('signature-note').textContent = res.error; return; }
    if (!res.canceled) openCropModal(res.dataUri);
  });
  document.getElementById('btn-recrop-signature').addEventListener('click', () => {
    const current = document.getElementById('att-signature_image').value;
    if (!current) return;
    openCropModal(current);
  });
  document.getElementById('btn-clear-signature').addEventListener('click', () => setSignaturePreview(''));
  const backupStatus = document.getElementById('backup-status');
  const backupBtn = document.getElementById('btn-backup-now');
  if (backupBtn) {
    backupBtn.addEventListener('click', async () => {
      if (!window.api || !window.api.backupNow) return;
      const res = await window.api.backupNow();
      if (!res.canceled) backupStatus.textContent = `Backed up to ${res.path}`;
    });
  }
  const restoreBtn = document.getElementById('btn-restore-backup');
  if (restoreBtn) {
    restoreBtn.addEventListener('click', async () => {
      if (!window.api || !window.api.restoreBackup) return;
      // On success the app relaunches, so nothing after this runs.
      const res = await window.api.restoreBackup();
      if (res.error) backupStatus.textContent = `Restore failed: ${res.error}`;
    });
  }

  document.getElementById('btn-new-attorney').addEventListener('click', () => openAttorney(null));

  // Duplicate keeps the person (name, bar number, signature) and clears the id,
  // so adding "the same attorney, different office" is one click plus editing
  // the address — not retyping everything and fighting over which is default.
  document.getElementById('btn-duplicate-attorney').addEventListener('click', () => {
    document.getElementById('att-id').value = '';
    const label = document.getElementById('att-label');
    label.value = label.value ? `${label.value} (copy)` : '';
    document.getElementById('att-is_default').checked = false;
    document.getElementById('btn-duplicate-attorney').classList.add('hidden');
    label.focus();
    label.select();
  });
  
  document.getElementById('btn-save-attorney').addEventListener('click', async () => {
    const data = [
      document.getElementById('att-label').value.trim(),
      document.getElementById('att-name').value, document.getElementById('att-bar_number').value,
      document.getElementById('att-firm_name').value, document.getElementById('att-firm_address').value,
      document.getElementById('att-firm_phone').value, document.getElementById('att-firm_email').value,
      document.getElementById('att-is_default').checked ? 1 : 0,
      document.getElementById('att-signature_image').value || null
    ];
    const id = document.getElementById('att-id').value;
    
    if (data[7]) await appApi.dbRun('UPDATE attorneys SET is_default = 0'); // only one pre-selected

    if (id) {
      data.push(id);
      await appApi.dbRun('UPDATE attorneys SET label=?, name=?, bar_number=?, firm_name=?, firm_address=?, firm_phone=?, firm_email=?, is_default=?, signature_image=? WHERE id=?', data);
    } else {
      await appApi.dbRun('INSERT INTO attorneys (label, name, bar_number, firm_name, firm_address, firm_phone, firm_email, is_default, signature_image) VALUES (?,?,?,?,?,?,?,?,?)', data);
    }
    coCounselAttorneysCache = null; // the co-counsel picker's cached list is now stale
    loadAttorneys();
  });

  // MATTERS
  async function loadMatters() {
    const list = document.getElementById('matters-list');
    const showArchived = document.getElementById('matters-show-archived').checked;
    // The matter_types join supplies the default caption authority, which
    // matterIssues() needs — without it every matter using a type default
    // would be reported as missing one.
    const matters = await appApi.dbAll(
      `SELECT m.*, c.name as court_name, mt.caption_authority AS type_caption_authority
       FROM matters m
       LEFT JOIN courts c ON m.court_id = c.id
       LEFT JOIN matter_types mt ON mt.id = m.matter_type_id
       ${showArchived ? '' : 'WHERE m.archived = 0'} ORDER BY m.created_at DESC`);

    // Two queries for the whole list, never one per row. Running
    // matterIssuesFor() per matter would be an N+1 over IPC on every render —
    // fine with a dozen matters, unusable at several hundred. Scoped to the
    // matters actually being listed (not showing archived ones pulls their
    // parties too) rather than every party row in the database.
    const matterIds = matters.map(m => m.id);
    const partyRows = matterIds.length
      ? await appApi.dbAll(
          `SELECT matter_id, side FROM parties WHERE matter_id IN (${matterIds.map(() => '?').join(',')})`,
          matterIds)
      : [];
    const partiesByMatter = new Map();
    partyRows.forEach(r => {
      if (!partiesByMatter.has(r.matter_id)) partiesByMatter.set(r.matter_id, []);
      partiesByMatter.get(r.matter_id).push(r);
    });

    list.innerHTML = '';
    matters.forEach(m => {
      const tr = document.createElement('tr');
      const cells = [
        { text: m.short_name },
        { text: m.case_number || '', align: 'right' },
        { text: m.court_name || '' },
        { text: m.client_role || '', capitalize: true }
      ];
      // textContent, not innerHTML: matter and party names are user data.
      cells.forEach(c => {
        const td = document.createElement('td');
        td.textContent = c.text;
        if (c.align) td.style.textAlign = c.align;
        if (c.capitalize) td.style.textTransform = 'capitalize';
        tr.appendChild(td);
      });
      // Quiet count, not a warning: visible while scanning, never blocking.
      const issues = matterIssues(m, partiesByMatter.get(m.id) || []);
      const flag = document.createElement('td');
      flag.style.cssText = 'color:#888; font-size:0.85em; text-align:right; white-space:nowrap;';
      if (issues.length) {
        flag.textContent = `${issues.length} needed`;
        flag.title = issues.join('\n');
      }
      tr.appendChild(flag);

      tr.style.cursor = 'pointer';
      tr.onclick = () => openMatter(m.id);
      list.appendChild(tr);
    });
  }

  let currentMatterId = null;
  let parties = { plaintiff: [], defendant: [] };

  // Set only when the Generate view was opened via "Regenerate" on an
  // existing document row. While set, handleGenerate() uses this frozen
  // matter/attorney state instead of querying the matter live, so a document
  // already on file can be reproduced exactly even if the matter has changed
  // since. Cleared whenever Generate is opened fresh, or the user clicks
  // "Use current matter data instead".
  let regenerateFromSnapshot = null;

  document.getElementById('matters-show-archived').addEventListener('change', loadMatters);

  // Matters are archived, never deleted: generated documents on disk reference
  // them, and a closed case still needs to be findable.
  document.getElementById('btn-archive-matter').addEventListener('click', async () => {
    if (!currentMatterId) return;
    const m = await appApi.dbGet('SELECT archived FROM matters WHERE id = ?', [currentMatterId]);
    await appApi.dbRun('UPDATE matters SET archived = ? WHERE id = ?', [m.archived ? 0 : 1, currentMatterId]);
    await openMatter(currentMatterId);
    await loadMatters();
  });

  // Shared by the direct "New Matter" path (below) and the wizard's
  // "Court Filing" fork choice (see the intake-wizard design notes).
  // The case half of the intake questionnaire (migration 26). Plain
  // value-carrying inputs, so one list drives reset, load and save and none of
  // the three can quietly fall out of step with the other two.
  // `current_charge` is deliberately absent: the charge is a caption note.
  const MATTER_INTAKE_FIELDS = [
    'stage', 'bac', 'police_agency', 'citation_number',
    'date_of_offense', 'referred_by', 'fee_quoted'
  ];

  // Where a case stands decides which intake answers are expected, so nobody is
  // asked for a citation number that does not exist yet. This is a table, not a
  // pile of branches, so the whole rule can be read in one go.
  //
  // "required" means the answer shows up in the "Still needed:" box and nothing
  // more. It NEVER blocks saving — a client walking in with half the facts still
  // has to be recorded. "hidden" hides the input; it does not clear it, does not
  // stop it loading and does not stop saveMatter writing it.
  //
  // The keys must match the <option value> list in the mat-stage <select>
  // character for character; a typo makes a stage silently match nothing. The
  // smoke test compares the two lists both ways.
  //
  // BAC is optional wherever it is shown — plenty of OWI clients refused the
  // test. Post-conviction and PV are one stage on purpose (confirmed with the
  // attorney 2026-08-24): they share the same intake shape.
  const STAGE_FIELDS = {
    'Not yet charged':       { citation_number: 'hidden',   date_of_offense: 'required', bac: 'optional', case_number: 'hidden' },
    'Cited, no court date':  { citation_number: 'required', date_of_offense: 'required', bac: 'optional', case_number: 'hidden' },
    'Arraignment pending':   { citation_number: 'required', date_of_offense: 'required', bac: 'optional', case_number: 'required' },
    'Pretrial':              { citation_number: 'required', date_of_offense: 'required', bac: 'optional', case_number: 'required' },
    'Post-conviction or PV': { citation_number: 'optional', date_of_offense: 'required', bac: 'hidden',   case_number: 'required' },
    'Appeal':                { citation_number: 'optional', date_of_offense: 'required', bac: 'hidden',   case_number: 'required' },
    'Licence restoration':   { citation_number: 'hidden',   date_of_offense: 'optional', bac: 'hidden',   case_number: 'hidden' }
  };

  const STAGE_GOVERNED_FIELDS = ['citation_number', 'date_of_offense', 'bac', 'case_number'];

  // Every matter already in the real database has stage = NULL: migration 26
  // added the column without back-filling it. An unset (or unrecognised) stage
  // is therefore the ordinary case, not an error — show every field and add no
  // requirement of its own. Whatever the rest of matterIssues() already asked
  // for on a stage-less matter it goes on asking for, unchanged.
  function stageRule(stage, field) {
    const row = STAGE_FIELDS[String(stage == null ? '' : stage).trim()];
    return row ? (row[field] || 'optional') : 'optional';
  }

  // Hiding is not clearing. This toggles one class and touches no value, which
  // is the whole reason a hidden field survives both a stage switch and a save.
  function applyStageFieldVisibility() {
    const sel = document.getElementById('mat-stage');
    if (!sel) return;
    STAGE_GOVERNED_FIELDS.forEach(f => {
      const input = document.getElementById('mat-' + f);
      const group = input && input.closest('.form-group');
      if (group) group.classList.toggle('hidden', stageRule(sel.value, f) === 'hidden');
    });
  }

  // A court date that has been and gone is a nudge that `stage` should move
  // on. A nudge ONLY: confirmed with the attorney 2026-08-24, the app never changes
  // the stage by itself. It cannot know whether the hearing was adjourned, waived,
  // or resolved by plea, and a wrong stage on a criminal file is worse than a
  // stale one. This map is read to produce words and nothing else.
  //
  // Only stages whose matching event type is unambiguous appear here.
  // 'Not yet charged', 'Appeal' and 'Licence restoration' have no single event
  // that ends them, and 'Trial' and 'Sentencing' are event types with no stage
  // of their own — so they get no mapping and no note, rather than a guessed
  // one. Keys must match the mat-stage <option> values character for
  // character, exactly like STAGE_FIELDS above.
  const STAGE_EVENT_MATCH = {
    'Arraignment pending': 'Arraignment',
    'Pretrial': 'Pretrial'
  };

  function staleStageNotes(stage, events, today) {
    const cleanStage = String(stage == null ? '' : stage).trim();
    const wanted = STAGE_EVENT_MATCH[cleanStage];
    if (!wanted) return [];
    // Done or not: a date of this type that has passed means the stage has
    // been overtaken either way.
    const passed = (events || [])
      .filter(e => String(e.event_type || '').trim() === wanted
        && isIsoDate(e.event_date) && String(e.event_date).trim() < today)
      .map(e => String(e.event_date).trim())
      .sort();
    if (!passed.length) return [];
    return [`The ${wanted.toLowerCase()} date (${passed[passed.length - 1]}) has passed `
      + `and the stage still reads ${cleanStage}. Change it here if it should move on.`];
  }

  // Reads the events as they stand on screen, unsaved edits included, so
  // typing a date that has already passed brings the note up straight away.
  function refreshStaleStageNote() {
    const box = document.getElementById('matter-stage-note');
    if (!box) return;
    syncMatterEventsFromDom();
    const sel = document.getElementById('mat-stage');
    renderIssueList(box, staleStageNotes(sel ? sel.value : '', matterEvents, todayISO()), 'Note:');
  }

  async function refreshMatterIssues() {
    renderIssueList(document.getElementById('matter-issues'),
      await matterIssuesFor(currentMatterId), 'Still needed:');
    refreshStaleStageNote();
  }

  document.getElementById('mat-stage').addEventListener('change', async () => {
    applyStageFieldVisibility();
    await refreshMatterIssues();
  });

  function resetNewMatterForm() {
    currentMatterId = null;
    renderWhosInvolved(document.getElementById('matter-who'), null);
    ['short_name', 'case_number', 'court_id', 'court', 'judge_id', 'judge', 'opposing_counsel', 'caption_authority'].forEach(k => document.getElementById('mat-'+k).value='');
    MATTER_INTAKE_FIELDS.forEach(k => { document.getElementById('mat-'+k).value = ''; });
    // Blank stage on a brand-new matter: everything shown, nothing required.
    applyStageFieldVisibility();
    document.getElementById('mat-case_number_pending').checked = false;
    captionNotes = [];
    renderCaptionNotes();
    coCounsel = [];
    renderCoCounsel();
    matterEvents = [];
    renderMatterEvents();
    matterPayments = [];
    renderMatterPayments();
    populateAttorneySelect(null); // A10 — fire-and-forget, nothing depends on it synchronously
    document.getElementById('matter-activity').textContent = 'Save matter first.';
    document.getElementById('matter-transfers').textContent = 'Save matter first.';
    // A brand-new matter has no id to check yet; clear the box so the previous
    // matter's list does not linger on it. Same for the stale-stage note: it
    // describes the matter that was just closed.
    renderIssueList(document.getElementById('matter-issues'), [], 'Still needed:');
    renderIssueList(document.getElementById('matter-stage-note'), [], 'Note:');
    document.getElementById('mat-party_label').value = 'Defendant';
    document.getElementById('mat-plaintiff_label').value = 'Plaintiff';
    // Blank, never the last case's side: it decides "Attorney for …" on every
    // filing, so a new case has to choose it (wizard Next and Save require it).
    document.getElementById('mat-client_role').value = '';
    clientRoleChosen = false;
    document.getElementById('mat-oppcounsel_name').value = '';
    document.getElementById('mat-opposing_counsel_person_id').value = '';
    extraCases = [];
    renderExtraCases();
    document.getElementById('btn-goto-generate').classList.add('hidden');
    showMatterFileButtons(false);
    document.getElementById('btn-archive-matter').classList.add('hidden');
    document.getElementById('matter-archived-note').textContent = '';
    document.getElementById('documents-list').innerHTML = 'Save matter first.';
    currentPacketId = null;
    loadPackets(null);
    loadMatterTypes(null);
    parties = { plaintiff: [], defendant: [] };
    renderParties();
    document.querySelectorAll('input[name="mat-engagement_status"], input[name="oppcounsel_status"]').forEach(r => r.checked = false);
    document.getElementById('combo-oppcounsel').closest('.form-group').classList.remove('hidden');
    markFormClean('view-matter-detail');
  }

  document.getElementById('btn-new-matter').addEventListener('click', () => {
    showView('matter-fork');
  });

  document.getElementById('btn-fork-back').addEventListener('click', () => showView('matters'));

  document.getElementById('btn-fork-letter').addEventListener('click', () => {
    document.getElementById('ltr-recipient_name').value = '';
    document.getElementById('ltr-recipient_person_id').value = '';
    document.getElementById('ltr-matter_name').value = '';
    document.getElementById('ltr-matter_id').value = '';
    letterClientPicker.set(null, '');
    letterClientByHand = false;
    letterClientSeq++; // drops a suggestion still in flight for the last letter
    showView('letter-new');
  });

  document.getElementById('btn-cancel-letter').addEventListener('click', () => {
    showView('matter-fork');
  });

  document.getElementById('btn-create-letter').addEventListener('click', async () => {
    // Everything read off the screen before the first await.
    const personId = document.getElementById('ltr-recipient_person_id').value;
    const matterId = document.getElementById('ltr-matter_id').value || null;
    const clientId = document.getElementById('ltr-client_person_id').value || null;
    if (!personId) { alert('Pick or add a recipient first.'); return; }
    const person = await appApi.dbGet('SELECT * FROM people WHERE id = ?', [personId]);
    const res = await appApi.dbRun(
      `INSERT INTO packets (matter_id, kind, label, packet_date, recipient_person_id,
         recipient_name, recipient_address, client_person_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [matterId, 'standalone_letter', 'Letter', new Date().toISOString().slice(0, 10),
       // Composed, not the raw `address` blob: since migration 24 the profile
       // writes street/city/zip, so the blob is stale for every client edited
       // since. The snapshot is frozen at creation on purpose — a letter says
       // what it said when it was written — so it must freeze the CURRENT
       // address, not a superseded one.
       personId, person.display_name, composePersonAddress(person) || null,
       clientId ? Number(clientId) : null, new Date().toISOString()]);
    currentMatterId = null;
    currentPacketId = res.lastInsertRowid;
    // The letter exists now, so the New Letter screen has nothing left to lose.
    markFormClean('view-letter-new');
    await openPacket(currentPacketId);
  });

  // --- "+ Add" from a picker: offer the profile without losing the form ------
  //
  // The pickers create a name-only person and deliberately STAY PUT. You are
  // partway through a filing or a letter, and navigating away would discard
  // what is already typed — which is why "+ Add" does not simply jump to the
  // profile. The field grows a link instead, and the link asks before leaving.
  //
  // A person made this way is a bare name: no date of birth, no address, no
  // licence number. The profile's "Still needed:" list already says so; this is
  // what gets someone there while they still remember who the person is.

  const PERSON_ADDED_CLASS = 'person-added-note';

  function clearPersonAddedNotes(root) {
    // Literal, not PERSON_ADDED_CLASS: this is called from showView, which can
    // run before the const below it initialises.
    (root || document).querySelectorAll('.person-added-note').forEach(n => n.remove());
  }

  // `open` is where the link goes: the person profile, or the contact page
  // for someone added as a contact (opposing counsel).
  function showPersonAddedNote(afterEl, personId, name, { isDirty, save, open = openPerson } = {}) {
    if (!afterEl || !afterEl.parentNode) return null;
    // One note per container, so adding three people in a row does not stack
    // three notes down the page.
    afterEl.parentNode.querySelectorAll('.' + PERSON_ADDED_CLASS).forEach(n => n.remove());

    const note = document.createElement('div');
    note.className = PERSON_ADDED_CLASS;
    // textContent throughout: a person's name is user data.
    const said = document.createElement('span');
    said.textContent = `${name} added — name only. `;
    note.appendChild(said);

    const link = document.createElement('a');
    link.href = '#';
    link.className = 'open-profile-link';
    link.textContent = '↗ open profile';
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!isDirty || !isDirty()) { await open(personId); return; }
      renderUnsavedChoice(note, personId, save, open);
    });
    note.appendChild(link);

    afterEl.insertAdjacentElement('afterend', note);
    return note;
  }

  // Three ways out, rendered in the page rather than as a native dialog.
  // window.confirm is two-way, and chaining two of them to fake a third choice
  // is worse than the problem it solves — it also blocks the smoke harness
  // outright, the same way alert() does.
  function renderUnsavedChoice(note, personId, save, open = openPerson) {
    note.innerHTML = '';
    const msg = document.createElement('span');
    msg.textContent = save
      ? 'This form has unsaved changes. '
      : 'Leaving loses what is picked here. ';
    note.appendChild(msg);

    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      note.appendChild(b);
      return b;
    };

    // No save button where there is nothing to save: on the New Letter screen
    // the letter does not exist until Create is pressed.
    if (save) {
      mk('Save and open profile', 'Save this form first, then open the new person',
        async () => { await save(); await open(personId); });
    }
    mk('Open anyway', 'Leave without saving', async () => { await open(personId); });
    mk('Cancel', 'Stay here', () => { note.remove(); });
  }

  // --- Client picker: whose folder a standalone letter is saved in ---------
  //
  // Used on New Letter and on a letter's packet screen. The first row is
  // always an explicit "none", so filing in General Letters is one click
  // rather than "clear the box and hope". Recently touched clients first,
  // then everyone else by name; a search that a newer keystroke has
  // overtaken is dropped rather than painted over the newer list.
  //
  // Typing only searches: the selection changes when a row is picked (or
  // through set()). Leaving the box without picking puts the selection's name
  // back, so an abandoned partial search never looks like a choice.
  const NO_CLIENT_LABEL = '(none — General Letters)';

  function setupClientPicker(input, hidden, drop, onChosen) {
    let seq = 0;
    let chosen = { id: hidden.value, name: input.value };
    // While the user is typing in the box, leave their search text alone;
    // blur shows the new selection's name.
    function set(id, name) {
      hidden.value = id ? String(id) : '';
      chosen = { id: hidden.value, name: name || '' };
      if (document.activeElement !== input) input.value = chosen.name;
    }
    async function refresh() {
      const mine = ++seq;
      const term = input.value.trim().toLowerCase();
      const [recent, people] = await Promise.all([
        recentClients(8),
        // Contacts (judges, clerks, opposing counsel) are people rows too, but
        // never a client: this list picks a client, so they are left out.
        appApi.dbAll('SELECT id, display_name FROM people WHERE archived = 0 AND is_contact = 0 ORDER BY display_name COLLATE NOCASE')
      ]);
      if (mine !== seq) return;
      const live = new Set(people.map(p => p.id));
      const recentIds = new Set(recent.map(r => r.id));
      const ordered = [...recent.filter(r => live.has(r.id)), ...people.filter(p => !recentIds.has(p.id))];
      const choose = (id, name) => {
        hidden.value = id ? String(id) : '';
        input.value = name;
        chosen = { id: hidden.value, name };
        drop.classList.add('hidden');
        if (onChosen) onChosen();
      };
      const row = (text, fn) => {
        const li = document.createElement('li');
        li.textContent = text; // a person's name is user data
        li.addEventListener('mousedown', (e) => { e.preventDefault(); fn(); });
        return li;
      };
      drop.replaceChildren(
        row(NO_CLIENT_LABEL, () => choose(null, '')),
        ...ordered
          .filter(p => !term || p.display_name.toLowerCase().includes(term))
          .slice(0, 50)
          .map(p => row(p.display_name, () => choose(p.id, p.display_name))));
      drop.classList.remove('hidden');
    }
    input.addEventListener('focus', refresh);
    input.addEventListener('input', refresh);
    input.addEventListener('blur', () => {
      seq++; // a search still in flight must not reopen the list
      // Unless something wrote the hidden id directly meanwhile, in which
      // case the text on screen is its own.
      if (hidden.value === chosen.id) input.value = chosen.name;
      setTimeout(() => drop.classList.add('hidden'), 150);
    });
    return { set };
  }

  // New Letter fills Client in by itself from the recipient or the Regarding
  // case, but only until the user picks a Client row themselves — after that
  // their choice stands, including an explicit "none". A search typed and
  // abandoned is not a choice.
  let letterClientByHand = false;
  let letterClientSeq = 0;

  const letterClientPicker = setupClientPicker(
    document.getElementById('ltr-client_name'),
    document.getElementById('ltr-client_person_id'),
    document.querySelector('#combo-letter-client .combobox-dropdown'),
    () => { letterClientByHand = true; });

  // The newest suggestion wins; one overtaken by a later pick, or by the user
  // choosing a Client by hand while it was being looked up, is dropped. A
  // suggestion that finds nobody clears Client too: anything in it now was
  // only suggested, and for someone else (else Bob's letter files under the
  // Alice picked a moment ago). Callers .catch: a failed lookup changes nothing.
  async function suggestLetterClient(lookup) {
    if (letterClientByHand) return;
    const mine = ++letterClientSeq;
    const person = await lookup();
    if (mine !== letterClientSeq || letterClientByHand) return;
    letterClientPicker.set(person ? person.id : null, person ? person.display_name : '');
  }

  // The recipient themselves, when they are a client on any case.
  function clientFromRecipient(personId) {
    return appApi.dbGet(
      `SELECT p.id, p.display_name FROM people p
        WHERE p.id = ? AND p.archived = 0
          AND EXISTS (SELECT 1 FROM parties pa WHERE pa.person_id = p.id AND pa.role = 'client')`,
      [personId]);
  }

  // The case's folder owner — the same answer its documents are filed under:
  // the stored owner, else its only client. A case filed under No Client, or
  // with several clients and no owner yet, suggests nobody.
  async function clientFromCase(matterId) {
    const m = await appApi.dbGet('SELECT folder_person_id FROM matters WHERE id = ?', [matterId]);
    if (!m || m.folder_person_id === 0) return null;
    if (m.folder_person_id > 0) {
      return appApi.dbGet('SELECT id, display_name FROM people WHERE id = ? AND archived = 0', [m.folder_person_id]);
    }
    const clients = await appApi.dbAll(
      `SELECT DISTINCT p.id, p.display_name FROM parties pa JOIN people p ON p.id = pa.person_id
        WHERE pa.matter_id = ? AND pa.role = 'client' AND p.archived = 0`, [matterId]);
    return clients.length === 1 ? clients[0] : null;
  }

  (function setupLetterRecipient() {
    const input = document.getElementById('ltr-recipient_name');
    const hidden = document.getElementById('ltr-recipient_person_id');
    const drop = document.querySelector('#combo-letter-recipient .combobox-dropdown');

    async function refresh() {
      const term = input.value.trim().toLowerCase();
      const people = await appApi.dbAll('SELECT * FROM people WHERE archived = 0 ORDER BY display_name COLLATE NOCASE');
      drop.innerHTML = '';
      const matches = people.filter(p => !term || p.display_name.toLowerCase().includes(term)).slice(0, 50);
      matches.forEach(p => {
        const li = document.createElement('li');
        li.textContent = p.display_name + (p.firm_name ? ` — ${p.firm_name}` : '');
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          hidden.value = p.id;
          input.value = p.display_name;
          drop.classList.add('hidden');
          suggestLetterClient(() => clientFromRecipient(p.id)).catch(() => {});
        });
        drop.appendChild(li);
      });
      const exact = matches.some(p => p.display_name.toLowerCase() === term);
      if (term && !exact) {
        const createLi = document.createElement('li');
        createLi.className = 'add-new';
        createLi.textContent = `+ Add "${input.value.trim()}"`;
        createLi.addEventListener('mousedown', async (e) => {
          e.preventDefault();
          const name = input.value.trim();
          const res = await appApi.dbRun(
            `INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)`,
            [name, 'individual', new Date().toISOString()]);
          hidden.value = res.lastInsertRowid;
          drop.classList.add('hidden');
          showPersonAddedNote(document.getElementById('combo-letter-recipient'),
            res.lastInsertRowid, name, {
              isDirty: () => isFormDirty('view-letter-new'),
              // Nothing to save: a letter does not exist until Create is pressed.
              save: null
            });
        });
        drop.appendChild(createLi);
      }
      drop.classList.remove('hidden');
    }
    input.addEventListener('focus', refresh);
    input.addEventListener('input', () => { hidden.value = ''; refresh(); });
    input.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));
  })();

  (function setupLetterMatterAttach() {
    const input = document.getElementById('ltr-matter_name');
    const hidden = document.getElementById('ltr-matter_id');
    const drop = document.querySelector('#combo-letter-matter .combobox-dropdown');

    async function refresh() {
      const term = input.value.trim().toLowerCase();
      const matters = await appApi.dbAll('SELECT id, short_name, case_number FROM matters WHERE archived = 0 ORDER BY created_at DESC');
      drop.innerHTML = '';
      matters
        .filter(m => !term || m.short_name.toLowerCase().includes(term))
        .slice(0, 50)
        .forEach(m => {
          const li = document.createElement('li');
          li.textContent = m.short_name + (m.case_number ? ` — ${m.case_number}` : '');
          li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            hidden.value = m.id;
            input.value = m.short_name;
            drop.classList.add('hidden');
            suggestLetterClient(() => clientFromCase(m.id)).catch(() => {});
          });
          drop.appendChild(li);
        });
      drop.classList.remove('hidden');
    }
    input.addEventListener('focus', refresh);
    input.addEventListener('input', () => { hidden.value = ''; refresh(); });
    input.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));
  })();

  document.getElementById('btn-fork-court').addEventListener('click', () => {
    resetNewMatterForm();
    enterWizardStep(1);
  });

  // WIZARD MODE — see the intake-wizard design notes.
  // Steps 1-2 are the existing view-matter-detail fieldsets, shown one at a
  // time instead of both at once; editing an existing matter (openMatter,
  // below) always turns this off and shows both, exactly as before this
  // phase. Step 3 (the doctype picker) has no existing fieldset to reuse and
  // is its own small view — see goToDoctypePicker().
  let wizardMode = false;
  let wizardStep = 1;

  // Whether anything has decided "Our Client Role" on the form yet. A new case
  // starts on the blank "— choose —" option; this flag additionally records a
  // deliberate pick, so an organization's usual side knows it is not
  // overwriting a real decision. Set by: opening a saved case, the user picking a role,
  // a case type that implies a side, or an organization's usual side itself.
  // Cleared only by resetNewMatterForm.
  let clientRoleChosen = false;
  document.getElementById('mat-client_role').addEventListener('change', () => { clientRoleChosen = true; });

  function enterWizardStep(step) {
    wizardMode = true;
    wizardStep = step;

    document.getElementById('wizard-step-1-fields').classList.toggle('hidden', step !== 1);
    document.getElementById('wizard-step-2-fields').classList.toggle('hidden', step !== 2);
    document.getElementById('matter-detail-sideinfo').classList.add('hidden');

    ['btn-back-matter', 'btn-save-matter', 'btn-goto-generate', 'btn-archive-matter'].forEach(id =>
      document.getElementById(id).classList.add('hidden'));
    showMatterFileButtons(false);
    document.getElementById('btn-wizard-back').classList.remove('hidden');
    document.getElementById('btn-wizard-next').classList.remove('hidden');
    document.getElementById('wizard-step-label').classList.remove('hidden');
    document.getElementById('wizard-step-label').textContent = `Step ${step} of 3`;

    checkWizardStep1Ready();
    showView('matter-detail');
  }

  // Next is disabled on Step 1 until the two fields everything else depends
  // on are set — Matter Type drives Step 3's allowed doctypes, Our Client
  // Role drives the caption. Never a hard block past this point, matching
  // how the rest of the app treats missing data (quiet reminders, not gates).
  function checkWizardStep1Ready() {
    if (!wizardMode || wizardStep !== 1) return;
    const ready = document.getElementById('mat-matter_type_id').value && document.getElementById('mat-client_role').value;
    document.getElementById('btn-wizard-next').disabled = !ready;
  }
  document.getElementById('mat-matter_type_id').addEventListener('change', checkWizardStep1Ready);
  document.getElementById('mat-client_role').addEventListener('change', checkWizardStep1Ready);

  document.getElementById('btn-wizard-back').addEventListener('click', () => {
    if (wizardStep === 1) { wizardMode = false; showView('matter-fork'); }
    else enterWizardStep(1);
  });
  document.getElementById('btn-wizard-next').addEventListener('click', () => {
    if (wizardStep === 1) enterWizardStep(2);
    else goToDoctypePicker();
  });

  // Opposing counsel Named/Pro se/Unknown — a friendlier prompt over
  // existing behavior, not new storage. Picking anything but Named clears
  // the linked person; both renderers already omit the counsel column
  // correctly when nothing is picked (build plan §6).
  document.querySelectorAll('input[name="oppcounsel_status"]').forEach(r => {
    r.addEventListener('change', () => {
      const named = r.value === 'named' && r.checked;
      document.getElementById('combo-oppcounsel').closest('.form-group').classList.toggle('hidden', r.checked && !named);
      if (r.checked && r.value !== 'named') {
        document.getElementById('mat-oppcounsel_name').value = '';
        document.getElementById('mat-opposing_counsel_person_id').value = '';
      }
    });
  });

  async function openMatter(id) {
    wizardMode = false;
    currentMatterId = id;
    document.getElementById('matter-upload-note').textContent = '';
    // Reset BEFORE the first await, not after the row comes back. Between the
    // two, the previous matter's court dates are still on screen and still in
    // the array a save would write — opening matter B must never show, or
    // save, matter A's hearing dates.
    matterEvents = [];
    renderMatterEvents();
    matterPayments = [];
    renderMatterPayments();
    // Not awaited: it has its own sequence guard, and the rest of the case
    // does not wait on it.
    renderWhosInvolved(document.getElementById('matter-who'), id);
    const m = await appApi.dbGet('SELECT * FROM matters WHERE id = ?', [id]);
    document.getElementById('mat-short_name').value = m.short_name;
    document.getElementById('mat-case_number').value = m.case_number;
    document.getElementById('mat-case_number_pending').checked = !!m.case_number_pending;
    document.getElementById('mat-court_id').value = m.court_id || '';
    if (m.court_id) {
      const c = await appApi.dbGet('SELECT name FROM courts WHERE id = ?', [m.court_id]);
      document.getElementById('mat-court').value = c ? c.name : '';
    }
    document.getElementById('mat-judge_id').value = m.judge_id || '';
    if (m.judge_id) {
      const j = await appApi.dbGet('SELECT name FROM judges WHERE id = ?', [m.judge_id]);
      document.getElementById('mat-judge').value = j ? j.name : '';
    }
    await populateAttorneySelect(m.attorney_id || null);
    // A case saved with no side (older data) shows blank, not whatever the
    // select held last, and Save then asks for one.
    document.getElementById('mat-client_role').value = m.client_role || '';
    clientRoleChosen = !!m.client_role;
    document.getElementById('mat-caption_style').value = m.caption_style;
    document.getElementById('mat-opposing_counsel').value = m.opposing_counsel;
    document.getElementById('mat-party_label').value = m.party_label || 'Defendant';
    document.getElementById('mat-caption_authority').value = m.caption_authority || '';
    const noteRows = await appApi.dbAll(
      'SELECT note_text FROM matter_caption_notes WHERE matter_id = ? ORDER BY sort_order, id', [id]);
    captionNotes = noteRows.map(r => ({ note_text: r.note_text }));
    renderCaptionNotes();
    matterEvents = await appApi.dbAll(
      `SELECT event_type, event_date, event_time, location, notes, done
       FROM matter_events WHERE matter_id = ? ORDER BY event_date, id`, [id]);
    renderMatterEvents();
    matterPayments = await appApi.dbAll(
      `SELECT amount_cents, paid_date, notes FROM matter_payments
       WHERE matter_id = ? ORDER BY paid_date, id`, [id]);
    renderMatterPayments();
    const coRows = await appApi.dbAll(
      'SELECT attorney_id FROM matter_attorneys WHERE matter_id = ? ORDER BY sort_order, id', [id]);
    coCounsel = coRows.map(r => ({ attorney_id: r.attorney_id }));
    await renderCoCounsel();
    const archBtn = document.getElementById('btn-archive-matter');
    archBtn.classList.remove('hidden');
    archBtn.textContent = m.archived ? 'Restore Matter' : 'Archive Matter';
    document.getElementById('matter-archived-note').textContent =
      m.archived ? 'This matter is archived.' : '';
    document.getElementById('mat-plaintiff_label').value = m.plaintiff_label || 'Plaintiff';
    document.getElementById('mat-opposing_counsel_person_id').value = m.opposing_counsel_person_id || '';
    document.getElementById('mat-oppcounsel_name').value = '';
    if (m.opposing_counsel_person_id) {
      const oc = await appApi.dbGet('SELECT display_name FROM people WHERE id = ?', [m.opposing_counsel_person_id]);
      if (oc) document.getElementById('mat-oppcounsel_name').value = oc.display_name;
    }
    document.getElementById('combo-oppcounsel').closest('.form-group').classList.remove('hidden');
    markFormClean('view-matter-detail');
    document.querySelectorAll('input[name="oppcounsel_status"]').forEach(r => r.checked = false);
    if (m.opposing_counsel_person_id) {
      document.querySelector('input[name="oppcounsel_status"][value="named"]').checked = true;
    }

    MATTER_INTAKE_FIELDS.forEach(k => { document.getElementById('mat-'+k).value = m[k] || ''; });
    // After the values are in, never before: visibility follows the stage that
    // was just loaded. It hides inputs and leaves their values alone.
    applyStageFieldVisibility();
    // Rendered here rather than earlier: the issue list reads the stage and the
    // intake inputs, so it must not run while they still hold the last matter's
    // values.
    await refreshMatterIssues();

    document.querySelectorAll('input[name="mat-engagement_status"]').forEach(r => { r.checked = false; });
    const engRadio = m.engagement_status
      ? document.querySelector(`input[name="mat-engagement_status"][value="${m.engagement_status}"]`)
      : null;
    if (engRadio) engRadio.checked = true;
    // Row 0 is the primary case shown in the header fields; the rest are extras.
    const allCases = await appApi.dbAll(
      'SELECT * FROM matter_cases WHERE matter_id = ? ORDER BY sort_order, id', [id]);
    extraCases = allCases.slice(1).map(c => ({ id: c.id, case_number: c.case_number, judge_name: c.judge_name }));
    renderExtraCases();
    await loadMatterTypes(m.matter_type_id);

    const pRows = await appApi.dbAll('SELECT * FROM parties WHERE matter_id = ? ORDER BY sort_order', [id]);
    parties = { plaintiff: [], defendant: [] };
    pRows.forEach(p => parties[p.side].push(p));
    renderParties();
    
    document.getElementById('btn-goto-generate').classList.remove('hidden');
    showMatterFileButtons(true);
    regenerateFromSnapshot = null;
    currentPacketId = null;
    loadDocuments(id);
    loadPackets(id);
    renderMatterActivity(id);
    renderMatterTransfers(id);

    // Editing an existing matter never shows wizard chrome — both fieldsets
    // visible at once, normal toolbar, exactly as before this phase.
    document.getElementById('wizard-step-1-fields').classList.remove('hidden');
    document.getElementById('wizard-step-2-fields').classList.remove('hidden');
    document.getElementById('matter-detail-sideinfo').classList.remove('hidden');
    document.getElementById('btn-back-matter').classList.remove('hidden');
    document.getElementById('btn-save-matter').classList.remove('hidden');
    ['btn-wizard-back', 'btn-wizard-next', 'wizard-step-label'].forEach(elId =>
      document.getElementById(elId).classList.add('hidden'));

    showView('matter-detail');
  }

  document.getElementById('btn-back-matter').onclick = () => showView('matters');

  // One row per generated document, newest first — a document may carry a
  // pdf_path, a docx_path, or both (generating Word after PDF for the same
  // field values fills in the second path on the same row rather than
  // creating a second one; see handleGenerate()). Each row is openable
  // straight from the app, can be marked filed, and can be reopened with its
  // frozen matter/attorney snapshot via "Regenerate".
  async function loadDocuments(matterId) {
    const list = document.getElementById('documents-list');
    const docs = await appApi.dbAll('SELECT * FROM documents WHERE matter_id = ? ORDER BY created_at DESC', [matterId]);
    list.innerHTML = '';
    if (!docs.length) { list.textContent = 'No documents yet.'; return; }

    docs.forEach(d => {
      const dt = window.DocumentEngine.doctypes.find(t => t.id === d.doc_type);
      const div = document.createElement('div');
      div.style.cssText = 'padding:6px 4px; border-bottom:1px solid #d4d4d4;';

      const label = document.createElement('strong');
      label.textContent = dt ? dt.label : d.doc_type;
      div.append(label, document.createElement('br'));

      const generated = document.createElement('small');
      generated.textContent = `Generated: ${new Date(d.created_at).toLocaleString()}`;
      div.append(generated, document.createElement('br'));

      // Filed date: shown plain once set, with a "Change" link back to the
      // editable control — Generated and Filed are different facts, so this
      // is never inferred from created_at.
      const filedWrap = document.createElement('span');
      const renderFiledControl = (editing) => {
        filedWrap.innerHTML = '';
        if (d.filed_at && !editing) {
          const filedText = document.createElement('small');
          filedText.textContent = `Filed: ${new Date(d.filed_at).toLocaleDateString()} `;
          const change = document.createElement('a');
          change.href = '#'; change.style.color = '#003399'; change.textContent = 'Change';
          change.addEventListener('click', (e) => { e.preventDefault(); renderFiledControl(true); });
          filedWrap.append(filedText, change);
        } else {
          const input = document.createElement('input');
          input.type = 'date';
          input.value = d.filed_at ? d.filed_at.slice(0, 10) : new Date().toISOString().slice(0, 10);
          input.style.marginRight = '6px';
          const btn = document.createElement('button');
          btn.type = 'button'; btn.className = 'btn'; btn.textContent = 'Mark as Filed';
          btn.addEventListener('click', async () => {
            const filedAt = input.value ? new Date(input.value + 'T12:00:00').toISOString() : null;
            await appApi.dbRun('UPDATE documents SET filed_at = ?, updated_at = ? WHERE id = ?',
              [filedAt, new Date().toISOString(), d.id]);
            d.filed_at = filedAt;
            renderFiledControl(false);
          });
          filedWrap.append(input, btn);
        }
      };
      renderFiledControl(false);
      div.append(filedWrap, document.createElement('br'));

      // A13: the app only ever points at these paths, never manages them —
      // so this is the one place it looks, right where the file is about to
      // be offered, rather than waiting for a click to discover it's gone.
      if (d.pdf_path || d.docx_path) {
        const missingTag = document.createElement('span');
        missingTag.className = 'missing-file-tag hidden';
        missingTag.textContent = '⚠ missing';
        div.appendChild(missingTag);
        (async () => {
          const checks = await Promise.all(
            [d.pdf_path, d.docx_path].filter(Boolean).map(p => appApi.pathExists(p)));
          if (checks.some(exists => !exists)) missingTag.classList.remove('hidden');
        })();
        div.appendChild(document.createElement('br'));
      }

      // A11: quiet, dismissible reminder to scan and physically file this
      // printout. Only for a document that actually has a printed file, and
      // only until dismissed — never asks again after that.
      if ((d.pdf_path || d.docx_path) && !d.scan_reminder_done) {
        const note = document.createElement('div');
        note.className = 'quiet-note';
        note.style.margin = '4px 0';
        const text = document.createElement('span');
        text.textContent = 'Don’t forget: scan this and put the physical copy away. ';
        const doneLink = document.createElement('a');
        doneLink.href = '#'; doneLink.textContent = 'Done';
        doneLink.addEventListener('click', async (e) => {
          e.preventDefault();
          await appApi.dbRun('UPDATE documents SET scan_reminder_done = 1 WHERE id = ?', [d.id]);
          note.remove();
        });
        note.append(text, doneLink);
        div.appendChild(note);
      }

      if (d.pdf_path) {
        const open = document.createElement('a');
        open.href = '#'; open.style.color = '#003399'; open.style.marginRight = '10px';
        open.textContent = 'Open PDF';
        open.addEventListener('click', async (e) => {
          e.preventDefault();
          const res = await appApi.openPath(d.pdf_path);
          if (!res.ok) alert(res.error);
        });
        div.append(open);
      }
      if (d.docx_path) {
        const open = document.createElement('a');
        open.href = '#'; open.style.color = '#003399'; open.style.marginRight = '10px';
        open.textContent = 'Open Word';
        open.addEventListener('click', async (e) => {
          e.preventDefault();
          const res = await appApi.openPath(d.docx_path);
          if (!res.ok) alert(res.error);
        });
        div.append(open);
      }
      if (d.pdf_path || d.docx_path) {
        const showBtn = document.createElement('a');
        showBtn.href = '#'; showBtn.style.color = '#003399'; showBtn.style.marginRight = '10px';
        showBtn.textContent = 'Show in Folder';
        showBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          const res = await appApi.showInFolder(d.docx_path || d.pdf_path);
          if (!res.ok) alert(res.error);
        });
        div.append(showBtn);
      }

      const regen = document.createElement('a');
      regen.href = '#'; regen.style.color = '#003399';
      regen.textContent = 'Regenerate…';
      regen.addEventListener('click', (e) => { e.preventDefault(); loadDocToGenerate(d.id); });
      div.append(regen);

      list.appendChild(div);
    });
  }

  // ---- People ---------------------------------------------------------------

  // Every `people` column the profile form owns, in screen order. The id of
  // each input is 'per-' + the column name, and the INSERT/UPDATE column lists
  // are built from this array — never hand-written — so a field can never
  // silently stop being saved.
  //
  // The array itself is no longer written here: it is derived from
  // INTAKE_FIELDS in document-engine.js, the single ordered list the printable
  // blank questionnaire is also built from. Two hand-maintained lists is
  // exactly how the paper form ends up a year behind the screen.
  const PERSON_FIELDS = window.INTAKE_FIELDS.map(f => f.col);

  // The INTEGER columns bound to checkboxes: read and write `.checked ? 1 : 0`,
  // never `.value` (which is the literal string "on"). Same source — a new
  // checkbox field is a checkbox in both places or in neither.
  const PERSON_BOOL_FIELDS = new Set(
    window.INTAKE_FIELDS.filter(f => f.kind === 'checkbox').map(f => f.col));

  // The label on screen is the label on paper, taken from the same entry. The
  // markup carries a label as a placeholder for readability; this is what it
  // actually says, so a relabelled field cannot say one thing in the office and
  // another in the waiting room.
  function applyIntakeLabels() {
    window.INTAKE_FIELDS.forEach(f => {
      const el = document.getElementById('per-' + f.col);
      if (!el) return;
      const group = el.closest('.form-group');
      const lab = group && group.querySelector('label');
      if (lab) lab.textContent = f.label;
    });
  }
  applyIntakeLabels();

  // The address as it prints: street on line one, "City, ST Zip" on line two.
  //
  // `address` is the pre-migration-24 fallback. Migration 24 back-filled
  // street/city/zip only from blobs it could parse unambiguously and left the
  // rest alone, so the fallback is not decoration: without it, every client
  // whose old address had three lines or an apartment number would have their
  // letters go out with a blank address block.
  //
  // Normalisation happens HERE, on the way out, and never to the stored value.
  // "Exampleton, mi" and "Exampleton , MI" both print as "Exampleton, MI" because a letter
  // should not show a lower-case state code, but the database keeps what the
  // human typed — silently rewriting a field behind someone's back turns a
  // deliberate entry into a mystery. The state pattern is anchored and exactly
  // two letters for the same reason parseLegacyAddress uses [^,]+ for the city:
  // a permissive pattern would start reformatting text it does not understand.
  function composePersonAddress(p) {
    if (!p) return '';
    const city = String(p.city == null ? '' : p.city).trim()
      .replace(/\s+,/g, ',')
      .replace(/,\s*([A-Za-z]{2})$/, (_, st) => `, ${st.toUpperCase()}`);
    const zip = String(p.zip == null ? '' : p.zip).trim();
    const street = String(p.street == null ? '' : p.street).trim();
    const line2 = [city, zip].filter(Boolean).join(' ').trim();
    const composed = [street, line2].filter(Boolean).join('\n');

    // All THREE parts, not "street plus something". An earlier version tested
    // `street && line2`, and line2 is non-empty when EITHER city or zip is
    // filled — so a client with street+city and no zip printed a letter with no
    // ZIP, and street+zip with no city printed "9 Elm St / 48000". Both went out
    // looking deliberate.
    if (!street || !city || !zip) {
      const legacy = String(p.address == null ? '' : p.address).trim();
      if (legacy) return p.address;
      // Nothing better exists — a partial address beats none at all.
      return composed;
    }

    // A composed address is only trusted when all three parts are present. Partial
    // street/city/zip must NOT beat the legacy blob: migration 24 deliberately
    // skipped every address it could not parse unambiguously (apartment lines,
    // three-line addresses), so for those clients `address` holds the only
    // complete address on file. Staff filling in just the City and ZIP boxes on
    // such a profile — three independent inputs, nothing requiring them
    // together — would otherwise silently mail a street-less letter.
    // Falling back to the whole blob is always safe: it is what printed before
    // this split existed.
    return composed;
  }
  // The smoke test reaches this directly; it has no other window consumer.
  window.composePersonAddress = composePersonAddress;
  // Exposed for the smoke harness, which drives the profile form directly.
  window.openPerson = (id) => openPerson(id);
  // The smoke harness drives an unawaited save to reproduce the mid-save
  // navigation race; it has no other consumer.
  window.savePriorsForTest = (id) => savePriors(id);
  // The smoke harness needs to simulate "this form was just saved" without
  // running a whole save; it has no other consumer.
  window.markFormCleanForTest = (viewId) => markFormClean(viewId);
  // The harness drives an unawaited save against a live navigation to
  // reproduce the cross-matter race; these have no other consumer.
  window.saveMatterForTest = () => saveMatter({ silent: true });
  window.openMatterForTest = (id) => openMatter(id);
  window.openPacketForTest = (id) => openPacket(id);

  // A license number only means anything once the license itself is ticked.
  const LICENCE_NUMBER_WRAPS = {
    cdl_license: 'wrap-cdl_number',
    chauffeur_license: 'wrap-chauffeur_number',
    cpl_license: 'wrap-cpl_number'
  };

  function syncLicenceNumbers() {
    for (const [flag, wrapId] of Object.entries(LICENCE_NUMBER_WRAPS)) {
      const on = document.getElementById('per-' + flag).checked;
      document.getElementById(wrapId).classList.toggle('hidden', !on);
    }
  }

  Object.keys(LICENCE_NUMBER_WRAPS).forEach(flag => {
    document.getElementById('per-' + flag).addEventListener('change', syncLicenceNumbers);
  });

  // Section headers collapse their own fieldset. The attribute is the state;
  // CSS does the hiding.
  document.querySelectorAll('#view-person-detail .section-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const sec = btn.closest('.section');
      if (sec.hasAttribute('data-collapsed')) sec.removeAttribute('data-collapsed');
      else sec.setAttribute('data-collapsed', '');
    });
  });

  // A dot on the legend of a section that holds answers. Four sections start
  // collapsed, so without it the user has to open all four on every client just to
  // learn whether there is anything inside. It is only worth anything if it
  // goes OUT again: a marker that is always lit says nothing.
  //
  // A checkbox counts only when it is CHECKED. An unchecked checkbox reports a
  // `.value` of the string "on", so reading `.value` here would light Medical
  // for every client in the book — the same trap that made the save path read
  // `.checked ? 1 : 0` instead.
  //
  // Prior Record owns no `per-*` inputs; it is the repeating table rendered
  // from the `priors` array, so its marker asks the array. Reading the rendered
  // inputs would also count a blank row someone just added and abandoned.
  function sectionHasAnswers(sec) {
    if (sec.id === 'sec-priors') return priors.length > 0;
    return [...sec.querySelectorAll('.section-body input, .section-body select, .section-body textarea')]
      .some(el => (el.type === 'checkbox' || el.type === 'radio')
        ? el.checked
        : String(el.value == null ? '' : el.value).trim() !== '');
  }

  // `blank` is the brand-new-person case: nothing has been entered yet, so no
  // section is marked — not even Identity, whose Type select defaults to
  // "individual" and would otherwise light a dot on an empty form.
  function syncFilledMarkers({ blank = false } = {}) {
    document.querySelectorAll('#view-person-detail .section').forEach(sec => {
      const dot = sec.querySelector('.section-filled');
      if (!dot) return;
      dot.classList.toggle('hidden', blank || !sectionHasAnswers(sec));
    });
  }

  function setPersonField(f, value) {
    const el = document.getElementById('per-' + f);
    if (PERSON_BOOL_FIELDS.has(f)) el.checked = !!value;
    else el.value = value == null ? '' : value;
  }

  // The Organization block's columns. Blank saves as NULL, not '': Task 8
  // joins `signing_attorney_id` to attorneys, and an empty string in an
  // INTEGER column is a text value that joins to nothing while looking set.
  const PERSON_OFFICE_FIELDS = new Set(
    window.INTAKE_FIELDS.filter(f => f.office).map(f => f.col));

  function readPersonField(f) {
    const el = document.getElementById('per-' + f);
    if (PERSON_BOOL_FIELDS.has(f)) return el.checked ? 1 : 0;
    if (PERSON_OFFICE_FIELDS.has(f)) {
      const v = String(el.value || '').trim();
      if (!v) return null;
      return f === 'signing_attorney_id' ? Number(v) : v;
    }
    return el.value;
  }

  // Organization-only fields sit directly under Type. Hiding them is purely
  // visual: the inputs keep their values and the save still writes them, so a
  // profile flipped to Individual by mistake loses nothing.
  function syncOrgFields() {
    const isOrg = document.getElementById('per-kind').value === 'organization';
    document.getElementById('wrap-org-fields').classList.toggle('hidden', !isOrg);
    // A company has no birthday (personIssues skips it too).
    document.getElementById('wrap-per-dob').classList.toggle('hidden', isOrg);
  }
  document.getElementById('per-kind').addEventListener('change', syncOrgFields);

  // "Signs as": every signing profile, labelled exactly as the attorney list
  // labels it; the blank first option means "no default for this client".
  //
  // A stored id whose profile no longer exists (a backup restored over a
  // newer attorney list, a de-duplicating migration) is kept as its own option
  // reading "(no longer available)" rather than dropped. Dropping it would show
  // blank and then save NULL the next time anyone saved the profile for an
  // unrelated reason — silently changing who signs. Shown, the user sees it
  // and picks a real one; untouched, it round-trips as it was, and Task 8's
  // precedence treats a dangling id as "not set" because the join finds nothing.
  function fillSigningAttorneys(atts, selectedId) {
    const sel = document.getElementById('per-signing_attorney_id');
    sel.innerHTML = '';
    sel.appendChild(new Option('', ''));
    (atts || []).forEach(a => sel.appendChild(new Option(a.label || a.firm_name || a.name, a.id)));
    if (selectedId != null && selectedId !== '' && !(atts || []).some(a => String(a.id) === String(selectedId))) {
      sel.appendChild(new Option('(no longer available)', selectedId));
    }
    sel.value = selectedId == null ? '' : String(selectedId);
  }
  // Bumped by every openPerson, so an attorney list that arrives after the
  // user has already moved to another profile is thrown away, not applied.
  let signingOptionsSeq = 0;
  const SIGNING_ATTORNEYS_SQL = 'SELECT id, label, firm_name, name FROM attorneys ORDER BY id';

  // Which column the People list is ordered by. Name ascending is the order
  // the list has always had, and stays the default.
  let peopleSort = { key: 'name', dir: 'asc' };

  // Contacts (is_contact = 1: judges, clerks, opposing counsel) are people
  // rows too, but they are listed under Contacts, not here.
  async function loadPeople() {
    const term = (document.getElementById('people-search').value || '').trim().toLowerCase();
    const showArchived = document.getElementById('people-show-archived').checked;
    const rows = await appApi.dbAll(
      `SELECT p.*, (SELECT COUNT(DISTINCT matter_id) FROM parties WHERE person_id = p.id) AS matter_count
       FROM people p
       WHERE p.is_contact = 0 ${showArchived ? '' : 'AND p.archived = 0'}
       ORDER BY p.display_name COLLATE NOCASE`
    );
    // Every open court date in the firm, in one query, keyed by person: a
    // client with three cases has three streams and the list shows the soonest
    // across all of them (design §7).
    const eventRows = await appApi.dbAll(
      `SELECT pa.person_id AS person_id, e.event_type, e.event_date, e.done
         FROM matter_events e
         JOIN parties pa ON pa.matter_id = e.matter_id`);
    const today = todayISO();
    const byPerson = groupBy(eventRows, 'person_id');
    const nextByPerson = new Map();
    byPerson.forEach((evts, pid) => {
      const next = nextCourtDate(evts, today);
      if (next) nextByPerson.set(pid, next);
    });
    updatePeopleSortHeaders();
    const list = document.getElementById('people-list');
    list.innerHTML = '';
    const filtered = rows.filter(r => !term || (r.display_name || '').toLowerCase().includes(term));
    if (!filtered.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.style.color = '#666';
      td.textContent = term ? 'No people match that search.' : 'No people yet.';
      tr.appendChild(td);
      list.appendChild(tr);
      return;
    }
    const byName = (a, b) => {
      const x = (a.display_name || '').toLowerCase(), y = (b.display_name || '').toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    };
    const ordered = filtered.slice();
    if (peopleSort.key === 'next') {
      ordered.sort((a, b) => {
        const na = nextByPerson.get(a.id), nb = nextByPerson.get(b.id);
        // A person with no court date sorts LAST in BOTH directions, never by
        // the direction flag: a null that sorts to the top buries every client
        // who actually has a hearing coming under the ones who have none.
        if (!na && !nb) return byName(a, b);
        if (!na) return 1;
        if (!nb) return -1;
        const c = na.event_date < nb.event_date ? -1 : na.event_date > nb.event_date ? 1 : 0;
        return peopleSort.dir === 'desc' ? -c : c;
      });
    } else if (peopleSort.dir === 'desc') {
      ordered.reverse();
    }
    ordered.forEach(p => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      // textContent throughout: names are user data and must not be parsed as HTML.
      const name = document.createElement('td');
      name.textContent = p.display_name + (p.archived ? '  (archived)' : '');
      const kind = document.createElement('td');
      kind.textContent = p.kind === 'organization' ? 'Organization' : 'Individual';
      const firm = document.createElement('td');
      firm.textContent = p.firm_name || '';
      // Blank, not "undefined", for a client with nothing coming up.
      const next = nextByPerson.get(p.id) || null;
      const nextTd = document.createElement('td');
      nextTd.className = 'next-date' + (next && next.overdue ? ' overdue' : '');
      nextTd.textContent = next ? next.event_date : '';
      if (next) nextTd.title = nextDateLabel(next);
      const count = document.createElement('td');
      count.textContent = String(p.matter_count);
      count.style.textAlign = 'right';
      tr.append(name, kind, firm, nextTd, count);
      tr.addEventListener('click', () => openPerson(p.id));
      list.appendChild(tr);
    });
  }

  // The heading keeps the words "Next date" whichever way it is sorted; only
  // the arrow moves.
  function updatePeopleSortHeaders() {
    const arrow = (key) => (peopleSort.key === key ? (peopleSort.dir === 'asc' ? ' \u25b2' : ' \u25bc') : '');
    const nameTh = document.getElementById('people-sort-name');
    const nextTh = document.getElementById('people-sort-next');
    if (nameTh) nameTh.textContent = 'Name' + arrow('name');
    if (nextTh) nextTh.textContent = 'Next date' + arrow('next');
  }

  function sortPeopleBy(key) {
    peopleSort = { key, dir: peopleSort.key === key && peopleSort.dir === 'asc' ? 'desc' : 'asc' };
    loadPeople();
  }

  document.getElementById('people-sort-name').addEventListener('click', () => sortPeopleBy('name'));
  document.getElementById('people-sort-next').addEventListener('click', () => sortPeopleBy('next'));
  document.getElementById('people-search').addEventListener('input', loadPeople);
  document.getElementById('people-show-archived').addEventListener('change', loadPeople);
  document.getElementById('btn-new-person').addEventListener('click', () => openPerson(null));
  document.getElementById('btn-back-person').addEventListener('click', () => { showView('people'); loadPeople(); });

  // The client's prior record, in print order. An ordered in-memory array
  // rendered to DOM nodes and re-inserted wholesale on save, exactly like
  // captionNotes. It lives outside openPerson, which is precisely why
  // openPerson must reset it on every entry: a prior record left over from the
  // last client would render as this client's own.
  let priors = [];

  // Columns and their headings come from INTAKE_PRIOR_COLUMNS — the same list
  // the printed questionnaire's prior-record table is built from — with only
  // the on-screen layout hints added here.
  const PRIOR_UI = {
    offense: { placeholder: 'e.g. OWI, 1st offense', flex: '2 1 200px' },
    jurisdiction: { placeholder: 'e.g. 90th District', flex: '1 1 140px' },
    offense_date: { type: 'date', flex: '0 0 140px' },
    location: { placeholder: "e.g. O'Brien County", flex: '1 1 140px' },
    disposition: { placeholder: 'e.g. Pleaded, 12 mo probation', flex: '1 1 160px' }
  };
  const PRIOR_FIELDS = window.INTAKE_PRIOR_COLUMNS.map(c => ({ ...c, ...(PRIOR_UI[c.col] || {}) }));

  // Built with document.createElement and never an HTML string. Offenses carry
  // jurisdiction and place names — "O'Brien County", "St. Mary's" — and a
  // string-built row breaks on the first apostrophe. Same reason the party rows
  // are built this way.
  function renderPriors() {
    const list = document.getElementById('priors-list');
    if (!list) return;
    list.innerHTML = '';
    priors.forEach((p, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:4px; align-items:flex-end; margin-bottom:6px; flex-wrap:wrap;';

      PRIOR_FIELDS.forEach(f => {
        const wrap = document.createElement('div');
        wrap.style.cssText = `display:flex; flex-direction:column; flex:${f.flex};`;
        const lab = document.createElement('label');
        lab.textContent = f.label;
        lab.style.cssText = 'font-size:0.8em; color:#666;';
        const input = document.createElement('input');
        input.type = f.type || 'text';
        if (f.placeholder) input.placeholder = f.placeholder;
        input.dataset.field = f.col;
        input.value = p[f.col] || '';
        input.addEventListener('input', () => { p[f.col] = input.value; });
        wrap.append(lab, input);
        if (f.type === 'date') withTodayButton(input); // A8
        row.appendChild(wrap);
      });

      const del = document.createElement('button');
      del.className = 'btn';
      del.type = 'button';
      del.textContent = 'X';
      del.title = 'Remove this prior';
      del.dataset.removePrior = String(idx);
      del.addEventListener('click', () => {
        syncPriorsFromDom();
        priors.splice(idx, 1);
        renderPriors();
      });
      row.appendChild(del);

      list.appendChild(row);
    });
    if (!priors.length) {
      const hint = document.createElement('div');
      hint.style.cssText = 'color:#666; font-size:0.9em; margin-bottom:6px;';
      hint.textContent = 'No prior record on file.';
      list.appendChild(hint);
    }
  }

  // Read the rows back out of the DOM before acting on the array. The per-input
  // listeners keep it live for ordinary typing, but a value set programmatically
  // fires no event, and the array is what gets written to the database.
  function syncPriorsFromDom() {
    const list = document.getElementById('priors-list');
    if (!list) return;
    const rows = [...list.children].filter(el => el.querySelector('[data-field]'));
    rows.forEach((rowEl, idx) => {
      if (!priors[idx]) return;
      PRIOR_FIELDS.forEach(f => {
        const input = rowEl.querySelector(`[data-field="${f.col}"]`);
        if (input) priors[idx][f.col] = input.value;
      });
    });
  }

  document.getElementById('btn-add-prior').addEventListener('click', () => {
    syncPriorsFromDom();
    priors.push(Object.fromEntries(PRIOR_FIELDS.map(f => [f.col, ''])));
    renderPriors();
    const inputs = document.querySelectorAll('#priors-list [data-field="offense"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  async function savePriors(personId) {
    // Nothing to delete against before the person exists; the caller passes the
    // freshly-inserted id, so this only ever runs with a real row.
    if (!personId) return;
    syncPriorsFromDom();

    // SNAPSHOT FIRST. `priors` is module-level state that openPerson reassigns
    // wholesale, and every dbRun below is an IPC round trip that yields to the
    // event loop — the UI stays clickable between iterations. Reading
    // `priors[i]` live across those awaits meant that navigating to another
    // client mid-save (the global search box is reachable from this screen)
    // wrote THAT client's prior offences onto THIS client's file, and dropped
    // the rows this client's own save had not reached yet. A criminal record
    // filed against the wrong person, silently.
    //
    // Same fix, same reason, as the caption-notes save below: snapshot into a
    // local const, then loop over the copy.
    const toSave = priors
      .filter(p => PRIOR_FIELDS.some(f => (p[f.col] || '').trim()))
      .map(p => Object.fromEntries(PRIOR_FIELDS.map(f => [f.col, p[f.col] || null])));

    // One transaction: the DELETE and every INSERT commit together or not at
    // all. Without it, an INSERT throwing partway leaves the record half
    // deleted with nothing to roll it back and no error the user ever sees.
    await appApi.dbTransaction([
      { sql: 'DELETE FROM person_priors WHERE person_id = ?', params: [personId] },
      ...toSave.map((p, i) => ({
        sql: `INSERT INTO person_priors (person_id, offense, jurisdiction, offense_date, location, disposition, sort_order)
              VALUES (?,?,?,?,?,?,?)`,
        params: [personId, p.offense, p.jurisdiction, p.offense_date, p.location, p.disposition, i]
      }))
    ]);
  }

  async function openPerson(id) {
    showView('person-detail');
    document.getElementById('per-id').value = id || '';
    const note = document.getElementById('person-archived-note');
    const casesEl = document.getElementById('person-cases');

    if (!id) {
      PERSON_FIELDS.forEach(f => setPersonField(f, ''));
      priors = [];
      renderPriors();
      document.getElementById('per-kind').value = 'individual';
      syncOrgFields();
      {
        const seq = ++signingOptionsSeq;
        appApi.dbAll(SIGNING_ATTORNEYS_SQL).then(atts => {
          if (seq === signingOptionsSeq) fillSigningAttorneys(atts, null);
        }).catch(() => {});
      }
      syncLicenceNumbers();
      syncFilledMarkers({ blank: true });
      note.textContent = '';
      casesEl.textContent = 'Save person first.';
      document.getElementById('person-payments').textContent = 'Save person first.';
      renderPersonDocuments(null);
      document.getElementById('person-archive-foot').classList.add('hidden');
      renderIssueList(document.getElementById('person-issues'), [], 'Still needed:');
      return;
    }

    // Reset first, then load. Clearing only on the way in means a person who
    // fails to load cannot leave the previous client's record on screen.
    priors = [];
    renderPriors();
    clearPersonDocuments('Loading\u2026');

    // One await for both, so the select's options exist before its value is set.
    const seq = ++signingOptionsSeq;
    const [p, signingAtts] = await Promise.all([
      appApi.dbGet('SELECT * FROM people WHERE id = ?', [id]),
      appApi.dbAll(SIGNING_ATTORNEYS_SQL)
    ]);
    if (!p || seq !== signingOptionsSeq) return;
    fillSigningAttorneys(signingAtts, p.signing_attorney_id);
    PERSON_FIELDS.forEach(f => setPersonField(f, p[f]));
    syncOrgFields();
    const loadedPriors = await appApi.dbAll(
      `SELECT offense, jurisdiction, offense_date, location, disposition
       FROM person_priors WHERE person_id = ? ORDER BY sort_order, id`, [id]);
    // Another profile opened while the priors loaded: they, the issues and
    // the notes below belong to this one, not to what is on screen now.
    if (seq !== signingOptionsSeq) return;
    priors = loadedPriors;
    renderPriors();
    syncLicenceNumbers();
    // After every field is populated, and after the priors array is loaded —
    // the markers describe THIS client, and a dot left over from the previous
    // one is the same leak the priors reset above guards against.
    syncFilledMarkers();
    note.textContent = p.archived ? 'This person is archived and hidden from pickers.' : '';
    const archiveBtn = document.getElementById('btn-archive-person');
    document.getElementById('person-archive-foot').classList.remove('hidden');
    archiveBtn.textContent = p.archived ? 'Restore' : 'Archive';
    renderIssueList(document.getElementById('person-issues'), personIssues(p), 'Still needed:');
    await renderPersonCases(id);
    await renderPersonPayments(id);
    await renderPersonWorkProduct(id);
    await renderPersonDocuments(id);
    await renderPersonActivity(id);
  }

  // A6: the activity log rolled up onto the client profile. Matter-scoped
  // events (document generated, stage changed, ...) reach here by joining
  // through parties — a matter with several client-parties still logs one
  // row, not one per party. Read-only, newest first, nothing here writes.
  async function renderPersonActivity(personId) {
    const el = document.getElementById('person-activity');
    if (!personId) { el.textContent = 'Save person first.'; return; }
    const rows = await appApi.dbAll(
      `SELECT description, created_at FROM activity_log WHERE person_id = ?
       UNION
       SELECT al.description, al.created_at FROM activity_log al
         JOIN parties pa ON pa.matter_id = al.matter_id WHERE pa.person_id = ?
       ORDER BY created_at DESC LIMIT 50`, [personId, personId]);
    renderActivityRows(el, rows);
  }

  // A6: the activity log on a matter's own page. Read-only, newest first.
  async function renderMatterActivity(matterId) {
    const el = document.getElementById('matter-activity');
    if (!matterId) { el.textContent = 'Save matter first.'; return; }
    const rows = await appApi.dbAll(
      `SELECT description, created_at FROM activity_log
       WHERE matter_id = ? ORDER BY created_at DESC LIMIT 50`, [matterId]);
    renderActivityRows(el, rows);
  }

  function renderActivityRows(el, rows) {
    el.innerHTML = '';
    if (!rows.length) { el.textContent = 'No activity yet.'; return; }
    el.className = 'activity-list';
    rows.forEach(r => {
      const row = document.createElement('div');
      row.className = 'activity-row';
      const desc = document.createElement('span');
      desc.textContent = r.description;
      const date = document.createElement('span');
      date.className = 'activity-date';
      date.textContent = String(r.created_at || '').slice(0, 10);
      row.append(desc, date);
      el.appendChild(row);
    });
  }

  // ---- Court-date roll-up (design §7: record and roll up) ------------------
  //
  // Deliberately bounded: no calendar view, no firm-wide docket, no
  // notifications, and no computed deadlines — a wrong appeal window is worse
  // than no appeal window. Everything below is a read-only view over
  // matter_events; none of it writes, and none of it moves a stage.
  //
  // Dates are stored as the ISO strings an <input type="date"> produces, which
  // compare chronologically as plain strings. Anything that is not exactly
  // YYYY-MM-DD is ignored rather than sorted on: junk that sorts wrong reads as
  // a real hearing date, which is the one thing this must never show.
  function todayISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function isIsoDate(v) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());
  }

  // A8: shared "Today" button for every date field in the app. Wraps the
  // input in place (it must already be attached to the DOM) so it drops
  // into any existing layout without that layout needing to know about it.
  // Fires both 'input' and 'change' — fields in this codebase listen on
  // one or the other, never consistently the same one.
  function withTodayButton(inputEl) {
    const wrap = document.createElement('span');
    wrap.className = 'date-today-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn today-btn';
    btn.textContent = 'Today';
    btn.title = 'Set to today';
    btn.addEventListener('click', () => {
      inputEl.value = todayISO();
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    });
    inputEl.replaceWith(wrap);
    wrap.append(inputEl, btn);
    return wrap;
  }

  // The one rule, shared by both roll-ups so the profile and the People list
  // can never disagree about what is next.
  //
  //   * A date ticked Done is never next. It happened; that is what the tick
  //     means. It stays on the case, it just stops counting.
  //   * "Next" is the soonest not-done date that has NOT already passed.
  //   * A not-done date that HAS passed is overdue, not next. It is returned
  //     with overdue = true and rendered distinctly, in preference to any
  //     later date: hiding a hearing that has already gone by behind next
  //     month's pretrial is exactly the failure this feature exists to avoid.
  //
  // Returns null when there is nothing to show — the callers render a blank,
  // never the string "undefined".
  function nextCourtDate(rows, today) {
    const usable = (rows || [])
      .filter(r => !Number(r.done) && isIsoDate(r.event_date))
      .map(r => ({ event_type: (r.event_type || '').trim(), event_date: String(r.event_date).trim() }))
      .sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : 0));
    if (!usable.length) return null;
    const overdue = usable.filter(r => r.event_date < today);
    const pick = overdue.length ? overdue[0] : usable.find(r => r.event_date >= today);
    if (!pick) return null;
    return { ...pick, overdue: pick.event_date < today };
  }

  // Groups rows by a column into a Map, so one query answers a whole list.
  function groupBy(rows, key) {
    const map = new Map();
    (rows || []).forEach(r => {
      if (!map.has(r[key])) map.set(r[key], []);
      map.get(r[key]).push(r);
    });
    return map;
  }

  function nextDateLabel(next) {
    return `${next.event_type || 'Court date'} \u2014 ${next.event_date}${next.overdue ? ' (overdue)' : ''}`;
  }

  async function renderPersonCases(personId) {
    const el = document.getElementById('person-cases');
    const rows = await appApi.dbAll(
      `SELECT DISTINCT m.id, m.short_name, m.case_number, m.client_role, m.output_dir, pa.side
       FROM parties pa JOIN matters m ON m.id = pa.matter_id
       WHERE pa.person_id = ? ORDER BY m.created_at DESC`, [personId]);
    // One query for every case on the panel, grouped in memory — a query per
    // row would fan out with the client's caseload.
    const eventRows = await appApi.dbAll(
      `SELECT e.matter_id, e.event_type, e.event_date, e.done
         FROM matter_events e
        WHERE e.matter_id IN (SELECT matter_id FROM parties WHERE person_id = ?)`, [personId]);
    const byMatter = groupBy(eventRows, 'matter_id');
    const today = todayISO();
    el.innerHTML = '';
    if (!rows.length) { el.textContent = 'Not on any matter yet.'; return; }
    rows.forEach(r => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:4px 0; border-bottom:1px solid #d4d4d4; display:flex; justify-content:space-between; gap:8px;';
      const left = document.createElement('a');
      left.href = '#';
      left.style.color = '#003399';
      left.textContent = r.short_name;
      left.addEventListener('click', (e) => { e.preventDefault(); openMatter(r.id); });
      const right = document.createElement('span');
      right.style.cssText = 'color:#555; white-space:nowrap;';
      right.textContent = r.case_number || '—';
      row.append(left, right);
      const sub = document.createElement('div');
      sub.style.cssText = 'font-size:0.85em; color:#666;';
      sub.textContent = `as ${r.side}`;
      const next = nextCourtDate(byMatter.get(r.id), today);
      if (next) {
        const tag = document.createElement('span');
        tag.className = 'next-date' + (next.overdue ? ' overdue' : '');
        tag.textContent = nextDateLabel(next);
        sub.append(document.createTextNode(' \u00b7 '), tag);
      }
      // A case's files live in ONE folder, under whichever client owns it
      // (design rule 2: no copies). This link is how a second client on a
      // shared case reaches it. Only once the folder exists — a case nothing
      // has been saved for yet still has its owner to decide, and viewing a
      // profile must not decide it. matterFolder returns the frozen path.
      if (r.output_dir) {
        const open = document.createElement('a');
        open.href = '#';
        open.style.color = '#003399';
        open.textContent = 'Open Folder';
        open.addEventListener('click', async (e) => {
          e.preventDefault();
          const res = await appApi.matterFolder(r.id);
          if (!res || res.error || !res.dir) { alert((res && res.error) || 'Could not find this case’s folder.'); return; }
          const opened = await appApi.openPath(res.dir);
          if (!opened || !opened.ok) alert(`Could not open the folder.\n\n${(opened && opened.error) || ''}`);
        });
        sub.append(document.createTextNode(' \u00b7 '), open);
      }
      row.appendChild(sub);
      el.appendChild(row);
    });
  }

  // A7: paid-to-date per matter, rolled up onto the client profile the same
  // way court dates are — recorded on the matter, read-only here. No
  // balance/owed figure: fee_quoted is free text with nothing numeric to
  // subtract from.
  async function renderPersonPayments(personId) {
    const el = document.getElementById('person-payments');
    const rows = await appApi.dbAll(
      `SELECT DISTINCT m.id, m.short_name, m.case_number
       FROM parties pa JOIN matters m ON m.id = pa.matter_id
       WHERE pa.person_id = ? ORDER BY m.created_at DESC`, [personId]);
    const paymentRows = await appApi.dbAll(
      `SELECT matter_id, amount_cents FROM matter_payments
       WHERE matter_id IN (SELECT matter_id FROM parties WHERE person_id = ?)`, [personId]);
    const byMatter = groupBy(paymentRows, 'matter_id');
    el.innerHTML = '';
    if (!rows.length) { el.textContent = 'Not on any matter yet.'; return; }
    rows.forEach(r => {
      const total = (byMatter.get(r.id) || []).reduce((sum, p) => sum + (Number(p.amount_cents) || 0), 0);
      const row = document.createElement('div');
      row.className = 'home-row';
      const left = document.createElement('a');
      left.href = '#';
      left.style.color = '#003399';
      left.textContent = r.short_name;
      left.addEventListener('click', (e) => { e.preventDefault(); openMatter(r.id); });
      const right = document.createElement('span');
      right.textContent = `Paid to date: ${centsToDollars(total)}`;
      row.append(left, right);
      el.appendChild(row);
    });
  }

  // Everything this client has had produced for them — court filings AND
  // letters, in one list. The panel this replaced asked only for
  // kind = 'standalone_letter' joined on recipient_person_id, so a filing
  // generated on the client's own case never showed up on their page at all.
  //
  // Packets reach a person two ways, and both count: a letter names them as
  // the recipient, a filing belongs to a matter they are a party to. Hence the
  // OR, and hence DISTINCT — the same person can sit on a matter more than
  // once (both sides of a caption, or two party rows), and the parties join
  // would otherwise repeat one filing per party row. A doubled row here reads
  // as "I filed this twice", which is exactly the wrong thing to tell the user.
  async function renderPersonWorkProduct(personId) {
    const el = document.getElementById('person-work-product');
    const rows = await appApi.dbAll(
      `SELECT DISTINCT pk.id, pk.kind, pk.label, pk.matter_id, pk.packet_date, pk.created_at,
              m.short_name
       FROM packets pk
       LEFT JOIN matters m ON m.id = pk.matter_id
       LEFT JOIN parties pa ON pa.matter_id = m.id
       WHERE pk.recipient_person_id = ? OR pa.person_id = ?
       ORDER BY COALESCE(pk.packet_date, pk.created_at) DESC`, [personId, personId]);
    el.innerHTML = '';
    if (!rows.length) { el.textContent = 'None yet.'; return; }
    rows.forEach(r => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:4px 0; border-bottom:1px solid #d4d4d4;';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex; justify-content:space-between; gap:8px;';
      const left = document.createElement('a');
      left.href = '#';
      left.style.color = '#003399';
      const def = window.DocumentEngine.packets.find(d => d.id === r.kind);
      left.textContent = r.label || (def ? def.label : r.kind);
      left.addEventListener('click', (e) => {
        e.preventDefault();
        // A standalone letter is deliberately opened with no matter context,
        // exactly as "Create Letter" does — even when the letter carries a
        // matter_id. A filing opened from here must instead land in its own
        // matter's context, the same as clicking it in that matter's packet
        // list; leaving a stale matter behind is how a packet gets generated
        // against the wrong case.
        currentMatterId = r.kind === 'standalone_letter' ? null : (r.matter_id || null);
        currentPacketId = r.id;
        openPacket(r.id);
      });
      const right = document.createElement('span');
      right.style.cssText = 'color:#555; white-space:nowrap;';
      right.textContent = r.packet_date || '(no date)';
      head.append(left, right);
      row.appendChild(head);
      if (r.short_name) {
        const sub = document.createElement('div');
        sub.style.cssText = 'font-size:0.85em; color:#666;';
        sub.textContent = r.short_name;
        row.appendChild(sub);
      }
      el.appendChild(row);
    });
  }

  // --- One document add at a time, app-wide ----------------------------------
  //
  // Scans are added from four places: the profile's Documents panel, the Add
  // Documents screen (and the Home panel that opens it), and the case screen.
  // They all end in the same copy, so they share ONE flag. While any add is in
  // flight — dialog open or files copying — every other entry point is turned
  // away with a message. Two adds side by side could send the same files twice,
  // and would break the Add Documents screen's "did anything land" check,
  // which counts rows recorded after the add started.
  //
  // The buttons are marked aria-disabled, not disabled. A disabled button
  // swallows the click without a word, and the case screen's button — one
  // element shared by every case — just looked dead. This way the click still
  // arrives, and the handler, which checks the flag (never the button, whose
  // look may not have caught up yet), says why nothing happened.
  let docAddInFlight = false;
  const DOC_ADD_BUSY_MSG = 'Still adding the last files. Try again once that finishes.';
  const DOC_ADD_BUTTONS = ['btn-add-client-document', 'btn-adddocs-choose',
    'btn-adddocs-add-held', 'btn-matter-add-documents'];

  function paintDocAddButtons() {
    DOC_ADD_BUTTONS.forEach(id => {
      const b = document.getElementById(id);
      if (docAddInFlight) b.setAttribute('aria-disabled', 'true');
      else b.removeAttribute('aria-disabled');
    });
  }

  // True, with the user told why, when an add is already running. Every entry
  // point asks this first, before it awaits or takes anything.
  function docAddRefused() {
    if (!docAddInFlight) return false;
    alert(DOC_ADD_BUSY_MSG);
    return true;
  }

  // Runs one add under the flag. The check and the claim happen together,
  // before the first await, so two clicks in one tick cannot both get in.
  async function withDocAdd(run) {
    if (docAddRefused()) return null;
    docAddInFlight = true;
    paintDocAddButtons();
    try {
      return await run();
    } finally {
      docAddInFlight = false;
      paintDocAddButtons();
    }
  }

  // --- Documents panel -------------------------------------------------------
  //
  // The client's scanned paper. Rows are built with createElement, never from
  // an HTML string: the label is typed by the user and the filename comes off a
  // scanner, so both are user data that must not be parsed as markup.
  function clearPersonDocuments(message) {
    const el = document.getElementById('person-documents');
    el.innerHTML = '';
    el.textContent = message;
    document.getElementById('btn-add-client-document').disabled = true;
    document.getElementById('btn-open-client-folder').disabled = true;
  }

  // Where each uploaded file is comes from main (clientDocumentPaths): the
  // row stores its folder relative to the output root, and only main knows
  // this computer's root. The renderer never joins a stored folder itself.

  // The cases a person's documents can be filed under: only those where they
  // are a CLIENT. A case where they are the opposing party (or a witness)
  // lives inside another client's folder, and a scan filed there would land
  // in the wrong client's papers.
  function clientCases(personId) {
    return appApi.dbAll(
      `SELECT DISTINCT m.id, m.short_name, m.created_at
         FROM parties pa JOIN matters m ON m.id = pa.matter_id
        WHERE pa.person_id = ? AND pa.role = 'client'
        ORDER BY m.created_at DESC`, [personId]);
  }

  function buildClientDocRow(r, full, cases, personId) {
    const row = document.createElement('div');
    row.className = 'doc-row';
    row.dataset.docId = String(r.id);

    const label = document.createElement('input');
    label.type = 'text';
    label.className = 'doc-label';
    label.placeholder = 'Label (e.g. Police report)';
    label.value = r.label || '';
    label.addEventListener('change', () => appApi.dbRun(
      'UPDATE client_documents SET label = ? WHERE id = ?',
      [label.value.trim() || null, r.id]));

    const meta = document.createElement('div');
    meta.className = 'doc-meta';

    const date = document.createElement('input');
    date.type = 'date';
    date.className = 'doc-date';
    date.title = 'Date on the document';
    date.value = r.doc_date || '';
    date.addEventListener('change', () => appApi.dbRun(
      'UPDATE client_documents SET doc_date = ? WHERE id = ?',
      [date.value || null, r.id]));

    // Optional by design: client_documents.matter_id is nullable, because a
    // retainer or a license photocopy belongs to the client and to no case.
    // Only the RECORD changes here: the file stays in the folder it was first
    // copied into. Moving files between folders is deliberately not done.
    const sel = document.createElement('select');
    sel.className = 'doc-matter';
    sel.title = 'Case this document belongs to (optional). Changing it updates the record only; ' +
      'the file stays in the folder it was saved to.';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '(no case)';
    sel.appendChild(none);
    // `cases` holds only the cases this person is a CLIENT on. A row already
    // tied to some other case keeps showing it, so the list never claims
    // "(no case)" for a document that has one.
    const listed = r.matter_id && !cases.some(c => c.id === r.matter_id) && r.matter_short_name != null
      ? [...cases, { id: r.matter_id, short_name: r.matter_short_name }]
      : cases;
    listed.forEach(c => {
      const o = document.createElement('option');
      o.value = String(c.id);
      o.textContent = c.short_name || `Matter ${c.id}`;
      sel.appendChild(o);
    });
    sel.value = r.matter_id ? String(r.matter_id) : '';
    sel.addEventListener('change', () => appApi.dbRun(
      'UPDATE client_documents SET matter_id = ? WHERE id = ?',
      [sel.value ? Number(sel.value) : null, r.id]));
    meta.append(date, sel);
    withTodayButton(date); // A8

    const name = document.createElement('div');
    name.className = 'doc-name';
    name.textContent = r.filename;
    name.title = r.original_name && r.original_name !== r.filename
      ? `Added as ${r.original_name}` : r.filename;

    // A13: same as the matter Documents list — check on render, not on click.
    const missingTag = document.createElement('span');
    missingTag.className = 'missing-file-tag hidden';
    missingTag.textContent = '⚠ missing';
    appApi.pathExists(full).then(exists => { if (!exists) missingTag.classList.remove('hidden'); });

    const actions = document.createElement('div');
    actions.className = 'doc-actions';
    const mk = (text, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    actions.append(
      // Both of these reuse the IPC the packet list already opens files with.
      mk('Open', 'Open in the default application', async () => {
        const res = await appApi.openPath(full);
        if (res && !res.ok) alert(res.error);
      }),
      mk('Reveal', 'Show this file in the file manager', async () => {
        const res = await appApi.showInFolder(full);
        if (res && !res.ok) alert(res.error);
      }),
      // The row goes; the FILE stays. This app never silently destroys a scan —
      // the copy in the Clients folder may be the only one in existence, and a
      // user who reads "Remove" as "delete" would never find that out until it
      // mattered. Hence the wording, and hence no unlink here.
      mk('Remove', 'Take this off the list — the file itself is kept', async () => {
        const what = (r.label || '').trim() || r.filename;
        if (!confirm(`Remove "${what}" from this client's list? The file itself stays where it is on disk.`)) return;
        await appApi.dbRun('DELETE FROM client_documents WHERE id = ?', [r.id]);
        await renderPersonDocuments(personId);
      })
    );

    row.append(label, meta, name, missingTag, actions);
    return row;
  }

  async function renderPersonDocuments(personId) {
    const el = document.getElementById('person-documents');
    if (!personId) {
      // An unsaved person has no id to hang a document off, and — the part that
      // matters — must not be left showing the LAST client's list. That would
      // file one client's paperwork under another client's name.
      clearPersonDocuments('Save person first, then attach scans here.');
      return;
    }
    const rows = await appApi.dbAll(
      `SELECT cd.*, m.short_name AS matter_short_name
         FROM client_documents cd LEFT JOIN matters m ON m.id = cd.matter_id
        WHERE cd.person_id = ? ORDER BY cd.id`, [personId]);
    el.innerHTML = '';
    document.getElementById('btn-add-client-document').disabled = false;
    document.getElementById('btn-open-client-folder').disabled = false;
    if (!rows.length) {
      el.textContent = 'No documents attached yet.';
      return;
    }
    // Resolved in main. A pre-35 row (no stored_dir) sits in the client's own
    // folder, which main creates only when such a row exists.
    const paths = await appApi.clientDocumentPaths(personId);
    const cases = await clientCases(personId);
    rows.forEach(r => el.appendChild(buildClientDocRow(r, paths[r.id], cases, personId)));
  }

  // A copy can fail partway — a locked file the scanner is still writing, a
  // full disk, a source deleted between picking it and copying it. The files
  // copied before the failure are already recorded correctly, so the panel is
  // redrawn either way; what must not happen is silence. Without this, the
  // rejection is swallowed, the panel never refreshes, and someone is left
  // believing a scan attached when it did not.
  //
  // One add at a time, app-wide: see withDocAdd.
  async function attachClientDocuments(personId, run) {
    return withDocAdd(async () => {
      try {
        const res = await run();
        if (res && res.error) alert(`Nothing was added: ${res.error}`);
        return res;
      } catch (e) {
        alert(`Could not attach every file.\n\n${e && e.message ? e.message : e}\n\n` +
          'Anything that did copy across is listed below. Try the rest again.');
        return null;
      } finally {
        await renderPersonDocuments(personId);
      }
    });
  }

  async function addClientDocumentsFromPaths(paths) {
    const id = document.getElementById('per-id').value;
    if (!id || !paths.length) return;
    await attachClientDocuments(Number(id),
      () => appApi.addClientDocumentFiles(Number(id), paths));
  }

  document.getElementById('btn-add-client-document').addEventListener('click', async () => {
    if (docAddRefused()) return;
    const id = document.getElementById('per-id').value;
    if (!id) { alert('Save this person first, then attach their documents.'); return; }
    await attachClientDocuments(Number(id), () => appApi.addClientDocument(Number(id)));
  });

  // Electron NAVIGATES the whole renderer to a file dropped anywhere on the
  // window. The app blanks out, looks like a crash, and whatever was
  // half-typed on the form goes with it. Killing the default at the window
  // level is the only thing that stops it; the drop targets' own handlers (see
  // fileDropTarget) sit below the window and run first, so they still get
  // their files.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // Paths from a drop, or null (with the user told) when there are none.
  // Electron 32 REMOVED the old non-standard File.path, so reading `file.path`
  // yields undefined and the drop silently does nothing. webUtils.getPathForFile
  // — exposed as appApi.pathForFile, since it only works in the preload — is
  // the supported replacement.
  // `button` names the screen's own file-picking button for the fallback.
  function droppedPaths(e, button) {
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    const paths = files.map(f => appApi.pathForFile(f)).filter(Boolean);
    if (!paths.length) {
      if (files.length) alert(`Could not read those files from the drop. Use "${button}" instead.`);
      return null;
    }
    return paths;
  }

  function fileDropTarget(el, onDrop, button) {
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-target'); });
    el.addEventListener('dragleave', (e) => {
      // Moving over a child fires dragleave on the parent too; only clear the
      // outline when the pointer has really left the element.
      if (!e.relatedTarget || !el.contains(e.relatedTarget)) el.classList.remove('drop-target');
    });
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      el.classList.remove('drop-target');
      const paths = droppedPaths(e, button);
      if (paths) await onDrop(paths);
    });
  }

  fileDropTarget(document.getElementById('person-documents-panel'), async (paths) => {
    if (docAddRefused()) return;
    if (!document.getElementById('per-id').value) {
      alert('Save this person first, then attach their documents.');
      return;
    }
    await addClientDocumentsFromPaths(paths);
  }, 'Add Document\u2026');

  // --- Add Documents (the Home panel and the screen it opens) ---------------
  //
  // Files scans under a client and, optionally, one of that client's cases,
  // without going through the People tab first. The copy itself is the same
  // add-client-document IPC the profile's Documents panel uses; this screen
  // only chooses whose it is. Files dropped on the Home panel before anyone is
  // picked are HELD here — nothing is copied until there is a client.
  (() => {
    const view = document.getElementById('view-add-documents');
    const nameInput = document.getElementById('adddocs-client_name');
    const hidden = document.getElementById('adddocs-person_id');
    const list = document.querySelector('#combo-adddocs-client .combobox-dropdown');
    const caseSel = document.getElementById('adddocs-matter_id');
    const heldEl = document.getElementById('adddocs-held');
    const addHeldBtn = document.getElementById('btn-adddocs-add-held');
    const chooseBtn = document.getElementById('btn-adddocs-choose');
    const homePanel = document.getElementById('home-add-documents');
    let held = [];

    const baseName = (p) => String(p).split(/[\\/]/).pop();

    function renderHeld() {
      const any = held.length > 0;
      heldEl.classList.toggle('hidden', !any);
      addHeldBtn.classList.toggle('hidden', !any);
      // textContent: filenames are user data.
      heldEl.textContent = any ? `Waiting for a client: ${held.map(baseName).join(', ')}` : '';
      addHeldBtn.textContent = held.length === 1 ? 'Add 1 File' : `Add ${held.length} Files`;
    }

    function hold(paths) {
      paths.forEach(p => { if (!held.includes(p)) held.push(p); });
      renderHeld();
    }

    // Puts files taken for an add that did not happen back at the front of
    // the list, ahead of anything held since.
    function restoreHeld(paths) {
      held = [...paths, ...held.filter(p => !paths.includes(p))];
      renderHeld();
    }

    // The query runs first and the list is swapped in whole afterwards, so two
    // picks in quick succession cannot interleave their options — and a pick
    // that has since been replaced does not overwrite the newer one.
    async function fillCases(personId) {
      const cases = personId ? await clientCases(personId) : [];
      if (hidden.value !== (personId ? String(personId) : '')) return;
      const opts = [['', 'Not tied to a case'], ...cases.map(c => [String(c.id), c.short_name])];
      caseSel.replaceChildren(...opts.map(([value, label]) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        return o;
      }));
    }

    // Recently touched clients first, then everyone else by name. Each call
    // takes a number before it awaits; if another keystroke has started a
    // newer search by the time the queries come back, this one's results are
    // stale and are dropped rather than painted over the newer list.
    let refreshSeq = 0;
    async function refresh() {
      const seq = ++refreshSeq;
      const term = nameInput.value.trim().toLowerCase();
      const [recent, people] = await Promise.all([
        recentClients(8),
        // Contacts (judges, clerks, opposing counsel) are people rows too, but
        // never a client: this list picks a client, so they are left out.
        appApi.dbAll('SELECT id, display_name FROM people WHERE archived = 0 AND is_contact = 0 ORDER BY display_name COLLATE NOCASE')
      ]);
      if (seq !== refreshSeq) return;
      const recentIds = new Set(recent.map(r => r.id));
      const ordered = [...recent, ...people.filter(p => !recentIds.has(p.id))];
      list.innerHTML = '';
      ordered
        .filter(p => !term || p.display_name.toLowerCase().includes(term))
        .slice(0, 50)
        .forEach(p => {
          const li = document.createElement('li');
          li.textContent = p.display_name;
          li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            hidden.value = p.id;
            nameInput.value = p.display_name;
            list.classList.add('hidden');
            fillCases(p.id);
          });
          list.appendChild(li);
        });
      list.classList.remove('hidden');
    }
    nameInput.addEventListener('focus', refresh);
    nameInput.addEventListener('input', () => { hidden.value = ''; fillCases(null); refresh(); });
    nameInput.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 150));

    function openAddDocuments(paths) {
      nameInput.value = '';
      hidden.value = '';
      fillCases(null);
      held = [];
      hold(paths || []);
      showView('add-documents');
    }

    // An upload into a case whose folder owner is undecided asks first (the
    // same picker document saving uses). Cancel copies nothing.
    const UPLOAD_OWNER_CANCELLED =
      'Nothing was added: no folder was chosen for this case. Add the files ' +
      'again to choose which client\u2019s folder the case is saved in.';
    const UPLOAD_OWNER_FAILED =
      'Nothing was added: that choice could not be saved for this case. ' +
      'Check the case\u2019s clients and add the files again.';

    // A copy can fail partway (see attachClientDocuments). Whatever did copy is
    // already recorded, so the profile is opened either way — the one place
    // the user can see what actually landed. `taken` is what the caller took
    // out of `held` for this add; it goes back only when nothing was copied,
    // since after a partial copy a retry of the whole list would duplicate.
    // One add at a time, app-wide (see withDocAdd); callers ask
    // docAddRefused() before taking anything out of `held`.
    async function addTo(personId, run, taken = []) {
      await withDocAdd(async () => {
        try {
          let res = null;
          // The newest row before this add: a failed copy is judged by whether
          // anything was recorded after it. Sound only because withDocAdd lets
          // no other add run meanwhile — no other copy can insert a row between
          // this read and the check below, for this client or anyone else.
          const before = await appApi.dbGet('SELECT COALESCE(MAX(id), 0) AS id FROM client_documents');
          try {
            res = await run();
          } catch (e) {
            const copied = await appApi.dbGet(
              'SELECT COUNT(*) AS n FROM client_documents WHERE person_id = ? AND id > ?',
              [personId, before ? before.id : 0]);
            // Nothing landed: hand every file back, so they need not be dropped
            // again. Something did: a retry of the whole list would duplicate
            // those, so the profile is opened to show what actually copied.
            if (!copied || !copied.n) {
              restoreHeld(taken);
              alert(`Nothing was added.\n\n${e && e.message ? e.message : e}`);
              return;
            }
            alert(`Could not attach every file.\n\n${e && e.message ? e.message : e}\n\n` +
              'Anything that did copy across is listed on the client\'s profile. Try the rest again.');
            await openPerson(personId);
            return;
          }
          if (!res || res.canceled) { restoreHeld(taken); return; }
          // Refused before anything was copied (the case was deleted, or this
          // person is not a client on it): the files go back on hold.
          if (res.error) {
            restoreHeld(taken);
            alert(`Nothing was added: ${res.error}`);
            return;
          }
          // The case's folder owner was asked for and not given (or not
          // stored): nothing was copied, so the files go back on hold.
          if (res.needsFolderOwner) {
            restoreHeld(taken);
            alert(res.folderOwnerFailed ? UPLOAD_OWNER_FAILED : UPLOAD_OWNER_CANCELLED);
            return;
          }
          if (!res.files || !res.files.length) {
            restoreHeld(taken);
            alert('None of those files could be found. They may have been moved or deleted.');
            return;
          }
          await openPerson(personId);
        } finally {
          renderHeld();
        }
      });
    }

    // Takes everything held, leaving `held` empty, so nothing can send the
    // same files while this add is running.
    function takeHeld() {
      const paths = held;
      held = [];
      return paths;
    }

    // Both ids are read BEFORE the first await: the form can change under a
    // slow dialog or copy, and the files must go where the user pointed.
    const chosen = () => ({
      personId: Number(hidden.value) || null,
      matterId: Number(caseSel.value) || null
    });

    chooseBtn.addEventListener('click', async () => {
      if (docAddRefused()) return;
      const { personId, matterId } = chosen();
      if (!personId) { alert('Pick a client first.'); return; }
      await addTo(personId, () => withFolderOwner(matterId,
        () => appApi.addClientDocument(personId, { matterId })));
    });

    addHeldBtn.addEventListener('click', async () => {
      if (docAddRefused()) return;
      const { personId, matterId } = chosen();
      if (!personId) { alert('Pick a client first.'); return; }
      if (!held.length) return;
      const paths = takeHeld();
      await addTo(personId, () => withFolderOwner(matterId,
        () => appApi.addClientDocumentFiles(personId, paths, { matterId })), paths);
    });

    document.getElementById('btn-adddocs-cancel').addEventListener('click', () => {
      held = [];
      showView('home');
    });

    const dropTarget = (el, onDrop) => fileDropTarget(el, onDrop, 'Choose Files\u2026');

    // With a client picked, a drop adds everything waiting plus what was just
    // dropped; without one, the drop joins the files already held.
    // A drop mid-copy is turned away, not queued: the add ends by opening the
    // client's profile, and files queued behind it would be left on a screen
    // nobody is looking at.
    dropTarget(view, async (paths) => {
      if (docAddRefused()) return;
      const { personId, matterId } = chosen();
      if (!personId) { hold(paths); return; }
      const all = [...held, ...paths.filter(p => !held.includes(p))];
      takeHeld();
      await addTo(personId, () => withFolderOwner(matterId,
        () => appApi.addClientDocumentFiles(personId, all, { matterId })), all);
    });

    homePanel.addEventListener('click', () => openAddDocuments([]));
    dropTarget(homePanel, async (paths) => {
      if (docAddRefused()) return;
      openAddDocuments(paths);
    });
  })();

  // --- Case screen: Add Documents and Open Folder -----------------------------
  //
  // A scan added from a case goes into that case's own Uploads/ folder and is
  // listed on the Documents panel of the client the case is filed under (its
  // folder owner). A shared case with no owner yet asks first, with the same
  // picker document saving uses. Dropping files anywhere on the case screen
  // does the same as the button.
  //
  // Every uploaded row belongs to a client: the profile's Documents panel is
  // the only place that lists, relabels or deletes them. A case filed under
  // "No Client", or with no client on it at all, therefore takes no uploads —
  // the user is told why, and Open Folder is there for putting a file in the
  // case folder by hand.
  const CASE_UPLOAD_REFUSED = {
    noClient: 'Nothing was added: this case is filed under No Client, so there is ' +
      'no client’s Documents list to add these to. Use Open Folder to put ' +
      'files in the case folder yourself.',
    noClients: 'Nothing was added: no client on this case is linked to a client ' +
      'profile. Add the client under Parties & Role, save the case, and add the ' +
      'files again.',
    legacyShared: 'Nothing was added: this case has more than one client and its ' +
      'folder was set up before the app recorded whose it is. Use Add Documents ' +
      'on the Home screen, pick the client and this case there.',
    cancelled: 'Nothing was added: no folder was chosen for this case. Add the ' +
      'files again to choose which client’s folder the case is saved in.',
    failed: 'Nothing was added: that choice could not be saved for this case. ' +
      'Check the case’s clients and add the files again.'
  };

  function showMatterFileButtons(on) {
    document.getElementById('btn-matter-add-documents').classList.toggle('hidden', !on);
    document.getElementById('btn-matter-open-folder').classList.toggle('hidden', !on);
    document.getElementById('matter-upload-note').textContent = '';
  }

  // The client an upload to this case is filed under, asking for the case's
  // folder owner first if nobody has said yet. { personId } or { refused }.
  async function caseUploadPerson(matterId) {
    let o = await appApi.caseUploadOwner(matterId);
    if (o && o.needsFolderOwner) {
      const answer = await ensureFolderOwner(matterId);
      if (answer === 'cancelled') return { refused: CASE_UPLOAD_REFUSED.cancelled };
      if (answer === 'failed') return { refused: CASE_UPLOAD_REFUSED.failed };
      o = await appApi.caseUploadOwner(matterId);
    }
    if (o && o.personId) return { personId: o.personId };
    if (o && o.error) return { refused: `Nothing was added: ${o.error}` };
    const why = o && ['noClient', 'noClients', 'legacyShared'].find(k => o[k]);
    return { refused: CASE_UPLOAD_REFUSED[why] || CASE_UPLOAD_REFUSED.failed };
  }

  // One add at a time, app-wide: see withDocAdd.
  const caseAddBtn = document.getElementById('btn-matter-add-documents');

  // `pick(personId)` does the copy (dialog or dropped paths) once the client
  // is known. matterId is taken by the caller before anything awaits, so the
  // files go to the case that was on screen when the user acted.
  async function addToCase(matterId, pick) {
    const note = (text) => {
      if (currentMatterId === matterId) document.getElementById('matter-upload-note').textContent = text;
    };
    await withDocAdd(async () => {
        const who = await caseUploadPerson(matterId);
        if (who.refused) { alert(who.refused); return; }
        let res;
        try {
          res = await withFolderOwner(matterId, () => pick(who.personId));
        } catch (e) {
          alert(`Could not attach every file.\n\n${e && e.message ? e.message : e}\n\n` +
            'Anything that did copy across is listed on the client’s profile. Try the rest again.');
          return;
        }
        if (!res || res.canceled) return;
        if (res.error) { alert(`Nothing was added: ${res.error}`); return; }
        if (res.needsFolderOwner) {
          alert(res.folderOwnerFailed ? CASE_UPLOAD_REFUSED.failed : CASE_UPLOAD_REFUSED.cancelled);
          return;
        }
        const n = (res.files || []).length;
        if (!n) { alert('None of those files could be found. They may have been moved or deleted.'); return; }
        note(n === 1 ? 'Added 1 file to this case’s Uploads folder.'
          : `Added ${n} files to this case’s Uploads folder.`);
    });
  }

  caseAddBtn.addEventListener('click', async () => {
    const matterId = currentMatterId;
    if (!matterId || wizardMode) return;
    if (docAddRefused()) return;
    await addToCase(matterId, (personId) => appApi.addClientDocument(personId, { matterId }));
  });

  fileDropTarget(document.getElementById('view-matter-detail'), async (paths) => {
    const matterId = currentMatterId;
    if (!matterId || wizardMode) {
      alert('Save the case first, then drop its documents here.');
      return;
    }
    if (docAddRefused()) return;
    await addToCase(matterId, (personId) => appApi.addClientDocumentFiles(personId, paths, { matterId }));
  }, 'Add Documents…');

  // Opening the folder is what creates it, for a case nothing has been saved
  // into yet — the same once-only decision the first document would make.
  document.getElementById('btn-matter-open-folder').addEventListener('click', async () => {
    const matterId = currentMatterId;
    if (!matterId || wizardMode) return;
    const res = await withFolderOwner(matterId, () => appApi.matterFolder(matterId));
    if (res && res.needsFolderOwner) {
      alert(res.folderOwnerFailed
        ? 'That choice could not be saved for this case. Check the case’s clients and try again.'
        : 'No folder was chosen for this case, so there is nothing to open yet.');
      return;
    }
    if (!res || res.error || !res.dir) { alert((res && res.error) || 'Could not find this case’s folder.'); return; }
    const opened = await appApi.openPath(res.dir);
    if (!opened || !opened.ok) alert(`Could not open the folder.\n\n${(opened && opened.error) || ''}`);
  });

  // The profile's Open Folder: the client's own folder (created on first use,
  // which is fine here — the user asked to see it).
  document.getElementById('btn-open-client-folder').addEventListener('click', async () => {
    const personId = Number(document.getElementById('per-id').value) || null;
    if (!personId) return;
    const res = await appApi.clientFolder(personId);
    if (!res || res.error || !res.dir) { alert((res && res.error) || 'Could not find this client’s folder.'); return; }
    const opened = await appApi.openPath(res.dir);
    if (!opened || !opened.ok) alert(`Could not open the folder.\n\n${(opened && opened.error) || ''}`);
  });

  document.getElementById('btn-save-person').addEventListener('click', async () => {
    const name = document.getElementById('per-display_name').value.trim();
    if (!name) { alert('Name is required.'); return; }
    const id = document.getElementById('per-id').value;
    // Column lists come from PERSON_FIELDS, in lock-step with the values. The
    // hand-written lists these replaced were how a new field could be added to
    // the form and to the schema and still never reach the database.
    const vals = PERSON_FIELDS.map(readPersonField);
    if (id) {
      const assignments = PERSON_FIELDS.map(f => `${f}=?`).join(', ');
      await appApi.dbRun(`UPDATE people SET ${assignments} WHERE id=?`, [...vals, id]);
      await savePriors(id);
    } else {
      const cols = PERSON_FIELDS.join(', ');
      const placeholders = PERSON_FIELDS.map(() => '?').join(',');
      const res = await appApi.dbRun(
        `INSERT INTO people (${cols}, created_at) VALUES (${placeholders},?)`,
        [...vals, new Date().toISOString()]);
      document.getElementById('per-id').value = res.lastInsertRowid;
      // Priors typed before the first save belong to the person that save just
      // created; dropping them here would silently discard what the user keyed in.
      await savePriors(res.lastInsertRowid);
      document.getElementById('person-archive-foot').classList.remove('hidden');
      await renderPersonCases(res.lastInsertRowid);
      await renderPersonWorkProduct(res.lastInsertRowid);
      await renderPersonDocuments(res.lastInsertRowid);
    }
    await loadPeople();
  });

  // Archive, never delete: matters that reference this person keep resolving.
  //
  // Archiving is the one action on this page that removes a client from every
  // picker in the app, so it asks first — and it names the client, because
  // "Archive this client?" on the wrong record reads exactly the same as on the
  // right one. Restoring is not destructive and asks nothing.
  document.getElementById('btn-archive-person').addEventListener('click', async () => {
    const id = document.getElementById('per-id').value;
    if (!id) return;
    const p = await appApi.dbGet('SELECT archived, display_name FROM people WHERE id = ?', [id]);
    const next = p.archived ? 0 : 1;
    if (next === 1) {
      const who = (p.display_name || '').trim() || 'this client';
      const ok = confirm(
        `Archive ${who}?\n\n${who} will be hidden from every client picker. ` +
        'Nothing is deleted \u2014 existing matters keep resolving, and you can ' +
        'restore them from this page.');
      if (!ok) return;
    }
    await appApi.dbRun('UPDATE people SET archived = ? WHERE id = ?', [next, id]);
    await openPerson(id);
    await loadPeople();
  });

  // The paper fallback. Intake is normally typed live during the consultation;
  // a walk-in gets this on a clipboard. It goes through the ordinary
  // generateDocx path, so it lands in the firm's output folder and inherits
  // the letterhead and page margins every other document is printed with.
  //
  // It belongs to no matter and no client: `id: null` sends it to the
  // "Blank Forms" folder (getMatterDir's id-less branch — this is the only
  // id-less caller) and keeps it out of the generated_files reuse check, so
  // each print is its own file.
  async function generateBlankQuestionnaire() {
    const letterhead = await appApi.dbGet(
      'SELECT * FROM letterheads WHERE archived = 0 ORDER BY id LIMIT 1');
    const attorney = await appApi.dbGet('SELECT * FROM attorneys WHERE is_default = 1');
    const forDoc = { id: null, short_name: 'Blank Forms', parties: [], letterhead: letterhead || null };
    // No letterhead on file prints "[NO LETTERHEAD SELECTED]" across the top of
    // a form the attorney hands to a client, so the block is simply left out instead.
    const blocks = window.DocumentEngine.buildIntakeQuestionnaire(!!letterhead);
    return appApi.generateDocx(blocks, forDoc, attorney || {},
      'Client Intake Questionnaire', 'intake_questionnaire');
  }
  // Reached by the toolbar button and, directly, by the smoke harness.
  window.generateBlankQuestionnaire = generateBlankQuestionnaire;

  document.getElementById('btn-print-questionnaire').addEventListener('click', async () => {
    const btn = document.getElementById('btn-print-questionnaire');
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const res = await generateBlankQuestionnaire();
      const box = document.getElementById('person-issues');
      box.textContent = res && res.path
        ? `Blank questionnaire written:\n${res.path}`
        : (res && res.error) || 'The blank questionnaire could not be written.';
      box.style.whiteSpace = 'pre-wrap';
      box.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = was;
    }
  });

  window.addParty = (side) => { parties[side].push({ name: '', side, sort_order: parties[side].length }); renderParties(); };
  window.removeParty = (side, index) => { parties[side].splice(index, 1); renderParties(); };
  window.updateParty = (side, index, val) => { parties[side][index].name = val; };

  // Party rows are person pickers: click to browse everyone on file, type to
  // filter, or add a new person inline. Built with DOM nodes rather than an HTML
  // string because party names are user data (an apostrophe or quote in a name
  // would break a string-built row).
  function renderParties() {
    ['plaintiff', 'defendant'].forEach(side => {
      const list = document.getElementById(side + '-list');
      list.innerHTML = '';
      parties[side].forEach((p, idx) => {
        const row = document.createElement('div');
        row.className = 'party-row';

        const wrap = document.createElement('div');
        wrap.className = 'combobox-wrapper';
        wrap.style.flex = '1';

        const input = document.createElement('input');
        input.type = 'text';
        input.value = p.name || '';
        input.placeholder = 'Person name';
        input.style.width = '100%';

        const drop = document.createElement('ul');
        drop.className = 'combobox-dropdown hidden';

        const linked = document.createElement('span');
        linked.style.cssText = 'font-size:0.75em; color:#2a6; margin-left:4px;';
        const setLinkMark = () => { linked.textContent = p.person_id ? '● linked' : ''; };
        setLinkMark();

        // An Organization prints under the name it goes by in a caption
        // ("PEOPLE OF THE CITY OF EXAMPLETON"), on the party line — never as
        // caption_authority, which always prints above "Plaintiff" and would
        // misplace an organization defendant. The link is still by person_id.
        const choose = (person) => {
          const isOrg = person.kind === 'organization';
          const captionName = isOrg ? (person.caption_name || '').trim() : '';
          const shown = captionName || person.display_name;
          p.person_id = person.id;
          // A deliberate snapshot (freeze-once, like parties.name everywhere):
          // editing the org's caption name later does not rewrite this case.
          p.name = shown;
          input.value = shown;
          drop.classList.add('hidden');
          setLinkMark();
          // Its usual side fills "Our Client Role" only when nothing has
          // decided the side yet (see clientRoleChosen), and only when it was
          // added on that side: a city added as a defendant is almost
          // certainly the other side's party, so it proves nothing about ours.
          if (isOrg && person.usual_role === side && !clientRoleChosen) {
            document.getElementById('mat-client_role').value = side;
            clientRoleChosen = true;
            checkWizardStep1Ready();
          }
        };

        async function refresh() {
          const term = input.value.trim().toLowerCase();
          const people = await appApi.dbAll(
            'SELECT * FROM people WHERE archived = 0 ORDER BY display_name COLLATE NOCASE');
          drop.innerHTML = '';
          let exact = false;
          people
            .filter(r => !term || r.display_name.toLowerCase().includes(term))
            .slice(0, 50)
            .forEach(r => {
              if (r.display_name.toLowerCase() === term) exact = true;
              const li = document.createElement('li');
              li.textContent = r.display_name + (r.firm_name ? ` — ${r.firm_name}` : '');
              li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(r); });
              drop.appendChild(li);
            });
          if (term && !exact) {
            const li = document.createElement('li');
            li.className = 'add-new';
            li.textContent = `+ Add "${input.value.trim()}"`;
            li.addEventListener('mousedown', async (e) => {
              e.preventDefault();
              const name = input.value.trim();
              const res = await appApi.dbRun(
                'INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
                [name, 'individual', new Date().toISOString()]);
              choose({ id: res.lastInsertRowid, display_name: name });
              // After the row, not inside it: .party-row is display:flex, so an
              // inline insert would sit beside the input instead of under it.
              showPersonAddedNote(row, res.lastInsertRowid, name, {
                isDirty: () => isFormDirty('view-matter-detail'),
                save: async () => { await saveMatter({ silent: true }); }
              });
            });
            drop.appendChild(li);
          }
          drop.classList.remove('hidden');
        }

        input.addEventListener('focus', refresh);
        input.addEventListener('input', () => {
          // Typing breaks the link until a person is chosen again, so a renamed
          // row can never silently keep pointing at the wrong person.
          p.person_id = null;
          p.name = input.value;
          setLinkMark();
          refresh();
        });
        input.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));

        const del = document.createElement('button');
        del.className = 'btn';
        del.textContent = 'X';
        del.addEventListener('click', () => { parties[side].splice(idx, 1); renderParties(); });

        wrap.append(input, drop);
        row.append(wrap, linked, del);
        list.appendChild(row);
      });
    });
  }

  // Extra case rows. The first case stays in sync with the header Case Number
  // field; rows beyond it are the appellate extras (the case below).
  let extraCases = [];

  function renderExtraCases() {
    const list = document.getElementById('matter-cases-list');
    list.innerHTML = '';
    extraCases.forEach((c, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:4px; margin-bottom:4px;';

      const num = document.createElement('input');
      num.type = 'text';
      num.placeholder = 'Case number';
      num.value = c.case_number || '';
      num.style.flex = '1';
      num.addEventListener('input', () => { c.case_number = num.value; });

      const judge = document.createElement('input');
      judge.type = 'text';
      judge.placeholder = 'Judge (without "Hon.")';
      judge.value = c.judge_name || '';
      judge.style.flex = '1';
      judge.addEventListener('input', () => { c.judge_name = judge.value; });

      const del = document.createElement('button');
      del.className = 'btn';
      del.type = 'button';
      del.textContent = 'X';
      del.addEventListener('click', () => { extraCases.splice(idx, 1); renderExtraCases(); });

      row.append(num, judge, del);
      list.appendChild(row);
    });
    if (!extraCases.length) {
      const hint = document.createElement('div');
      hint.style.cssText = 'color:#666; font-size:0.9em;';
      hint.textContent = 'None. The Case Number above is the primary case.';
      list.appendChild(hint);
    }
  }

  document.getElementById('btn-add-case').addEventListener('click', () => {
    extraCases.push({ case_number: '', judge_name: '' });
    renderExtraCases();
  });

  // Caption note lines — the free lines under "Case No." / "Hon." in the
  // caption's right-hand column. An ordered list, not a blob: the order is
  // what prints, and a compound charge is one row or three at the user's
  // choice. Replaces the old single "charges" textarea.
  let captionNotes = [];
  // Additional counsel of record on this matter, in print order. Rows are
  // { attorney_id }; the name/bar number are resolved at render time so
  // correcting a typo in an attorney's profile fixes future documents without
  // rewriting the ones already generated (those carry their own snapshot).
  let coCounsel = [];
  let coCounselAttorneysCache = null;

  function renderCaptionNotes() {
    const list = document.getElementById('matter-notes-list');
    list.innerHTML = '';
    captionNotes.forEach((n, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:4px; margin-bottom:4px;';

      const text = document.createElement('input');
      text.type = 'text';
      text.placeholder = 'e.g. OWI (misdemeanor)';
      text.value = n.note_text || '';
      text.style.flex = '1';
      text.addEventListener('input', () => { n.note_text = text.value; });

      // Pasting a multi-line block (out of an old charges field, an email, a
      // police report) becomes one row per line rather than one row holding
      // embedded newlines that the caption cannot render.
      text.addEventListener('paste', (e) => {
        const pasted = (e.clipboardData || window.clipboardData).getData('text');
        if (!pasted || !pasted.includes('\n')) return;
        e.preventDefault();
        const lines = pasted.split('\n').map(s => s.trim()).filter(Boolean);
        if (!lines.length) return;
        captionNotes.splice(idx, 1, ...lines.map(t => ({ note_text: t })));
        renderCaptionNotes();
      });

      const mkBtn = (label, title, onClick, disabled) => {
        const b = document.createElement('button');
        b.className = 'btn';
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.disabled = !!disabled;
        b.addEventListener('click', onClick);
        return b;
      };
      const up = mkBtn('↑', 'Move up', () => {
        [captionNotes[idx - 1], captionNotes[idx]] = [captionNotes[idx], captionNotes[idx - 1]];
        renderCaptionNotes();
      }, idx === 0);
      const down = mkBtn('↓', 'Move down', () => {
        [captionNotes[idx + 1], captionNotes[idx]] = [captionNotes[idx], captionNotes[idx + 1]];
        renderCaptionNotes();
      }, idx === captionNotes.length - 1);
      const del = mkBtn('X', 'Remove this note', () => {
        captionNotes.splice(idx, 1);
        renderCaptionNotes();
      });

      row.append(text, up, down, del);
      list.appendChild(row);
    });
    if (!captionNotes.length) {
      const hint = document.createElement('div');
      hint.style.cssText = 'color:#666; font-size:0.9em;';
      hint.textContent = 'None. The caption will show the case number and judge only.';
      list.appendChild(hint);
    }
  }

  document.getElementById('btn-add-note').addEventListener('click', () => {
    captionNotes.push({ note_text: '' });
    renderCaptionNotes();
    const inputs = document.querySelectorAll('#matter-notes-list input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  // Court dates on the matter. An ordered in-memory array rendered to DOM
  // nodes and re-inserted wholesale on save, exactly like captionNotes and the
  // priors table on the person. It lives outside openMatter, which is
  // precisely why openMatter must reset it before its first await: one
  // client's hearing dates showing on another client's case is the same class
  // of leak the priors reset guards against.
  //
  // Scope is deliberately "record and roll up" (design §7): no calendar view,
  // no firm-wide docket, no notifications, no computed deadlines.
  let matterEvents = [];

  const EVENT_TYPES = ['Arraignment', 'Pretrial', 'Motion hearing', 'Trial',
    'Sentencing', 'PV hearing', 'Filing deadline', 'Other'];

  // `done` is an INTEGER column, and it is read from `.checked`, never
  // `.value` — a checkbox's value is "on" whether or not it is ticked, which
  // is exactly the bug that once stored every unticked box as truthy.
  const EVENT_FIELDS = [
    { col: 'event_type', label: 'Type', kind: 'select', flex: '1 1 150px' },
    { col: 'event_date', label: 'Date', type: 'date', flex: '0 0 140px' },
    { col: 'event_time', label: 'Time', type: 'time', flex: '0 0 110px' },
    { col: 'location', label: 'Location', placeholder: "e.g. 90th District, Judge O'Casey", flex: '1 1 180px' },
    { col: 'notes', label: 'Notes', placeholder: 'e.g. adjourned from 8/12', flex: '2 1 200px' },
    { col: 'done', label: 'Done', kind: 'checkbox', flex: '0 0 50px' }
  ];

  // Built with document.createElement and never an HTML string. Location and
  // notes are user data — "St. Mary's", "Judge O'Casey" — and a string-built
  // row breaks on the first apostrophe. Same reason the party and prior rows
  // are built this way.
  function renderMatterEvents() {
    const list = document.getElementById('matter-events-list');
    if (!list) return;
    list.innerHTML = '';
    matterEvents.forEach((e, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:4px; align-items:flex-end; margin-bottom:6px; flex-wrap:wrap;';

      EVENT_FIELDS.forEach(f => {
        const wrap = document.createElement('div');
        wrap.style.cssText = `display:flex; flex-direction:column; flex:${f.flex};`;
        const lab = document.createElement('label');
        lab.textContent = f.label;
        lab.style.cssText = 'font-size:0.8em; color:#666;';

        let input;
        if (f.kind === 'select') {
          input = document.createElement('select');
          input.appendChild(new Option('', ''));
          EVENT_TYPES.forEach(t => {
            const opt = new Option(t, t);
            if (String(e[f.col] || '') === t) opt.selected = true;
            input.appendChild(opt);
          });
          input.addEventListener('change', () => { e[f.col] = input.value; refreshStaleStageNote(); });
        } else if (f.kind === 'checkbox') {
          input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = !!Number(e[f.col] || 0);
          input.style.cssText = 'margin:0 0 6px 4px;';
          input.addEventListener('change', () => { e[f.col] = input.checked ? 1 : 0; });
        } else {
          input = document.createElement('input');
          input.type = f.type || 'text';
          if (f.placeholder) input.placeholder = f.placeholder;
          input.value = e[f.col] || '';
          input.addEventListener('input', () => { e[f.col] = input.value; refreshStaleStageNote(); });
        }
        input.dataset.field = f.col;
        wrap.append(lab, input);
        if (f.type === 'date') withTodayButton(input); // A8
        row.appendChild(wrap);
      });

      const del = document.createElement('button');
      del.className = 'btn';
      del.type = 'button';
      del.textContent = 'X';
      del.title = 'Remove this court date';
      del.dataset.removeEvent = String(idx);
      del.addEventListener('click', () => {
        syncMatterEventsFromDom();
        matterEvents.splice(idx, 1);
        renderMatterEvents();
      });
      row.appendChild(del);

      list.appendChild(row);
    });
    if (!matterEvents.length) {
      const hint = document.createElement('div');
      hint.style.cssText = 'color:#666; font-size:0.9em; margin-bottom:6px;';
      hint.textContent = 'No court dates on this case.';
      list.appendChild(hint);
    }
    refreshStaleStageNote();
  }

  // Read the rows back out of the DOM before acting on the array. The
  // per-input listeners keep it live for ordinary typing, but a value set
  // programmatically fires no event, and the array is what gets written.
  function syncMatterEventsFromDom() {
    const list = document.getElementById('matter-events-list');
    if (!list) return;
    const rows = [...list.children].filter(el => el.querySelector('[data-field]'));
    rows.forEach((rowEl, idx) => {
      if (!matterEvents[idx]) return;
      EVENT_FIELDS.forEach(f => {
        const input = rowEl.querySelector(`[data-field="${f.col}"]`);
        if (!input) return;
        // INTEGER 0/1 from .checked. Never .value — see EVENT_FIELDS above.
        matterEvents[idx][f.col] = f.kind === 'checkbox' ? (input.checked ? 1 : 0) : input.value;
      });
    });
  }

  document.getElementById('btn-add-event').addEventListener('click', () => {
    syncMatterEventsFromDom();
    matterEvents.push({ event_type: '', event_date: '', event_time: '', location: '', notes: '', done: 0 });
    renderMatterEvents();
    const inputs = document.querySelectorAll('#matter-events-list [data-field="event_type"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  // Diffs the old and new event lists for the activity log. matter_events is
  // replaced wholesale (delete + reinsert) with no ids to match old rows to
  // new ones by, so identity here is (event_type, event_date) — how a human
  // would refer to a hearing ("the Pretrial on 9/1"). A row whose type or
  // date itself changed therefore logs as one row disappearing and a new one
  // being added, not as a "changed" event; only time/location/notes/done
  // changes on an otherwise-matching key log as "changed" or "done".
  async function logMatterEventChanges(matterId, oldRows, newRows) {
    const key = (r) => `${r.event_type || ''}|${r.event_date || ''}`;
    const oldByKey = new Map(oldRows.map(r => [key(r), r]));
    for (const r of newRows) {
      const k = key(r);
      const label = `${r.event_type || 'Court date'} — ${r.event_date || '(no date)'}`;
      const prev = oldByKey.get(k);
      if (!prev) {
        await logActivity('court_date_added', `Court date added: ${label}`, { matterId });
        continue;
      }
      if (!Number(prev.done) && Number(r.done)) {
        await logActivity('court_date_done', `Court date marked done: ${label}`, { matterId });
      } else if (prev.event_time !== r.event_time || prev.location !== r.location || prev.notes !== r.notes) {
        await logActivity('court_date_changed', `Court date changed: ${label}`, { matterId });
      }
    }
  }

  async function saveMatterEvents(matterId) {
    // Nothing to delete against before the matter exists; the caller only ever
    // passes a real id.
    if (!matterId) return;
    syncMatterEventsFromDom();

    // SNAPSHOT FIRST. `matterEvents` is module-level state that openMatter
    // reassigns wholesale, and the dbTransaction below is an IPC round trip
    // that yields to the event loop — the UI stays clickable across it. The
    // same pattern read live (priors, caption notes) wrote one client's rows
    // onto another client's file when the user navigated mid-save. Copy into a
    // local const, then only touch the copy.
    const TEXT_COLS = EVENT_FIELDS.filter(f => f.kind !== 'checkbox').map(f => f.col);
    const toSave = matterEvents
      // A row left completely blank is not a court date; it never reaches the
      // database. The `done` tick alone does not make one either.
      .filter(e => TEXT_COLS.some(c => String(e[c] || '').trim()))
      .map(e => ({
        event_type: (e.event_type || '').trim() || null,
        event_date: (e.event_date || '').trim() || null,
        event_time: (e.event_time || '').trim() || null,
        location: (e.location || '').trim() || null,
        notes: (e.notes || '').trim() || null,
        done: Number(e.done) ? 1 : 0
      }));

    // Read the prior state before it's replaced, for the activity log below.
    const oldRows = await appApi.dbAll(
      `SELECT event_type, event_date, event_time, location, notes, done
       FROM matter_events WHERE matter_id = ?`, [matterId]);

    // One transaction: the DELETE and every INSERT commit together or not at
    // all. Half-applied, a matter's dates end up partly erased with nothing to
    // roll them back and no error the user ever sees.
    await appApi.dbTransaction([
      { sql: 'DELETE FROM matter_events WHERE matter_id = ?', params: [matterId] },
      ...toSave.map(e => ({
        sql: `INSERT INTO matter_events (matter_id, event_type, event_date, event_time, location, notes, done)
              VALUES (?,?,?,?,?,?,?)`,
        params: [matterId, e.event_type, e.event_date, e.event_time, e.location, e.notes, e.done]
      }))
    ]);

    await logMatterEventChanges(matterId, oldRows, toSave);
  }

  // ---- Payments (A7) --------------------------------------------------------
  // Flat-fee office: this is a running total of what actually came in, not a
  // balance against fee_quoted — fee_quoted is free text ("$2,500 flat, TBD
  // after arraignment") with no number in it to subtract from. Decided with
  // the user 2026-08-26. Amounts are stored as integer cents.
  let matterPayments = [];

  function dollarsToCents(v) {
    const n = Number(String(v || '').replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  function centsToDollars(c) {
    return (Number(c || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  function renderMatterPayments() {
    const list = document.getElementById('matter-payments-list');
    if (!list) return;
    list.innerHTML = '';
    matterPayments.forEach((p, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:4px; align-items:flex-end; margin-bottom:6px; flex-wrap:wrap;';

      const dateWrap = document.createElement('div');
      dateWrap.style.cssText = 'display:flex; flex-direction:column;';
      const dateLab = document.createElement('label');
      dateLab.textContent = 'Date';
      dateLab.style.cssText = 'font-size:0.8em; color:#666;';
      const dateInput = document.createElement('input');
      dateInput.type = 'date';
      dateInput.value = p.paid_date || '';
      dateInput.addEventListener('input', () => { p.paid_date = dateInput.value; });
      dateWrap.append(dateLab, dateInput);
      withTodayButton(dateInput); // A8

      const amtWrap = document.createElement('div');
      amtWrap.style.cssText = 'display:flex; flex-direction:column;';
      const amtLab = document.createElement('label');
      amtLab.textContent = 'Amount';
      amtLab.style.cssText = 'font-size:0.8em; color:#666;';
      const amtInput = document.createElement('input');
      amtInput.type = 'text';
      amtInput.placeholder = '0.00';
      amtInput.style.width = '90px';
      amtInput.value = p.amount_cents ? (p.amount_cents / 100).toFixed(2) : '';
      amtInput.addEventListener('input', () => {
        p.amount_cents = dollarsToCents(amtInput.value);
        updatePaymentsTotal();
      });
      amtWrap.append(amtLab, amtInput);

      const notesWrap = document.createElement('div');
      notesWrap.style.cssText = 'display:flex; flex-direction:column; flex:1 1 200px;';
      const notesLab = document.createElement('label');
      notesLab.textContent = 'Notes';
      notesLab.style.cssText = 'font-size:0.8em; color:#666;';
      const notesInput = document.createElement('input');
      notesInput.type = 'text';
      notesInput.placeholder = 'e.g. cash, check #204';
      notesInput.value = p.notes || '';
      notesInput.addEventListener('input', () => { p.notes = notesInput.value; });
      notesWrap.append(notesLab, notesInput);

      const del = document.createElement('button');
      del.className = 'btn';
      del.type = 'button';
      del.textContent = 'X';
      del.addEventListener('click', () => {
        matterPayments.splice(idx, 1);
        renderMatterPayments();
      });

      row.append(dateWrap, amtWrap, notesWrap, del);
      list.appendChild(row);
    });
    updatePaymentsTotal();
  }

  function updatePaymentsTotal() {
    const total = matterPayments.reduce((sum, p) => sum + (Number(p.amount_cents) || 0), 0);
    const el = document.getElementById('matter-payments-total');
    if (el) el.textContent = centsToDollars(total);
  }

  document.getElementById('btn-add-payment').addEventListener('click', () => {
    matterPayments.push({ amount_cents: 0, paid_date: '', notes: '' });
    renderMatterPayments();
  });

  // A10: populates the matter form's own "Assigned Attorney" select. Called
  // whenever the form is opened or reset — the same trigger points that
  // already reload courts/judges into their comboboxes.
  async function populateAttorneySelect(selectedId) {
    const sel = document.getElementById('mat-attorney_id');
    sel.innerHTML = '<option value="">(none set)</option>';
    const atts = await appApi.dbAll('SELECT id, label, firm_name, name FROM attorneys ORDER BY id');
    atts.forEach(a => {
      const opt = new Option(a.label || a.firm_name || a.name, a.id);
      if (selectedId && a.id === selectedId) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  // A10: read-only Transfer History panel on the matter page.
  async function renderMatterTransfers(matterId) {
    const el = document.getElementById('matter-transfers');
    if (!matterId) { el.textContent = 'Save matter first.'; return; }
    const rows = await appApi.dbAll(
      `SELECT field, from_value, to_value, transferred_on FROM matter_transfers
       WHERE matter_id = ? ORDER BY transferred_on DESC, id DESC LIMIT 50`, [matterId]);
    el.innerHTML = '';
    if (!rows.length) { el.textContent = 'No transfers recorded.'; return; }
    el.className = 'activity-list';
    const fieldLabel = { court: 'Court', judge: 'Judge', attorney: 'Attorney' };
    rows.forEach(r => {
      const row = document.createElement('div');
      row.className = 'activity-row';
      const desc = document.createElement('span');
      desc.textContent = `${fieldLabel[r.field] || r.field} changed: ${r.from_value || '(none)'} → ${r.to_value || '(none)'}`;
      const date = document.createElement('span');
      date.className = 'activity-date';
      date.textContent = r.transferred_on || '';
      row.append(desc, date);
      el.appendChild(row);
    });
  }

  async function saveMatterPayments(matterId) {
    if (!matterId) return;
    // A blank row (never touched after "Add Payment") is not a payment.
    const toSave = matterPayments.filter(p => Number(p.amount_cents) > 0);
    await appApi.dbTransaction([
      { sql: 'DELETE FROM matter_payments WHERE matter_id = ?', params: [matterId] },
      ...toSave.map(p => ({
        sql: `INSERT INTO matter_payments (matter_id, amount_cents, paid_date, notes, created_at)
              VALUES (?,?,?,?,?)`,
        params: [matterId, p.amount_cents, p.paid_date || null, p.notes || null, new Date().toISOString()]
      }))
    ]);
  }

  // Additional counsel of record: a picker over the app's own attorneys, not
  // free text. These print as extra bold name lines at the top of a counsel
  // block, above the shared "Attorney for X" / office / address lines.
  async function renderCoCounsel() {
    const list = document.getElementById('matter-cocounsel-list');
    if (!list) return;
    // Cached across calls: reorder/remove used to re-query every attorney on
    // every click. The list can only change via the attorney form, which
    // invalidates this cache when it saves.
    if (!coCounselAttorneysCache) {
      coCounselAttorneysCache = await appApi.dbAll('SELECT id, name, bar_number, label FROM attorneys ORDER BY name COLLATE NOCASE');
    }
    const atts = coCounselAttorneysCache;
    list.innerHTML = '';
    coCounsel.forEach((c, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:4px; margin-bottom:4px;';

      const sel = document.createElement('select');
      sel.style.flex = '1';
      sel.appendChild(new Option('— choose an attorney —', ''));
      atts.forEach(a => {
        const opt = new Option(a.bar_number ? `${a.name} (${a.bar_number})` : a.name, a.id);
        if (String(a.id) === String(c.attorney_id)) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => { c.attorney_id = sel.value ? Number(sel.value) : null; });

      const mkBtn = (label, title, onClick, disabled) => {
        const b = document.createElement('button');
        b.className = 'btn';
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.disabled = !!disabled;
        b.addEventListener('click', onClick);
        return b;
      };
      const up = mkBtn('↑', 'Move up', async () => {
        [coCounsel[idx - 1], coCounsel[idx]] = [coCounsel[idx], coCounsel[idx - 1]];
        await renderCoCounsel();
      }, idx === 0);
      const down = mkBtn('↓', 'Move down', async () => {
        [coCounsel[idx + 1], coCounsel[idx]] = [coCounsel[idx], coCounsel[idx + 1]];
        await renderCoCounsel();
      }, idx === coCounsel.length - 1);
      const del = mkBtn('X', 'Remove this attorney', async () => {
        coCounsel.splice(idx, 1);
        await renderCoCounsel();
      });

      row.append(sel, up, down, del);
      list.appendChild(row);
    });
    if (!coCounsel.length) {
      const hint = document.createElement('div');
      hint.style.cssText = 'color:#666; font-size:0.9em;';
      hint.textContent = 'None. The counsel block will name the signing attorney only.';
      list.appendChild(hint);
    }
  }

  document.getElementById('btn-add-cocounsel').addEventListener('click', async () => {
    coCounsel.push({ attorney_id: null });
    await renderCoCounsel();
    const sels = document.querySelectorAll('#matter-cocounsel-list select');
    if (sels.length) sels[sels.length - 1].focus();
  });

  // Opposing counsel picker, reusing the People book.
  (function setupOpposingCounsel() {
    const input = document.getElementById('mat-oppcounsel_name');
    const hidden = document.getElementById('mat-opposing_counsel_person_id');
    const drop = document.querySelector('#combo-oppcounsel .combobox-dropdown');

    async function refresh() {
      const term = input.value.trim().toLowerCase();
      const people = await appApi.dbAll('SELECT * FROM people WHERE archived = 0 ORDER BY display_name COLLATE NOCASE');
      drop.innerHTML = '';
      const matches = people.filter(p => !term || p.display_name.toLowerCase().includes(term)).slice(0, 50);
      matches.forEach(p => {
          const li = document.createElement('li');
          li.textContent = p.display_name + (p.firm_name ? ` — ${p.firm_name}` : '');
          li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            hidden.value = p.id;
            input.value = p.display_name;
            drop.classList.add('hidden');
          });
          drop.appendChild(li);
        });
      // Opposing counsel is a contact, not a client: listed under Contacts
      // with role Attorney, never on the People tab.
      if (term && !matches.some(p => p.display_name.toLowerCase() === term)) {
        const li = document.createElement('li');
        li.className = 'add-new';
        li.textContent = `+ Add "${input.value.trim()}"`;
        li.addEventListener('mousedown', async (e) => {
          e.preventDefault();
          const name = input.value.trim();
          const res = await appApi.dbRun(
            `INSERT INTO people (display_name, kind, is_contact, contact_role, created_at)
             VALUES (?, 'individual', 1, 'Attorney', ?)`, [name, new Date().toISOString()]);
          hidden.value = res.lastInsertRowid;
          input.value = name;
          drop.classList.add('hidden');
          showPersonAddedNote(document.getElementById('combo-oppcounsel'), res.lastInsertRowid, name, {
            isDirty: () => isFormDirty('view-matter-detail'),
            save: async () => { await saveMatter({ silent: true }); },
            open: openContact
          });
        });
        drop.appendChild(li);
      }
      drop.classList.remove('hidden');
    }
    input.addEventListener('focus', refresh);
    input.addEventListener('input', () => { hidden.value = ''; refresh(); });
    input.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));
  })();

  // A matter type bundles the caption authority, letterhead, default court, our
  // side, and the output folder — one choice instead of four.
  async function loadMatterTypes(selectedId) {
    const sel = document.getElementById('mat-matter_type_id');
    const rows = await appApi.dbAll('SELECT * FROM matter_types WHERE archived = 0 ORDER BY sort_order, name');
    sel.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— Select —';
    sel.appendChild(blank);
    rows.forEach(t => {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.name;
      o.dataset.side = t.side || '';
      o.dataset.defaultCourt = t.default_court_id || '';
      sel.appendChild(o);
    });
    sel.value = selectedId ? String(selectedId) : '';
  }

  // Picking a type pre-fills which side we're on, so the caption and party
  // labels start correct instead of defaulting to plaintiff every time.
  document.getElementById('mat-matter_type_id').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (!opt || !opt.dataset.side) return;
    const side = opt.dataset.side === 'prosecution' ? 'plaintiff'
      : opt.dataset.side === 'defense' ? 'defendant'
      : opt.dataset.side;
    // Only fills a side nobody has chosen yet. Either order must hold: an
    // organization added after the type must not flip the type's side
    // (Criminal Defense, then the prosecuting city as plaintiff), and a type
    // picked after the side was chosen — by hand, by an organization's usual
    // role, or on a saved case — must not flip it either, because the printed
    // "Attorney for …" follows client_role.
    if ((side === 'plaintiff' || side === 'defendant') && !clientRoleChosen) {
      document.getElementById('mat-client_role').value = side;
      clientRoleChosen = true;
    }
  });

  setupCombobox('court', 'courts', null);
  setupCombobox('judge', 'judges', () => document.getElementById('mat-court_id').value);

  function setupCombobox(idName, tableName, getParentId) {
    const input = document.getElementById(`mat-${idName}`);
    const hidden = document.getElementById(`mat-${idName}_id`);
    const list = document.querySelector(`#combo-${idName} .combobox-dropdown`);

    input.addEventListener('focus', updateList);
    // Typing invalidates any previous selection. Without this, editing a picked
    // name ("Hon. Smith" -> "Hon. Smithe") leaves the hidden id pointing at the
    // old record, and the document silently uses the wrong judge or court.
    input.addEventListener('input', () => { hidden.value = ''; updateList(); });
    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !list.contains(e.target)) list.classList.add('hidden');
    });

    async function updateList() {
      const val = input.value.trim();
      let sql = `SELECT * FROM ${tableName} WHERE archived = 0`;
      const params = [];
      if (getParentId) {
        const pid = getParentId();
        if (!pid) return; 
        sql += ` AND court_id = ?`;
        params.push(pid);
      }
      const rows = await appApi.dbAll(sql, params);
      
      list.innerHTML = '';
      let foundExact = false;
      rows.forEach(r => {
        if (r.name.toLowerCase().includes(val.toLowerCase())) {
          if (r.name.toLowerCase() === val.toLowerCase()) foundExact = true;
          const li = document.createElement('li');
          li.innerText = r.name;
          li.onclick = () => { input.value = r.name; hidden.value = r.id; list.classList.add('hidden'); };
          list.appendChild(li);
        }
      });
      
      if (val && !foundExact) {
        const createLi = document.createElement('li');
        createLi.className = 'add-new';
        createLi.innerText = `+ Add "${val}"`;
        createLi.onclick = async () => {
          // A judge typed fresh on a case is also a contact (Contacts tab),
          // created with it in one transaction.
          if (tableName === 'judges') {
            hidden.value = (await createJudgeWithContact(val, getParentId())).judgeId;
          } else {
            const res = await appApi.dbRun('INSERT INTO courts (name) VALUES (?)', [val]);
            hidden.value = res.lastInsertRowid;
          }
          input.value = val;
          list.classList.add('hidden');
        };
        list.appendChild(createLi);
      }
      list.classList.remove('hidden');
    }
  }

  // Extracted so the wizard's Step 3 (intake-wizard design notes)
  // can create a matter the same way the direct form does, instead of a
  // second, divergent write path. { silent } skips the "Matter saved." alert,
  // which would otherwise interrupt the wizard's transition into Generate.
  // A6's activity log — mirrors main.js's logActivity, for the events that
  // originate here in the renderer rather than at a main-process IPC handler.
  async function logActivity(eventType, description, { matterId = null, personId = null } = {}) {
    await appApi.dbRun(
      `INSERT INTO activity_log (matter_id, person_id, event_type, description, created_at)
       VALUES (?,?,?,?,?)`, [matterId, personId, eventType, description, new Date().toISOString()]);
  }

  // Returns false when nothing was saved.
  async function saveMatter({ silent } = {}) {
    // Checked before anything waits. Our Client Role decides the printed
    // "Attorney for …" line and which parties are the client, so a case is
    // never saved without one.
    const roleSel = document.getElementById('mat-client_role');
    if (roleSel.value !== 'plaintiff' && roleSel.value !== 'defendant') {
      alert('Choose Our Client Role (Plaintiff or Defendant) before saving.');
      roleSel.focus();
      return false;
    }
    let name = document.getElementById('mat-short_name').value;
    if (!name.trim()) name = `${parties.plaintiff[0]?.name||'Plaintiff'} v. ${parties.defendant[0]?.name||'Defendant'}`;

    const payload = [
      name, document.getElementById('mat-case_number').value, document.getElementById('mat-court_id').value || null,
      document.getElementById('mat-judge_id').value || null, document.getElementById('mat-client_role').value,
      document.getElementById('mat-caption_style').value, document.getElementById('mat-opposing_counsel').value,
      document.getElementById('mat-matter_type_id').value || null,
      document.getElementById('mat-party_label').value,
      document.getElementById('mat-caption_authority').value,
      document.getElementById('mat-plaintiff_label').value || 'Plaintiff',
      document.getElementById('mat-opposing_counsel_person_id').value || null,
      document.querySelector('input[name="mat-engagement_status"]:checked')?.value || null,
      document.getElementById('mat-case_number_pending').checked ? 1 : 0,
      document.getElementById('mat-attorney_id').value || null,
      // Intake fields, in MATTER_INTAKE_FIELDS order — the column lists below
      // are built from the same constant, so they cannot drift apart.
      ...MATTER_INTAKE_FIELDS.map(k => document.getElementById('mat-'+k).value.trim() || null)
    ];

    // CAPTURE THE ID BEFORE THE FIRST await. Every write below is an IPC round
    // trip that yields to the event loop, the Save button does not await this
    // function, and nothing locks the UI — so a click through to another matter
    // mid-save reassigns currentMatterId between steps. Read live, the writes
    // land on whichever matter happens to be open when each one runs: this
    // matter's caption notes, counsel, court dates and parties written onto
    // that one, and this one left with none. The charge prints from those
    // caption notes, so the wrong offence ends up in the wrong caption.
    //
    // Capturing AFTER the first await is not enough — that await is exactly
    // where the navigation gets in.
    //
    // Same reason savePriors(personId) takes its id as a parameter, and the
    // person save reads per-id once into a local before it starts.
    let matterId = currentMatterId;
    const isNewMatter = !matterId;

    // A contact (a judge, a clerk, opposing counsel) picked or typed as OUR
    // CLIENT on this case: a client is never also a contact (migration 37
    // holds the same line), so saving moves them to People, with their notes
    // and connections kept. Asked before anything is written; Cancel saves
    // nothing. A typed name is resolved exactly the way the party save below
    // resolves it, so the question is about the person that will be linked.
    const clientSideNow = document.getElementById('mat-client_role').value;
    const becomingClients = [];
    for (const p of parties[clientSideNow] || []) {
      if (!p.name || !p.name.trim()) continue;
      const who = p.person_id
        ? await appApi.dbGet('SELECT id, display_name, is_contact, contact_role FROM people WHERE id = ?', [p.person_id])
        : await appApi.dbGet('SELECT id, display_name, is_contact, contact_role FROM people WHERE display_name = ? AND archived = 0', [p.name.trim()]);
      if (who && who.is_contact && !becomingClients.some(b => b.id === who.id)) becomingClients.push(who);
    }
    if (becomingClients.length) {
      const names = becomingClients.map(b => `${b.display_name}${b.contact_role ? ` (${b.contact_role})` : ''}`).join('\n');
      const ok = confirm(`${becomingClients.length === 1 ? 'This person is' : 'These people are'} in Contacts:\n\n${names}\n\n` +
        'Saving them as our client on this case moves them from Contacts to People. ' +
        'Their notes and connections are kept.\n\nOK to save, Cancel to go back.');
      if (!ok) return false;
    }
    // Read BEFORE the write below, or there is nothing to compare the new
    // value against — the point of this read is what "changed" means.
    const priorStage = isNewMatter ? null
      : (await appApi.dbGet('SELECT stage FROM matters WHERE id = ?', [matterId]))?.stage || null;
    // A10: same reasoning, for court/judge/attorney. Resolved to NAMES here,
    // before the write, because a transfer row records what the court/judge/
    // attorney was actually called at the time — not an id that might later
    // point at a renamed or archived row.
    const priorAssignment = isNewMatter ? null : await appApi.dbGet(
      `SELECT c.name AS court_name, j.name AS judge_name, a.label AS attorney_label, a.name AS attorney_name
         FROM matters m
         LEFT JOIN courts c ON c.id = m.court_id
         LEFT JOIN judges j ON j.id = m.judge_id
         LEFT JOIN attorneys a ON a.id = m.attorney_id
        WHERE m.id = ?`, [matterId]);

    if (!matterId) {
      payload.push(new Date().toISOString());
      const cols = ['short_name', 'case_number', 'court_id', 'judge_id', 'client_role', 'caption_style', 'opposing_counsel', 'matter_type_id', 'party_label', 'caption_authority', 'plaintiff_label', 'opposing_counsel_person_id', 'engagement_status', 'case_number_pending', 'attorney_id', ...MATTER_INTAKE_FIELDS, 'created_at'];
      const res = await appApi.dbRun(
        `INSERT INTO matters (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`, payload);
      matterId = res.lastInsertRowid;
      // A brand-new matter becomes the open one only if the user is still here.
      if (!currentMatterId) currentMatterId = matterId;
    } else {
      payload.push(matterId);
      const sets = ['short_name=?', 'case_number=?', 'court_id=?', 'judge_id=?', 'client_role=?', 'caption_style=?', 'opposing_counsel=?', 'matter_type_id=?', 'party_label=?', 'caption_authority=?', 'plaintiff_label=?', 'opposing_counsel_person_id=?', 'engagement_status=?', 'case_number_pending=?', 'attorney_id=?', ...MATTER_INTAKE_FIELDS.map(k => k + '=?')];
      await appApi.dbRun(`UPDATE matters SET ${sets.join(', ')} WHERE id=?`, payload);
    }

    if (isNewMatter) {
      await logActivity('matter_created', `Matter created: ${name}`, { matterId });
    } else {
      const newStage = document.getElementById('mat-stage').value.trim() || null;
      if (newStage !== priorStage) {
        await logActivity('stage_changed',
          `Stage changed: ${priorStage || '(none)'} → ${newStage || '(none)'}`, { matterId });
      }

      // A10: log a transfer row for each of court/judge/attorney that
      // actually changed. Resolve the NEW side's name the same way the old
      // side was resolved above — from the just-selected combobox text, not
      // a second query, since the combobox's visible text already IS that name.
      const newCourtName = document.getElementById('mat-court').value.trim() || null;
      const newJudgeName = document.getElementById('mat-judge').value.trim() || null;
      const attSel = document.getElementById('mat-attorney_id');
      const newAttorneyName = attSel.value ? attSel.options[attSel.selectedIndex].textContent : null;
      const today = todayISO();
      const transfers = [
        ['court', priorAssignment.court_name, newCourtName],
        ['judge', priorAssignment.judge_name, newJudgeName],
        ['attorney', priorAssignment.attorney_label || priorAssignment.attorney_name, newAttorneyName]
      ].filter(([, from, to]) => (from || null) !== (to || null));
      for (const [field, from, to] of transfers) {
        await appApi.dbRun(
          `INSERT INTO matter_transfers (matter_id, field, from_value, to_value, transferred_on, created_at)
           VALUES (?,?,?,?,?,?)`,
          [matterId, field, from, to, today, new Date().toISOString()]);
      }
    }

    // Caption notes are replaced wholesale, in display order. Safe to delete
    // and reinsert: nothing references a note row, and every generated
    // document already carries its own frozen copy in matter_snapshot.
    // matters.charges is deliberately not written — it is retired (migration
    // 12) and this table is now the only source.
    // One transaction: these lines print in the caption of every filing, so a
    // DELETE that commits while an INSERT fails would quietly strip a client's
    // charge off their next document.
    const notesToSave = captionNotes
      .map(n => String(n.note_text || '').trim())
      .filter(Boolean);
    await appApi.dbTransaction([
      { sql: 'DELETE FROM matter_caption_notes WHERE matter_id = ?', params: [matterId] },
      ...notesToSave.map((text, i) => ({
        sql: 'INSERT INTO matter_caption_notes (matter_id, note_text, sort_order) VALUES (?,?,?)',
        params: [matterId, text, i]
      }))
    ]);

    // Additional counsel, replaced wholesale in display order — same reasoning
    // as the caption notes above: nothing references a row, and every
    // generated document already froze its own copy into matter_snapshot.
    const coToSave = coCounsel.map(c => c.attorney_id).filter(Boolean);
    await appApi.dbTransaction([
      { sql: 'DELETE FROM matter_attorneys WHERE matter_id = ?', params: [matterId] },
      ...coToSave.map((attorneyId, i) => ({
        sql: 'INSERT INTO matter_attorneys (matter_id, attorney_id, sort_order) VALUES (?,?,?)',
        params: [matterId, attorneyId, i]
      }))
    ]);

    // Court dates, replaced wholesale — snapshot and transaction both live in
    // saveMatterEvents. Zero events is an ordinary case: it clears whatever
    // was saved before and must not throw.
    await saveMatterEvents(matterId);
    await saveMatterPayments(matterId);

    // Keep the matter's first case row in step with the header fields.
    const firstCase = await appApi.dbGet(
      'SELECT id FROM matter_cases WHERE matter_id = ? ORDER BY sort_order, id LIMIT 1', [matterId]);
    const caseVals = [
      document.getElementById('mat-case_number').value,
      document.getElementById('mat-court_id').value || null,
      document.getElementById('mat-judge_id').value || null
    ];
    if (firstCase) {
      await appApi.dbRun('UPDATE matter_cases SET case_number=?, court_id=?, judge_id=? WHERE id=?', [...caseVals, firstCase.id]);
    } else {
      await appApi.dbRun('INSERT INTO matter_cases (matter_id, case_number, court_id, judge_id, sort_order) VALUES (?,?,?,?,0)', [matterId, ...caseVals]);
    }

    // Replace the extra case rows, keeping row 0 (the primary case) intact.
    const keepId = (await appApi.dbGet(
      'SELECT id FROM matter_cases WHERE matter_id = ? ORDER BY sort_order, id LIMIT 1', [matterId])).id;
    await appApi.dbRun('DELETE FROM matter_cases WHERE matter_id = ? AND id <> ?', [matterId, keepId]);
    for (let i = 0; i < extraCases.length; i++) {
      const c = extraCases[i];
      if (!(c.case_number || '').trim() && !(c.judge_name || '').trim()) continue;
      await appApi.dbRun(
        'INSERT INTO matter_cases (matter_id, case_number, judge_name, sort_order) VALUES (?,?,?,?)',
        [matterId, c.case_number || null, c.judge_name || null, i + 1]);
    }

    // Person ids are resolved FIRST, because creating a person needs its
    // lastInsertRowid back and a transaction batch cannot feed one statement's
    // result into the next. Once every row knows its person, the delete and the
    // re-inserts go in as one unit — a caption that lost half its parties
    // midway would name the wrong people on the next filing.
    const clientSide = document.getElementById('mat-client_role').value;
    const partyRows = [];
    for (const side of ['plaintiff', 'defendant']) {
      for (let i = 0; i < parties[side].length; i++) {
        const p = parties[side][i];
        if (!p.name || !p.name.trim()) continue;
        // A typed-but-unlinked name still becomes a person, so the People book
        // stays complete and the same name reused later matches an existing row.
        let personId = p.person_id || null;
        if (!personId) {
          const existing = await appApi.dbGet(
            'SELECT id FROM people WHERE display_name = ? AND archived = 0', [p.name.trim()]);
          personId = existing
            ? existing.id
            : (await appApi.dbRun('INSERT INTO people (display_name, kind, created_at) VALUES (?,?,?)',
                [p.name.trim(), 'individual', new Date().toISOString()])).lastInsertRowid;
        }
        partyRows.push([matterId, personId, p.name.trim(), side,
          clientSide === side ? 'client' : 'opposing_party', i]);
      }
    }
    // Only the contacts asked about above, and only if they did end up as a
    // client party.
    const nowClients = becomingClients.map(b => b.id)
      .filter(id => partyRows.some(r => r[1] === id && r[4] === 'client'));
    await appApi.dbTransaction([
      { sql: 'DELETE FROM parties WHERE matter_id = ?', params: [matterId] },
      ...partyRows.map(params => ({
        sql: 'INSERT INTO parties (matter_id, person_id, name, side, role, sort_order) VALUES (?,?,?,?,?,?)',
        params
      })),
      // Once a contact becomes a client party, the leftover contact-only
      // fields (their role tag and who they work for) no longer describe
      // them and would otherwise keep showing on the client's own profile.
      // Their matter_contacts rows on OTHER cases are left alone — they may
      // legitimately still be listed there — so "Who's involved" and the
      // contact Cases list must handle a non-contact person gracefully.
      ...nowClients.map(id => ({
        sql: 'UPDATE people SET is_contact = 0, contact_role = NULL, works_at_court_id = NULL, works_at_org_id = NULL WHERE id = ?',
        params: [id]
      }))
    ]);
    
    // Only touch the screen if it is still showing the matter that was saved.
    // If the user clicked through to another matter while this ran, writing
    // this matter's name into the form and loading its documents would dress
    // the other matter up as this one.
    if (currentMatterId === matterId) {
      document.getElementById('btn-goto-generate').classList.remove('hidden');
      showMatterFileButtons(true);
      document.getElementById('mat-short_name').value = name;
      loadDocuments(matterId);
      renderMatterActivity(matterId);
      renderMatterTransfers(matterId);
      // The court, judge and opposing counsel rows follow what was just saved.
      renderWhosInvolved(document.getElementById('matter-who'), matterId);
      // Saved, so leaving no longer costs anything.
      markFormClean('view-matter-detail');
    }
    if (!silent) alert('Matter saved.');
  }
  document.getElementById('btn-save-matter').addEventListener('click', () => saveMatter());

  // Which signing profile a case's documents default to. Shared by Generate
  // and the packet screen so the two can never disagree.
  //   1. the case's own assigned attorney (matters.attorney_id, A10) — the most
  //      specific choice, set when this case was assigned or transferred;
  //   2. the FIRST client party's signing profile ("Signs as"), and only if
  //      that party is an Organization — an Individual keeps whatever a Type
  //      flip left hidden on the profile;
  //   3. the case type's attorney.
  // A choice pointing at a profile that no longer exists (an older backup, a
  // merge) is skipped. Returns null when nothing applies — the caller then
  // falls back to the default profile.
  async function preferredAttorneyId(matterId, atts) {
    if (!matterId) return null;
    const m = await appApi.dbGet(
      `SELECT m.attorney_id, mt.attorney_id AS type_attorney_id
       FROM matters m LEFT JOIN matter_types mt ON mt.id = m.matter_type_id
       WHERE m.id = ?`, [matterId]);
    const orgSigner = await appApi.dbGet(
      `SELECT pe.kind, pe.signing_attorney_id
       FROM parties pa JOIN people pe ON pe.id = pa.person_id
       WHERE pa.matter_id = ? AND pa.role = 'client'
       ORDER BY pa.sort_order, pa.id LIMIT 1`, [matterId]);
    return [
      m && m.attorney_id,
      orgSigner && orgSigner.kind === 'organization' && orgSigner.signing_attorney_id,
      m && m.type_attorney_id
    ].find(id => id && atts.some(a => a.id === id)) || null;
  }

  // GENERATE FLOW
  // Extracted so the wizard's Step 3 can open Generate the same way clicking
  // the button already does, then preselect the chosen doctype on top of it.
  async function openGenerateForMatter() {
    // Opening Generate fresh always starts from live matter data. Regenerate
    // (loadDocToGenerate, below) re-arms this after this handler's dropdown
    // population finishes, since it triggers this same click.
    regenerateFromSnapshot = null;
    document.getElementById('gen-regen-banner').classList.add('hidden');
    // Captured before the first await: every query below must describe the
    // same case, even if the user clicks through to another one meanwhile.
    const matterId = currentMatterId;

    // Populate dropdowns
    // The matter type can restrict which documents are offered and which
    // attorney record is used, so a city prosecution matter does not present
    // the whole catalog every time.
    const typeRow = matterId
      ? await appApi.dbGet(
          `SELECT mt.doc_type_ids
           FROM matters m JOIN matter_types mt ON mt.id = m.matter_type_id
           WHERE m.id = ?`, [matterId])
      : null;

    let allowed = null;
    if (typeRow && typeRow.doc_type_ids) {
      try {
        const parsed = JSON.parse(typeRow.doc_type_ids);
        if (Array.isArray(parsed) && parsed.length) allowed = parsed;
      } catch { /* malformed config must not hide every document */ }
    }

    const selDoc = document.getElementById('gen-doctype');
    selDoc.innerHTML = '';
    window.DocumentEngine.doctypes
      // packetOnly doc types (the C&D and driver-license documents) have no
      // `fields.packet` here — they belong to the packet flow, which is what
      // the flag has always meant; it just wasn't being read.
      .filter(dt => !dt.packetOnly)
      .filter(dt => !allowed || allowed.includes(dt.id))
      .forEach(dt => selDoc.appendChild(new Option(dt.label, dt.id)));

    const selAtt = document.getElementById('gen-attorney');
    selAtt.innerHTML = '';
    const atts = await appApi.dbAll('SELECT * FROM attorneys');
    const winner = await preferredAttorneyId(matterId, atts);
    atts.forEach(a => {
      const opt = new Option(a.label || a.firm_name || a.name, a.id);
      opt.selected = winner ? a.id === winner : !!a.is_default;
      selAtt.appendChild(opt);
    });

    renderDynamicFields();
    document.getElementById('gen-result').classList.add('hidden');
    lastGeneratedPath = null;
    await preflight();
    showView('generate');
  }
  document.getElementById('btn-goto-generate').onclick = openGenerateForMatter;

  // WIZARD STEP 3 — grouped, searchable doctype picker
  // (intake-wizard design notes §4). Choosing a type
  // creates the matter (once, here — not incrementally per step) and opens
  // Generate with it preselected, same transition as clicking a doctype does
  // from the matter-detail toolbar today.
  async function goToDoctypePicker() {
    showView('wizard-doctype');
    document.getElementById('wizard-doctype-search').value = '';
    await renderWizardDoctypePicker();
  }

  async function renderWizardDoctypePicker(filterTerm = '') {
    const container = document.getElementById('wizard-doctype-groups');
    container.innerHTML = '';

    // Same allowlist logic as openGenerateForMatter's own dropdown — a
    // matter type can restrict which documents it offers.
    const typeId = document.getElementById('mat-matter_type_id').value || null;
    const typeRow = typeId
      ? await appApi.dbGet('SELECT doc_type_ids FROM matter_types WHERE id = ?', [typeId])
      : null;
    let allowed = null;
    if (typeRow && typeRow.doc_type_ids) {
      try {
        const parsed = JSON.parse(typeRow.doc_type_ids);
        if (Array.isArray(parsed) && parsed.length) allowed = parsed;
      } catch { /* malformed config must not hide every document */ }
    }

    const term = filterTerm.trim().toLowerCase();
    const available = window.DocumentEngine.doctypes
      .filter(dt => !dt.packetOnly)
      .filter(dt => !allowed || allowed.includes(dt.id))
      .filter(dt => !term || dt.label.toLowerCase().includes(term));

    const makeRow = (dt) => {
      const row = document.createElement('div');
      row.className = 'btn';
      row.style.cssText = 'display:block; width:100%; text-align:left; margin-bottom:4px; cursor:pointer;';
      row.textContent = dt.label;
      row.addEventListener('click', () => confirmWizardDoctype(dt.id));
      return row;
    };

    if (!term) {
      const recentRows = await appApi.dbAll(
        `SELECT doc_type, MAX(created_at) latest FROM generated_files
         GROUP BY doc_type ORDER BY latest DESC LIMIT 3`);
      const recentIds = recentRows.map(r => r.doc_type).filter(id => available.some(dt => dt.id === id));
      if (recentIds.length) {
        const heading = document.createElement('div');
        heading.style.cssText = 'font-weight:bold; margin:10px 0 4px;';
        heading.textContent = 'Recent';
        container.appendChild(heading);
        recentIds.forEach(id => container.appendChild(makeRow(available.find(dt => dt.id === id))));
      }
    }

    const groups = [...new Set(available.map(dt => dt.group).filter(Boolean))];
    groups.forEach(group => {
      const inGroup = available.filter(dt => dt.group === group);
      if (!inGroup.length) return; // no placeholder rows for empty groups
      const heading = document.createElement('div');
      heading.style.cssText = 'font-weight:bold; margin:10px 0 4px;';
      heading.textContent = group;
      container.appendChild(heading);
      inGroup.forEach(dt => container.appendChild(makeRow(dt)));
    });
  }

  document.getElementById('wizard-doctype-search').addEventListener('input', (e) => renderWizardDoctypePicker(e.target.value));
  document.getElementById('btn-wizard3-back').addEventListener('click', () => enterWizardStep(2));

  async function confirmWizardDoctype(doctypeId) {
    if (await saveMatter({ silent: true }) === false) return;
    wizardMode = false;
    await openGenerateForMatter();
    document.getElementById('gen-doctype').value = doctypeId;
    renderDynamicFields();
    await preflight();
  }

  document.getElementById('btn-back-from-gen').onclick = () => showView('matter-detail');

  document.getElementById('gen-regen-discard').addEventListener('click', (e) => {
    e.preventDefault();
    regenerateFromSnapshot = null;
    document.getElementById('gen-regen-banner').classList.add('hidden');
  });
  document.getElementById('gen-doctype').onchange = () => { renderDynamicFields(); preflight(); };

  function renderDynamicFields(prefill = {}) {
    const dtId = document.getElementById('gen-doctype').value;
    const dt = window.DocumentEngine.doctypes.find(x => x.id === dtId);
    const container = document.getElementById('gen-dynamic-fields');
    container.innerHTML = '';
    
    if (dt && dt.fields) {
      dt.fields.forEach(f => {
        const div = document.createElement('div');
        div.className = 'form-group'; div.style.marginBottom = '8px';
        div.innerHTML = `<label>${f.label}</label>`;
        const val = prefill[f.id] !== undefined ? prefill[f.id] : (f.default || '');
        if (f.type === 'textarea') div.innerHTML += `<textarea id="field_${f.id}" rows="8" style="font-family: monospace;">${val}</textarea>`;
        else if (f.type === 'select') {
          let sel = `<select id="field_${f.id}">`;
          f.options.forEach(o => sel += `<option value="${o}" ${val===o?'selected':''}>${o}</option>`);
          sel += `</select>`; div.innerHTML += sel;
        } 
        else if (f.type === 'date') div.innerHTML += `<input type="date" id="field_${f.id}" value="${val || new Date().toISOString().split('T')[0]}">`;
        else div.innerHTML += `<input type="text" id="field_${f.id}" value="${val}">`;
        container.appendChild(div);
        if (f.type === 'date') withTodayButton(div.querySelector('input')); // A8
      });
    }
  }

  // Reopens a past document: its field values are loaded editable into the
  // form, but the matter/attorney context is frozen to what this document's
  // own row recorded (matter_snapshot / attorney_snapshot) until the user
  // explicitly discards it via the banner — see gatherRenderData().
  window.loadDocToGenerate = async (docId) => {
    const doc = await appApi.dbGet('SELECT * FROM documents WHERE id = ?', [docId]);
    document.getElementById('btn-goto-generate').click();
    setTimeout(() => {
      document.getElementById('gen-doctype').value = doc.doc_type;
      renderDynamicFields(JSON.parse(doc.field_data || '{}'));

      if (doc.matter_snapshot) {
        regenerateFromSnapshot = {
          matter: JSON.parse(doc.matter_snapshot),
          attorney: doc.attorney_snapshot ? JSON.parse(doc.attorney_snapshot) : null
        };
        if (regenerateFromSnapshot.attorney && regenerateFromSnapshot.attorney.id != null) {
          const selAtt = document.getElementById('gen-attorney');
          if (selAtt.querySelector(`option[value="${regenerateFromSnapshot.attorney.id}"]`)) {
            selAtt.value = String(regenerateFromSnapshot.attorney.id);
          }
        }
        const banner = document.getElementById('gen-regen-banner');
        document.getElementById('gen-regen-banner-text').textContent =
          `Regenerating from the version generated ${new Date(doc.created_at).toLocaleString()} — later matter changes are not reflected.`;
        banner.classList.remove('hidden');
      } else {
        // Documents created before matter_snapshot existed have nothing to
        // freeze to; fall back to live matter data rather than silently
        // producing a document with no caption.
        regenerateFromSnapshot = null;
        document.getElementById('gen-regen-banner').classList.add('hidden');
      }
    }, 100);
  };

  // opts.skipDocType: a packet supplies its own doc types and has no
  // doc-type picker on screen, so the tail of this function must not try to
  // read one out of the generate form.
  async function gatherRenderData(opts = {}) {
    let m, attorney;
    if (regenerateFromSnapshot) {
      m = regenerateFromSnapshot.matter;
      attorney = regenerateFromSnapshot.attorney;
    } else if (!currentMatterId) {
      // Standalone letter: no matter row exists. A synthetic object shaped
      // like what the query below would return, with every field a caption/
      // letter block might read either present-and-empty or simply absent
      // (every render site already treats a missing case_number, court_name,
      // etc. as "print the blank" — see the temp-case-number-flag branch's
      // same-shaped fallbacks).
      m = {
        id: null, case_number: null, case_number_pending: 0,
        court_name: null, court_header_line: null, court_city: null, court_county: null,
        judge_name: null, type_caption_authority: null, type_attorney_id: null,
        parties: [], cases: [], caption_notes: [], co_counsel: []
      };
      const attId = document.getElementById('gen-attorney').value;
      attorney = await appApi.dbGet('SELECT * FROM attorneys WHERE id = ?', [attId]);
      m.our_counsel = attorney ? {
        name: attorney.name, bar_number: attorney.bar_number, firm_name: attorney.firm_name,
        address: attorney.firm_address, phone: attorney.firm_phone, email: attorney.firm_email
      } : {};
      m.opposing_counsel_person = {};
    } else {
      // The matter type supplies the default caption authority. Without joining it
      // here, only a per-matter override reached the document and picking
      // "Criminal Defense" produced no "PEOPLE OF THE STATE OF MICHIGAN" line.
      m = await appApi.dbGet(
        `SELECT m.*, c.name as court_name, c.header_line as court_header_line,
                c.city as court_city, c.county as court_county,
                j.name as judge_name,
                mt.caption_authority AS type_caption_authority,
                mt.attorney_id       AS type_attorney_id
         FROM matters m
         LEFT JOIN courts c ON m.court_id = c.id
         LEFT JOIN judges j ON m.judge_id = j.id
         LEFT JOIN matter_types mt ON mt.id = m.matter_type_id
         WHERE m.id = ?`, [currentMatterId]);
      m.parties = await appApi.dbAll('SELECT * FROM parties WHERE matter_id = ? ORDER BY sort_order', [currentMatterId]);

      // Every case number/judge pair on the matter — an appeal carries the case
      // below as well as the appeal itself.
      m.cases = await appApi.dbAll(
        `SELECT mc.*, COALESCE(mc.judge_name, j.name) AS judge_name
         FROM matter_cases mc LEFT JOIN judges j ON j.id = mc.judge_id
         WHERE mc.matter_id = ? ORDER BY mc.sort_order, mc.id`, [currentMatterId]);

      // The caption's note stack. ALWAYS set, even when empty: the renderers
      // treat a missing caption_notes as "this snapshot predates migration 12"
      // and fall back to the retired matters.charges column, which for a live
      // matter would print notes the user has since deleted.
      m.caption_notes = (await appApi.dbAll(
        'SELECT note_text FROM matter_caption_notes WHERE matter_id = ? ORDER BY sort_order, id',
        [currentMatterId])).map(r => r.note_text);

      // Additional counsel of record, resolved to name/bar number here so the
      // snapshot is self-contained — same principle as parties.name. ALWAYS
      // set, even when empty, so the renderers never have to guess whether a
      // missing list means "none" or "this snapshot predates migration 16".
      m.co_counsel = await appApi.dbAll(
        `SELECT a.id, a.name, a.bar_number
         FROM matter_attorneys ma JOIN attorneys a ON a.id = ma.attorney_id
         WHERE ma.matter_id = ? ORDER BY ma.sort_order, ma.id`, [currentMatterId]);

      const attId = document.getElementById('gen-attorney').value;
      attorney = await appApi.dbGet('SELECT * FROM attorneys WHERE id = ?', [attId]);

      // Both counsel blocks print in an appellate caption, so opposing counsel is
      // a structured person rather than the free-text service blob.
      m.our_counsel = attorney ? {
        name: attorney.name, bar_number: attorney.bar_number, firm_name: attorney.firm_name,
        address: attorney.firm_address, phone: attorney.firm_phone, email: attorney.firm_email
      } : {};
      m.opposing_counsel_person = {};
      if (m.opposing_counsel_person_id) {
        const oc = await appApi.dbGet('SELECT * FROM people WHERE id = ?', [m.opposing_counsel_person_id]);
        if (oc) {
          m.opposing_counsel_person = {
            name: oc.display_name, bar_number: oc.bar_number || '',
            // Opposing counsel is a `people` row like any other, so its address
            // comes from the same composer — this block prints in an appellate
            // caption, and reading the raw blob here would print a superseded
            // address on a filing.
            firm_name: oc.firm_name, address: composePersonAddress(oc), phone: oc.phone, email: oc.email
          };
        }
      }
    }

    // Signature image is opt-in per generation, not automatic just because one
    // is saved on the attorney profile. Single-document generate reads its own
    // checkbox; a caller with a different one (the packet view has its own,
    // since it isn't the Generate Document view) passes opts.includeSignature
    // explicitly instead of relying on gen-include-signature's leftover state.
    const includeSignature = typeof opts.includeSignature === 'boolean'
      ? opts.includeSignature
      : document.getElementById('gen-include-signature').checked;
    if (attorney && attorney.signature_image && !includeSignature) {
      attorney = { ...attorney, signature_image: null };
    }

    if (opts.skipDocType) return { matter: m, attorney, dt: null, fields: {} };

    const dtId = document.getElementById('gen-doctype').value;
    const dt = window.DocumentEngine.doctypes.find(x => x.id === dtId);

    const fields = {};
    dt.fields.forEach(f => {
      const el = document.getElementById(`field_${f.id}`);
      if (el) fields[f.id] = el.value;
    });

    return { matter: m, attorney, dt, fields };
  }
  // Reached directly by the smoke harness so a guard test drives the same
  // path the Generate buttons use, rather than hand-building a matter object
  // that could silently diverge from what this function actually reads.
  window.gatherRenderData = gatherRenderData;

  // Same HTML the PDF path renders (renderer.js's generateDocument() calls
  // this identically at the DocumentEngine.renderHtml() call site below).
  // print.css is injected so the preview visually matches the real PDF —
  // main.js's generate-pdf IPC handler is the only other place that loads
  // print.css; without it here, a signature image would show unconstrained
  // (see design doc's corrected §2).
  let cachedPrintCss = null;
  async function getPrintCss() {
    if (cachedPrintCss === null) {
      cachedPrintCss = await appApi.readPrintCss();
    }
    return cachedPrintCss;
  }

  let previewZoom = 1;
  function applyPreviewZoom(frameId, labelId) {
    document.getElementById(frameId).style.transform = `scale(${previewZoom})`;
    document.getElementById(labelId).textContent = `${Math.round(previewZoom * 100)}%`;
  }

  async function renderPreview(html, panelId = 'preview-panel', frameId = 'preview-frame') {
    const css = await getPrintCss();
    const frame = document.getElementById(frameId);
    frame.srcdoc = `<!DOCTYPE html><html><head><style>${css}</style></head><body><div id="print-container">${html}</div></body></html>`;
    document.getElementById(panelId).classList.remove('hidden');
    previewZoom = 1;
    applyPreviewZoom(frameId, panelId === 'preview-panel' ? 'preview-zoom-label' : 'packet-preview-zoom-label');
  }

  document.getElementById('btn-preview').addEventListener('click', async () => {
    const { matter, attorney, dt, fields } = await gatherRenderData();
    if (!dt) return;
    const blocks = dt.build(matter, attorney, fields);
    await renderPreview(window.DocumentEngine.renderHtml(blocks, matter, attorney));
  });

  document.getElementById('btn-preview-zoom-in').addEventListener('click', () => {
    previewZoom = Math.min(previewZoom + 0.1, 2);
    applyPreviewZoom('preview-frame', 'preview-zoom-label');
  });
  document.getElementById('btn-preview-zoom-out').addEventListener('click', () => {
    previewZoom = Math.max(previewZoom - 0.1, 0.3);
    applyPreviewZoom('preview-frame', 'preview-zoom-label');
  });

  // The preview panel's own signature checkbox mirrors the Generate view's —
  // checking either one checks the other, so re-clicking Preview after
  // toggling from inside the panel already reflects the right state.
  {
    const genSigBox = document.getElementById('gen-include-signature');
    const previewSigBox = document.getElementById('preview-include-signature');
    genSigBox.addEventListener('change', () => { previewSigBox.checked = genSigBox.checked; });
    previewSigBox.addEventListener('change', () => { genSigBox.checked = previewSigBox.checked; });
  }

  // After generating, offer to open the file rather than making the user hunt
  // through Explorer for it.
  let lastGeneratedPath = null;

  // ---- Folder owner ---------------------------------------------------------
  // Main answers { needsFolderOwner: true } — and writes nothing — when a case
  // has several clients (or none) and nobody has said whose folder it lives
  // in yet. The case folder is created once and never moves, so the app asks
  // (the #folder-owner-picker in index.html) rather than guessing.
  const FOLDER_OWNER_CANCELLED =
    'Not saved: no folder was chosen for this case. Generate again to choose ' +
    'which client\u2019s folder it is saved in.';
  const FOLDER_OWNER_FAILED =
    'Not saved: that choice could not be saved for this case. Check the ' +
    'case\u2019s clients and generate again.';
  // The "not saved" wording for a { needsFolderOwner } result.
  const folderOwnerMessage = (res) =>
    res && res.folderOwnerFailed ? FOLDER_OWNER_FAILED : FOLDER_OWNER_CANCELLED;

  // One question per case, one picker on screen at a time. A second ask for
  // the SAME case shares the answer already being asked for; an ask for a
  // DIFFERENT case waits for the open picker to close and then asks its own
  // question (it must never inherit another case's answer).
  const folderOwnerAsks = new Map();
  let folderOwnerTurn = Promise.resolve();

  // Show the picker for matterId. Resolves 'chosen' once a choice is stored
  // (or the case's folder turned out to be set meanwhile), 'cancelled' on
  // Cancel (nothing stored; folder_person_id stays NULL), or 'failed' when
  // main refused the choice and the case is still undecided.
  function ensureFolderOwner(matterId) {
    if (folderOwnerAsks.has(matterId)) return folderOwnerAsks.get(matterId);
    const ask = folderOwnerTurn.then(() => askFolderOwner(matterId));
    folderOwnerTurn = ask.catch(() => {});
    const tracked = ask.finally(() => folderOwnerAsks.delete(matterId));
    folderOwnerAsks.set(matterId, tracked);
    return tracked;
  }
  // Reached directly by the smoke harness (two cases asked at once).
  window.ensureFolderOwner = ensureFolderOwner;

  async function askFolderOwner(matterId) {
    const [candidates, m] = await Promise.all([
      appApi.matterFolderCandidates(matterId),
      appApi.dbGet('SELECT short_name, case_number FROM matters WHERE id = ?', [matterId])
    ]);
    const picker = document.getElementById('folder-owner-picker');
    const options = document.getElementById('folder-owner-options');
    const save = document.getElementById('btn-folder-owner-save');
    const cancel = document.getElementById('btn-folder-owner-cancel');

    // Client names are user data: textContent only, never innerHTML.
    options.replaceChildren();
    candidates.forEach(c => {
      const label = document.createElement('label');
      label.style.cssText = 'display:block; margin:4px 0;';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'folder-owner';
      radio.value = String(c.person_id);
      radio.style.marginRight = '6px';
      label.appendChild(radio);
      label.appendChild(document.createTextNode(c.name || 'Unnamed client'));
      options.appendChild(label);
    });
    picker.querySelectorAll('input[name="folder-owner"]').forEach(r => { r.checked = false; });
    document.getElementById('folder-owner-none-note').classList.toggle('hidden', candidates.length > 0);
    document.getElementById('folder-owner-case').textContent = m
      ? [m.short_name, m.case_number ? `(${m.case_number})` : ''].filter(Boolean).join(' ')
      : '';
    // Save stays disabled (and greyed, by .btn:disabled) until a choice is made.
    const setSaveEnabled = (on) => { save.disabled = !on; };
    setSaveEnabled(false);
    picker.onchange = () => setSaveEnabled(!!picker.querySelector('input[name="folder-owner"]:checked'));
    picker.classList.remove('hidden');

    const choice = await new Promise(resolve => {
      save.onclick = () => {
        const sel = picker.querySelector('input[name="folder-owner"]:checked');
        if (sel) resolve(Number(sel.value));
      };
      cancel.onclick = () => resolve(null);
    });
    save.onclick = null;
    cancel.onclick = null;
    picker.onchange = null;
    picker.classList.add('hidden');
    if (choice == null) return 'cancelled';
    const res = await appApi.setMatterFolderOwner(matterId, choice);
    if (res && res.changed) return 'chosen';
    // Not stored. If the case's folder was set in the meantime the retry will
    // simply use it; otherwise the choice was refused (e.g. that person is no
    // longer a client on the case) and saying "cancelled" would be a lie.
    const now = await appApi.dbGet('SELECT output_dir FROM matters WHERE id = ?', [matterId]);
    return now && now.output_dir ? 'chosen' : 'failed';
  }

  // Run a save (generatePdf / generateDocx / saveAttachedFile). If main asks
  // whose folder the case belongs in, show the picker, store the answer and
  // run it exactly once more. On Cancel the original { needsFolderOwner: true }
  // comes back, so the caller knows nothing was written.
  async function withFolderOwner(matterId, fn) {
    const first = await fn();
    if (!(first && first.needsFolderOwner) || !matterId) return first;
    const answer = await ensureFolderOwner(matterId);
    if (answer === 'cancelled') return first;
    if (answer === 'failed') return { ...first, folderOwnerFailed: true };
    return fn();
  }

  // Saves run one at a time. handleGenerate decides whether a PDF and a Word
  // file share one documents row by looking at the latest row AFTER its save;
  // two saves in flight at once (PDF clicked, then Word before the PDF came
  // back) would both find nothing and write two rows. Queuing, rather than
  // disabling the buttons, keeps the second click instead of dropping it.
  let saveQueue = Promise.resolve();
  function queueSave(fn) {
    const run = saveQueue.then(fn);
    saveQueue = run.catch(() => {});
    return run;
  }

  function showGenerateResult(result) {
    const box = document.getElementById('gen-result');
    if (result && result.needsFolderOwner) {
      lastGeneratedPath = null;
      document.getElementById('gen-result-text').textContent = folderOwnerMessage(result);
      box.classList.remove('hidden');
      return;
    }
    if (result && result.error) {
      lastGeneratedPath = null;
      document.getElementById('gen-result-text').textContent = result.error;
      box.classList.remove('hidden');
      refreshRootBanner();
      return;
    }
    if (!result || !result.path) { box.classList.add('hidden'); return; }
    lastGeneratedPath = result.path;
    document.getElementById('gen-result-text').textContent = result.unchanged
      ? `No changes since the last version — reusing:  ${result.path}`
      : `Saved:  ${result.path}`;
    box.classList.remove('hidden');
  }

  document.getElementById('btn-open-doc').addEventListener('click', async () => {
    if (!lastGeneratedPath) return;
    const res = await appApi.openPath(lastGeneratedPath);
    if (!res.ok) alert(res.error);
  });
  document.getElementById('btn-show-folder').addEventListener('click', async () => {
    if (!lastGeneratedPath) return;
    const res = await appApi.showInFolder(lastGeneratedPath);
    if (!res.ok) alert(res.error);
  });

  // Placeholders like [COURT] and [CITY] were reaching finished documents.
  // Warn before generating rather than after it has been printed and filed.
  // Only an ISO date may be prefilled. Migration 17 normalized everything it
  // could and deliberately left ambiguous values ("3/4/80") alone, so anything
  // still non-ISO is precisely the value we must NOT copy into a filing.
  // Blank beats wrong: the user retypes it, rather than a document printing a date
  // nobody chose.
  const usableIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim());

  // ---- Missing-information resolvers ---------------------------------------
  // Extracted from preflight(), which had these rules inline and so could only
  // ever show them on the Generate screen — i.e. once you were already filing.
  // The wording is deliberately unchanged from the original; three screens now
  // show the same sentences, and they must not drift apart.
  //
  // Pure functions: they take rows and return strings. Nothing here queries,
  // renders or blocks. Generation is never prevented by an issue.

  const MATTER_ISSUE_QUERY =
    `SELECT m.*, c.name AS court_name, mt.caption_authority AS type_caption_authority
     FROM matters m
     LEFT JOIN courts c ON c.id = m.court_id
     LEFT JOIN matter_types mt ON mt.id = m.matter_type_id
     WHERE m.id = ?`;

  function matterIssues(m, parties) {
    if (!m) return [];
    const list = parties || [];
    const authority = (m.caption_authority || m.type_caption_authority || '');
    const problems = [];
    if (!m.court_name) problems.push('No court is set — the caption will read "IN THE [COURT]".');
    if (/\[[A-Z ]+\]/.test(authority)) {
      problems.push(`The caption authority still has a placeholder in it: "${authority}". Edit it in Settings → Matter Types, or override it on this matter.`);
    }
    if (!authority && !list.some(p => p.side === 'plaintiff')) {
      problems.push('No caption authority and no plaintiff — the caption has nothing to name as the moving party.');
    }
    if (!list.some(p => p.side === 'defendant')) problems.push('No defendant listed.');
    // A stage that hides the case number is a stage at which no case number
    // exists yet. Asking for one there is the nag that teaches the user to stop
    // reading the box.
    if (stageRule(m.stage, 'case_number') !== 'hidden') {
      if (!m.case_number) problems.push('No case number.');
      else if (m.case_number_pending) problems.push('Case number marked pending — caption will print blank until cleared.');
    }
    const blank = (k) => !String(m[k] == null ? '' : m[k]).trim();
    if (stageRule(m.stage, 'citation_number') === 'required' && blank('citation_number')) {
      problems.push('No citation / ticket number.');
    }
    if (stageRule(m.stage, 'date_of_offense') === 'required' && blank('date_of_offense')) {
      problems.push('No date of offense.');
    }
    // BAC is never pushed here at any stage, deliberately: "refused" is a real
    // answer and a blank is not something the client can always fix.
    return problems;
  }

  // This box is the app's only nag, so what it asks for is a deliberate,
  // short list: date of birth, address, cell phone, driver's licence number.
  // Those are the answers a filing or a letter actually needs, and every one
  // of them is a thing the client can only supply in person.
  //
  // Everything else the intake questionnaire collects — medical issues,
  // medications, the marijuana card, education, the emergency contact, priors,
  // home phone, employer, marital status, citizenship — is deliberately NOT
  // flagged. They matter on some matters and on none of the others, and a list
  // that asks for all of them on every client is a list nobody reads. The
  // sections carry a filled-marker dot instead, which answers "is there
  // anything in there?" without demanding an answer.
  //
  // (The licence number was previously left out on the same reasoning. It is
  // in now because it is one of the handful of identity facts the intake sheet
  // asks every client for, not because a civil matter needs it.)
  function personIssues(person) {
    if (!person) return [];
    const problems = [];
    const val = (k) => String(person[k] == null ? '' : person[k]).trim();
    // A company has no birthday and no driver's licence. Asking it for either
    // would give every organization on file a permanent list of things it can
    // never supply — the fastest way to teach someone to ignore the box.
    const isOrganization = val('kind') === 'organization';

    const dob = val('dob');
    if (!isOrganization) {
      if (!dob) {
        problems.push('No date of birth recorded.');
      } else if (!usableIsoDate(dob)) {
        // Migration 17 converted what it safely could and left the rest alone.
        // Whatever is still non-ISO is precisely what will not be prefilled.
        problems.push(`Date of birth "${dob}" is not a usable date, so it will not be filled into a filing. Re-enter it.`);
      }
    }

    // Street, City and ZIP are three independent boxes with nothing requiring
    // them to be filled together, so "partly filled" is a state a real profile
    // sits in. composePersonAddress refuses to print a half-composed address —
    // it falls back to the legacy blob — so nothing goes out wrong, but that
    // fallback is silent, and a half-entered address left unmentioned stays
    // half-entered forever. Say so here, and say WHICH halves are missing.
    const addressParts = [['street', 'Street'], ['city', 'City'], ['zip', 'ZIP']];
    const missingAddress = addressParts.filter(([k]) => !val(k)).map(([, label]) => label);
    if (missingAddress.length === addressParts.length) {
      problems.push('No address recorded — Street, City and ZIP are all blank.');
    } else if (missingAddress.length) {
      // Says what to do, not how the app copes. The earlier wording explained
      // the legacy-blob fallback, which meant a change to composePersonAddress
      // silently turned this line into a false promise — and it did, once.
      problems.push(`Address is only partly filled in — ${listPhrase(missingAddress)} still blank.`);
    }

    // An organization's contact number is whatever line it has — an office
    // switchboard is not a cell phone, and any of the three will do.
    if (isOrganization) {
      if (!val('cell_phone') && !val('home_phone') && !val('phone')) problems.push('No phone number recorded.');
    } else if (!val('cell_phone')) {
      problems.push('Cell phone number is missing.');
    }
    if (!isOrganization && !val('license_number')) {
      problems.push("Driver's license number is missing.");
    }
    return problems;
  }

  // "Street", "City and ZIP", "Street, City and ZIP" — an Oxford-comma-free
  // list, because these sentences are read, not parsed.
  function listPhrase(items) {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  // One renderer for all three boxes, so they cannot drift in shape either.
  function renderIssueList(box, problems, heading) {
    if (!box) return;
    box.innerHTML = '';
    if (!problems.length) { box.classList.add('hidden'); return; }
    const title = document.createElement('div');
    title.style.fontWeight = 'bold';
    title.textContent = heading;
    box.appendChild(title);
    const ul = document.createElement('ul');
    ul.style.margin = '4px 0 0 18px';
    problems.forEach(t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
    box.appendChild(ul);
    box.classList.remove('hidden');
  }

  // The stage dropdown decides what the box asks for, so the box has to answer
  // to the dropdown as it stands right now, not as it stood at the last save.
  // Only ever applied to the matter the form is actually showing; the matters
  // list renders straight from its own rows and never comes through here.
  function withLiveStageFields(m, matterId) {
    const sel = document.getElementById('mat-stage');
    if (!m || !sel || matterId !== currentMatterId) return m;
    const live = Object.assign({}, m, { stage: sel.value });
    STAGE_GOVERNED_FIELDS.forEach(f => {
      const el = document.getElementById('mat-' + f);
      if (el) live[f] = el.value.trim();
    });
    return live;
  }

  async function matterIssuesFor(matterId) {
    if (!matterId) return [];
    const m = await appApi.dbGet(MATTER_ISSUE_QUERY, [matterId]);
    const parties = await appApi.dbAll('SELECT * FROM parties WHERE matter_id = ?', [matterId]);
    return matterIssues(withLiveStageFields(m, matterId), parties);
  }

  async function preflight() {
    const box = document.getElementById('gen-warnings');
    if (!currentMatterId) { box.innerHTML = ''; box.classList.add('hidden'); return; }
    const issues = await matterIssuesFor(currentMatterId);
    renderIssueList(box, issues, 'Check before filing:');
  }

  document.getElementById('btn-generate-pdf').onclick = () => handleGenerate('pdf');
  document.getElementById('btn-generate-docx').onclick = () => handleGenerate('docx');

  function handleGenerate(mode) {
    // Captured at the click, before anything waits: the user can switch
    // matters while a queued save or the folder-owner picker is pending.
    // gatherRenderData() reads the screen, so it is also read at the click.
    const matterId = currentMatterId;
    const gathered = gatherRenderData();
    return queueSave(async () => runGenerate(mode, matterId, await gathered));
  }

  async function runGenerate(mode, matterId, { matter, attorney, dt, fields }) {
    const blocks = dt.build(matter, attorney, fields); // Note: using attorney object now

    // A document row is self-contained: it carries the field values AND the
    // resolved matter/attorney state that actually produced the caption,
    // signature and body — so it can be reopened and reproduced exactly via
    // "Regenerate" (gatherRenderData()) no matter what the matter looks like
    // by then.
    const fieldData = JSON.stringify(fields);
    // output_dir is frozen onto matters as a side effect of the FIRST file a
    // matter ever generates (getMatterDir in main.js) — so generating Word
    // right after a matter's very first PDF would otherwise see a different
    // matter object than the PDF click did, purely from that bookkeeping
    // field flipping from null to a path, and wrongly treat it as changed
    // content. It doesn't affect what the document says, so it's excluded
    // here rather than chased with a special case.
    const { output_dir, ...matterForSnapshot } = matter;
    const matterSnapshot = JSON.stringify(matterForSnapshot);
    const attorneySnapshot = JSON.stringify(attorney || null);

    const result = await withFolderOwner(matterId, () => mode === 'pdf'
      ? appApi.generatePdf(window.DocumentEngine.renderHtml(blocks, matter, attorney), matter, dt.label, dt.id)
      : appApi.generateDocx(blocks, matter, attorney, dt.label, dt.id));

    // The documents row is written only once a file exists, so a cancelled
    // folder choice (or a failed save) never leaves a history entry pointing
    // at no file.
    if (result && result.path) {
      // Generating Word right after PDF (or vice versa) for the same field/
      // matter state fills in the second path on the same row instead of
      // creating a second, unlinked-looking history entry — the same "reuse
      // when nothing changed" idea main.js already applies to file versions,
      // just at the documents-row level.
      const prior = await appApi.dbGet(
        'SELECT * FROM documents WHERE matter_id = ? AND doc_type = ? ORDER BY created_at DESC LIMIT 1',
        [matterId, dt.id]);
      const sameAsPrior = prior
        && prior.field_data === fieldData
        && prior.matter_snapshot === matterSnapshot
        && prior.attorney_snapshot === attorneySnapshot;
      const missingThisFormat = prior && (mode === 'pdf' ? !prior.pdf_path : !prior.docx_path);

      let docId;
      if (sameAsPrior && missingThisFormat) {
        docId = prior.id;
      } else {
        const ins = await appApi.dbRun(
          `INSERT INTO documents (matter_id, doc_type, field_data, matter_snapshot, attorney_snapshot, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [matterId, dt.id, fieldData, matterSnapshot, attorneySnapshot, new Date().toISOString()]);
        docId = ins.lastInsertRowid;
      }
      // result.stored, not result.path: path columns hold the location
      // relative to the output root (main.js storePath), so a restored backup
      // on another computer still finds the file.
      const pathColumn = mode === 'pdf' ? 'pdf_path' : 'docx_path';
      await appApi.dbRun(
        `UPDATE documents SET ${pathColumn} = ?, updated_at = ? WHERE id = ?`,
        [result.stored, new Date().toISOString(), docId]);
    }

    if (currentMatterId === matterId) loadDocuments(matterId);
    showGenerateResult(result);
  }

  // ---- Letterheads ---------------------------------------------------------
  // The masthead, address and seal a letter or memorandum prints at the top of
  // the page. Stored data, never in the source: the app must not carry any one
  // municipality's branding.
  const LETTERHEAD_FIELDS = [
    ['label', 'Name (yours, not printed)', 'text'],
    ['masthead', 'Masthead (large, centered)', 'text'],
    ['office_lines', 'Office lines (one per line)', 'textarea'],
    ['address', 'Address (one per line)', 'textarea'],
    ['phone', 'Phone', 'text'],
    ['fax', 'Fax', 'text'],
    ['side_names', 'Names down the left (one per line)', 'textarea'],
  ];

  async function renderLetterheads() {
    const el = document.getElementById('letterheads-manage');
    if (!el) return;
    const rows = await appApi.dbAll('SELECT * FROM letterheads WHERE archived = 0 ORDER BY label COLLATE NOCASE');
    el.innerHTML = '';
    if (!rows.length) {
      const hint = document.createElement('div');
      hint.style.cssText = 'color:#666; font-size:0.9em;';
      hint.textContent = 'None yet. Letters and memoranda need one before they can be generated.';
      el.appendChild(hint);
    }
    rows.forEach(lh => {
      const box = document.createElement('div');
      box.style.cssText = 'border:1px solid #ccc; padding:8px; margin-bottom:8px;';
      LETTERHEAD_FIELDS.forEach(([key, label, kind]) => {
        const g = document.createElement('div');
        g.className = 'form-group';
        const lb = document.createElement('label');
        lb.textContent = label;
        const input = document.createElement(kind === 'textarea' ? 'textarea' : 'input');
        if (kind === 'textarea') input.rows = 2; else input.type = 'text';
        input.value = lh[key] || '';
        input.addEventListener('change', async () => {
          await appApi.dbRun(`UPDATE letterheads SET ${key} = ? WHERE id = ?`, [input.value, lh.id]);
        });
        g.append(lb, input);
        box.appendChild(g);
      });

      // City vs. personal (spec §09) are structurally different layouts, not
      // variants of one shape — masthead-centered-with-seal vs. name-at-left.
      const kindG = document.createElement('div');
      kindG.className = 'form-group';
      const kindL = document.createElement('label');
      kindL.textContent = 'Kind';
      const kindSel = document.createElement('select');
      [['city', 'City (masthead, seal, other attorneys down the left)'],
       ['personal', 'Personal (name at left, no seal)']]
        .forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; kindSel.appendChild(o); });
      kindSel.value = lh.kind || 'city';
      kindSel.addEventListener('change', async () => {
        await appApi.dbRun('UPDATE letterheads SET kind = ? WHERE id = ?', [kindSel.value, lh.id]);
      });
      kindG.append(kindL, kindSel);
      box.appendChild(kindG);

      // Reference initials separator. Deliberately differs between letterheads
      // (decision 9) — a colon on city letterhead, a slash on personal.
      const sepG = document.createElement('div');
      sepG.className = 'form-group';
      const sepL = document.createElement('label');
      sepL.textContent = 'Reference initials separator';
      const sep = document.createElement('select');
      [[':', 'Colon  —  ABC:de  (city letterhead)'], ['/', 'Slash  —  ABC/de  (personal letterhead)']]
        .forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sep.appendChild(o); });
      sep.value = lh.ref_separator || ':';
      sep.addEventListener('change', async () => {
        await appApi.dbRun('UPDATE letterheads SET ref_separator = ? WHERE id = ?', [sep.value, lh.id]);
      });
      sepG.append(sepL, sep);
      box.appendChild(sepG);

      // Typist initials — the second half of "ABC:de". Belongs to the
      // letterhead, same as the separator above. Empty prints just the
      // attorney initials, no separator, no dangling "ABC:".
      const typG = document.createElement('div');
      typG.className = 'form-group';
      const typL = document.createElement('label');
      typL.textContent = 'Typist initials';
      const typ = document.createElement('input');
      typ.type = 'text'; typ.placeholder = 'de';
      typ.value = lh.typist_initials || '';
      typ.addEventListener('change', async () => {
        await appApi.dbRun('UPDATE letterheads SET typist_initials = ? WHERE id = ?', [typ.value.trim(), lh.id]);
      });
      typG.append(typL, typ);
      box.appendChild(typG);

      const sealRow = document.createElement('div');
      sealRow.style.cssText = 'display:flex; gap:8px; align-items:center;';
      const sealBtn = document.createElement('button');
      sealBtn.className = 'btn'; sealBtn.type = 'button';
      sealBtn.textContent = lh.seal_image ? 'Replace Seal Image' : 'Add Seal Image';
      sealBtn.addEventListener('click', async () => {
        const res = await appApi.pickSignatureImage();
        if (res && res.dataUrl) {
          await appApi.dbRun('UPDATE letterheads SET seal_image = ? WHERE id = ?', [res.dataUrl, lh.id]);
          renderLetterheads();
        }
      });
      sealRow.appendChild(sealBtn);
      if (lh.seal_image) {
        const img = document.createElement('img');
        img.src = lh.seal_image; img.style.cssText = 'max-height:44px;';
        sealRow.appendChild(img);
        const clr = document.createElement('button');
        clr.className = 'btn'; clr.type = 'button'; clr.textContent = 'Remove Seal';
        clr.addEventListener('click', async () => {
          await appApi.dbRun('UPDATE letterheads SET seal_image = NULL WHERE id = ?', [lh.id]);
          renderLetterheads();
        });
        sealRow.appendChild(clr);
      }
      box.appendChild(sealRow);

      const arch = document.createElement('button');
      arch.className = 'btn'; arch.type = 'button'; arch.textContent = 'Archive';
      arch.style.marginTop = '6px';
      arch.addEventListener('click', async () => {
        await appApi.dbRun('UPDATE letterheads SET archived = 1 WHERE id = ?', [lh.id]);
        renderLetterheads();
      });
      box.appendChild(arch);
      el.appendChild(box);
    });
  }

  const addLhBtn = document.getElementById('btn-add-letterhead');
  if (addLhBtn) addLhBtn.addEventListener('click', async () => {
    await appApi.dbRun('INSERT INTO letterheads (label, ref_separator) VALUES (?,?)', ['New Letterhead', ':']);
    renderLetterheads();
  });

  // ---- Packets -------------------------------------------------------------
  // A packet is one filing: several documents, one date, one folder. Its
  // enclosure list and proof-of-service list are DERIVED from its contents.
  let currentPacketId = null;

  async function loadPackets(matterId) {
    const el = document.getElementById('packets-list');
    if (!el) return;
    el.innerHTML = '';
    if (!matterId) { el.textContent = 'Save matter first.'; return; }
    const rows = await appApi.dbAll(
      'SELECT * FROM packets WHERE matter_id = ? ORDER BY COALESCE(packet_date, created_at) DESC, id DESC', [matterId]);
    if (!rows.length) {
      const hint = document.createElement('div');
      hint.style.cssText = 'color:#666; font-size:0.9em;';
      hint.textContent = 'None yet.';
      el.appendChild(hint);
      return;
    }
    for (const p of rows) {
      const def = window.DocumentEngine.packets.find(d => d.id === p.kind);
      const row = document.createElement('div');
      row.style.cssText = 'border:1px solid #ddd; padding:6px; margin-bottom:6px; cursor:pointer;';
      const title = document.createElement('div');
      title.style.fontWeight = 'bold';
      title.textContent = p.label || (def ? def.label : p.kind);
      const meta = document.createElement('div');
      meta.style.cssText = 'font-size:0.85em; color:#666;';
      const n = await appApi.dbGet('SELECT COUNT(*) c FROM documents WHERE packet_id = ?', [p.id]);
      meta.textContent = `${p.packet_date || 'no date'} — ${n ? n.c : 0} document(s) generated`;
      row.append(title, meta);
      row.onclick = () => openPacket(p.id);
      el.appendChild(row);
    }
  }

  async function packetLetterheadOptions(selectedId) {
    const sel = document.getElementById('pk-letterhead_id');
    const rows = await appApi.dbAll('SELECT id, label FROM letterheads WHERE archived = 0 ORDER BY label COLLATE NOCASE');
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = rows.length ? '— Select —' : '— None set up (Settings → Letterheads) —';
    sel.appendChild(none);
    rows.forEach(r => {
      const o = document.createElement('option');
      o.value = r.id; o.textContent = r.label;
      sel.appendChild(o);
    });
    sel.value = selectedId || '';
  }

  function packetDef(kind) {
    return window.DocumentEngine.packets.find(d => d.id === kind) || window.DocumentEngine.packets[0];
  }

  // The intake form is declared by the packet definition, so adding a packet
  // type does not mean hand-writing another form.
  function renderPacketFields(def, values) {
    const host = document.getElementById('packet-fields');
    host.innerHTML = '';
    (def.fields || []).forEach(f => {
      const g = document.createElement('div');
      g.className = 'form-group';
      let input;
      if (f.type === 'checkbox') {
        g.style.cssText = 'flex-direction:row; align-items:center;';
        input = document.createElement('input');
        input.type = 'checkbox';
        input.id = `pkf_${f.id}`;
        input.checked = !!(values && values[f.id]);
        const lb = document.createElement('label');
        lb.htmlFor = input.id;
        lb.textContent = f.label;
        g.append(input, lb);
        host.appendChild(g);
        return; // checkbox layout differs enough to skip the shared label/help block below
      }
      const lb = document.createElement('label');
      lb.textContent = f.label;
      if (f.type === 'textarea') { input = document.createElement('textarea'); input.rows = 3; }
      else { input = document.createElement('input'); input.type = f.type === 'date' ? 'date' : 'text'; }
      input.id = `pkf_${f.id}`;
      if (f.placeholder) input.placeholder = f.placeholder;
      input.value = (values && values[f.id] != null && values[f.id] !== '')
        ? values[f.id]
        : (f.default || '');
      g.append(lb, input);
      host.appendChild(g); // withTodayButton (below) needs input attached first
      if (f.type === 'date') withTodayButton(input); // A8
      if (f.help) {
        const h = document.createElement('div');
        h.style.cssText = 'font-size:0.8em; color:#666; margin-top:2px;';
        h.textContent = f.help;
        g.appendChild(h);
      }
    });
  }

  function renderPacketContents(def) {
    const host = document.getElementById('packet-contents');
    host.innerHTML = '';
    (def.documents || []).forEach((d, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:8px; padding:4px 0; border-bottom:1px solid #eee;';
      const num = document.createElement('div');
      num.style.cssText = 'width:1.4em; color:#666;';
      num.textContent = `${i + 1}.`;
      const t = document.createElement('div');
      t.style.flex = '1';
      t.textContent = d.title;
      const role = document.createElement('div');
      role.style.cssText = 'font-size:0.8em; color:#666;';
      role.textContent = d.role;
      const previewLink = document.createElement('a');
      previewLink.href = '#';
      previewLink.textContent = 'Preview';
      previewLink.style.cssText = 'font-size:0.8em;';
      previewLink.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!currentPacketId) return;
        await savePacket();
        const p = await appApi.dbGet('SELECT * FROM packets WHERE id = ?', [currentPacketId]);
        const packetDefForPreview = packetDef(p.kind);
        const enclosures = window.DocumentEngine.packetEnclosures(packetDefForPreview);
        const { matter, attorney } = await gatherRenderData({
          skipDocType: true,
          includeSignature: document.getElementById('pk-include-signature').checked
        });
        matter.letterhead = p.letterhead_id
          ? await appApi.dbGet('SELECT * FROM letterheads WHERE id = ?', [p.letterhead_id])
          : null;
        const doc = await buildPacketDocument(p, packetDefForPreview, enclosures, matter, attorney, i);
        if (doc) await renderPreview(window.DocumentEngine.renderHtml(doc.blocks, doc.forDoc, attorney), 'packet-preview-panel', 'packet-preview-frame');
      });
      row.append(num, t, role, previewLink);
      host.appendChild(row);
    });
  }

  document.getElementById('btn-packet-preview-zoom-in').addEventListener('click', () => {
    previewZoom = Math.min(previewZoom + 0.1, 2);
    applyPreviewZoom('packet-preview-frame', 'packet-preview-zoom-label');
  });
  document.getElementById('btn-packet-preview-zoom-out').addEventListener('click', () => {
    previewZoom = Math.max(previewZoom - 0.1, 0.3);
    applyPreviewZoom('packet-preview-frame', 'packet-preview-zoom-label');
  });

  function packetFormValues() {
    const def = packetDef(document.getElementById('pk-kind').value);
    const out = {};
    (def.fields || []).forEach(f => {
      const el = document.getElementById(`pkf_${f.id}`);
      if (!el) return;
      out[f.id] = f.type === 'checkbox' ? el.checked : el.value;
    });
    return out;
  }

  async function openPacket(id) {
    const p = await appApi.dbGet('SELECT * FROM packets WHERE id = ?', [id]);
    if (!p) return;
    currentPacketId = id;

    // generatePacket() signs with whatever #gen-attorney holds, and that
    // select is shared with the Generate screen — so it may still hold the
    // profile picked on Generate for a DIFFERENT case (or nothing at all, for
    // a standalone letter or a fresh launch). Packets store no attorney of
    // their own, so recompute it every time a packet opens, with the same
    // precedence as Generate (preferredAttorneyId): the case's own attorney,
    // then an Organization client's signing profile, then the case type's,
    // then the default. Never carry a selection across cases.
    const selAtt = document.getElementById('gen-attorney');
    const atts = await appApi.dbAll('SELECT * FROM attorneys');
    const winner = await preferredAttorneyId(p.matter_id, atts);
    if (currentPacketId !== id) return;
    selAtt.innerHTML = '';
    atts.forEach(a => {
      const opt = new Option(a.label || a.firm_name || a.name, a.id);
      opt.selected = winner ? a.id === winner : !!a.is_default;
      selAtt.appendChild(opt);
    });

    const kindSel = document.getElementById('pk-kind');
    kindSel.innerHTML = '';
    window.DocumentEngine.packets.forEach(d => {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.label;
      kindSel.appendChild(o);
    });
    kindSel.value = p.kind;
    await packetLetterheadOptions(p.letterhead_id);
    const def = packetDef(p.kind);
    renderPacketFields(def, p);
    renderPacketContents(def);

    const bodySource = p.body_source === 'attached' ? 'attached' : 'typed';
    document.querySelector(`input[name="pk-body-source"][value="${bodySource}"]`).checked = true;
    attachedScanData = p.attached_scan_data
      ? { dataUri: p.attached_scan_data, extension: extFromDataUri(p.attached_scan_data) }
      : null;
    document.getElementById('pk-attach-filename').textContent =
      attachedScanData ? `Attached (.${attachedScanData.extension})` : '';
    updateBodySourceUI();
    await renderPacketClient(p);

    document.getElementById('packet-result').classList.add('hidden');
    await packetPreflight();
    showView('packet');
  }

  // A letter's Client, on its packet screen. It can be changed until the
  // letter is first generated; that freezes its folder (packets.output_dir),
  // and a folder never moves, so from then on the client is shown read-only.
  const packetClientPicker = setupClientPicker(
    document.getElementById('pk-client_name'),
    document.getElementById('pk-client_person_id'),
    document.querySelector('#combo-packet-client .combobox-dropdown'));

  async function renderPacketClient(p) {
    const frozenEl = document.getElementById('pk-client-frozen');
    const client = p.client_person_id
      ? await appApi.dbGet('SELECT id, display_name FROM people WHERE id = ?', [p.client_person_id])
      : null;
    if (currentPacketId !== p.id) return;
    const frozen = !!p.output_dir;
    packetClientPicker.set(client ? client.id : null, client ? client.display_name : '');
    document.getElementById('combo-packet-client').classList.toggle('hidden', frozen);
    frozenEl.classList.toggle('hidden', !frozen);
    frozenEl.textContent = frozen
      ? `${client ? client.display_name : 'None — General Letters'}. This letter's folder was `
        + 'set when it was first generated, so its client can no longer be changed.'
      : '';
  }

  async function refreshPacketClient(packetId) {
    const p = await appApi.dbGet('SELECT id, kind, client_person_id, output_dir FROM packets WHERE id = ?', [packetId]);
    if (p && currentPacketId === packetId) await renderPacketClient(p);
  }

  // The person record behind "our client" on a matter: the party on the
  // client's own side that is linked to a people row.
  //
  // Best-effort by design. parties.person_id is nullable — a party name can be
  // typed freehand, and parties.name is deliberately a snapshot — so this
  // returning null is a normal, expected state, not an error.
  async function clientPersonFor(matterId) {
    const m = await appApi.dbGet('SELECT client_role FROM matters WHERE id = ?', [matterId]);
    if (!m) return null;
    const side = m.client_role === 'plaintiff' ? 'plaintiff' : 'defendant';
    return await appApi.dbGet(
      `SELECT p.* FROM parties pa JOIN people p ON p.id = pa.person_id
       WHERE pa.matter_id = ? AND pa.side = ? AND pa.person_id IS NOT NULL
       ORDER BY pa.sort_order, pa.id LIMIT 1`, [matterId, side]);
  }

  const newPacketBtn = document.getElementById('btn-new-packet');
  if (newPacketBtn) newPacketBtn.addEventListener('click', async () => {
    if (!currentMatterId) return;
    const def = window.DocumentEngine.packets[0];
    // Seeded at creation, not at render: the packet takes its own copy the
    // moment it exists, exactly as a typed value would. Re-opening an existing
    // packet therefore never re-reads the person, so correcting the client
    // later cannot rewrite a filing that already went out.
    const client = await clientPersonFor(currentMatterId);
    const res = await appApi.dbRun(
      `INSERT INTO packets (matter_id, kind, label, packet_date, client_dob, client_license_number, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [currentMatterId, def.id, def.label, new Date().toISOString().slice(0, 10),
       client && usableIsoDate(client.dob) ? client.dob : null,
       (client && client.license_number) || null,
       new Date().toISOString()]);
    await openPacket(res.lastInsertRowid);
  });

  const backPacketBtn = document.getElementById('btn-back-from-packet');
  if (backPacketBtn) backPacketBtn.addEventListener('click', async () => {
    // Reload the matter form from the database before showing it.
    //
    // A packet can be reached WITHOUT the matter form ever being populated:
    // the person profile's Work Product panel sets currentMatterId straight
    // from the clicked row and calls openPacket, which never touches the
    // #mat-* inputs — only openMatter does. Landing on matter-detail without
    // this reload leaves whatever matter was last opened sitting in the form,
    // and Save Matter writes those stale values onto THIS matter's row: its
    // case number, its stage, and the caption note that prints the client's
    // charge on every filing. Silently, with no error.
    if (currentMatterId) {
      await openMatter(currentMatterId);
      loadPackets(currentMatterId);
      showView('matter-detail');
      return;
    }
    // A standalone letter has no matter. The matter form would be meaningless
    // here and dangerous for the same reason as above, so go back to where
    // standalone letters are reached from instead.
    showView('people');
    loadPeople();
  });

  async function savePacket() {
    if (!currentPacketId) return;
    const kind = document.getElementById('pk-kind').value;
    const def = packetDef(kind);
    const fieldIds = new Set((def.fields || []).map(f => f.id));
    const v = packetFormValues();

    const sets = ['kind=?', 'letterhead_id=?', 'packet_date=?', 'item_description=?',
      'court_recipient_name=?', 'court_recipient_address=?', 'memo_to=?',
      'hearing_type=?', 'client_dob=?', 'client_license_number=?', 'subject=?', 'letter_body=?',
      'confidential=?', 'cc_list=?'];
    const params = [kind, document.getElementById('pk-letterhead_id').value || null,
      v.packet_date || null, v.item_description || null,
      v.court_recipient_name || null, v.court_recipient_address || null,
      v.memo_to || null, v.hearing_type || null, v.client_dob || null,
      v.client_license_number || null, v.subject || null, v.letter_body || null,
      v.confidential ? 1 : 0, v.cc_list || null];

    // The label names the packet's folder and its row in the list. New Packet
    // seeds the first kind's label (Claim & Delivery), so when the kind is
    // changed on the form the label has to follow, or a driver-license packet
    // is filed under "… Claim & Delivery Response". Compared against the
    // stored kind (the UPDATE reads old values), so an unchanged kind keeps
    // whatever label it has.
    if (def && def.id === kind) {
      sets.push('label = CASE WHEN kind = ? THEN label ELSE ? END');
      params.push(kind, def.label);
    }

    // recipient_name/recipient_address are a frozen snapshot for standalone
    // letters — set once at creation from the chosen person, never exposed
    // as an editable field on that kind's form. Only overwrite them here
    // when the current kind actually declares them as editable (claim &
    // delivery, driver-license hearing); otherwise this blanket UPDATE would
    // null out the standalone letter's only copy of who it's addressed to.
    if (fieldIds.has('recipient_name') || fieldIds.has('recipient_address')) {
      sets.push('recipient_name=?', 'recipient_address=?');
      params.push(v.recipient_name || null, v.recipient_address || null);
    }

    // A letter's client decides its folder, so it can only change while the
    // folder is still unset — checked in the UPDATE itself, not on the screen.
    if (kind === 'standalone_letter') {
      const clientId = document.getElementById('pk-client_person_id').value;
      sets.push('client_person_id = CASE WHEN output_dir IS NULL THEN ? ELSE client_person_id END');
      params.push(clientId ? Number(clientId) : null);
    }

    const bodySource = (document.querySelector('input[name="pk-body-source"]:checked') || {}).value || 'typed';
    sets.push('body_source=?', 'attached_scan_data=?');
    params.push(bodySource, bodySource === 'attached' && attachedScanData ? attachedScanData.dataUri : null);

    params.push(currentPacketId);
    await appApi.dbRun(`UPDATE packets SET ${sets.join(', ')} WHERE id=?`, params);
  }

  const savePacketBtn = document.getElementById('btn-save-packet');
  if (savePacketBtn) savePacketBtn.addEventListener('click', async () => {
    await savePacket();
    await packetPreflight();
  });

  // attach-a-scan: the scan replaces a typed body entirely (Task 6/7 of the
  // City Attorney letter plan) — only standalone_letter offers the choice.
  let attachedScanData = null; // { dataUri, extension }

  function extFromDataUri(uri) {
    const m = /^data:([^;]+);/.exec(uri || '');
    if (!m) return '';
    if (m[1] === 'application/pdf') return 'pdf';
    if (m[1] === 'image/png') return 'png';
    return 'jpg';
  }

  function updateBodySourceUI() {
    const isLetter = document.getElementById('pk-kind').value === 'standalone_letter';
    const row = document.getElementById('pk-body-source-row');
    if (row) row.classList.toggle('hidden', !isLetter);
    document.getElementById('pk-client-row').classList.toggle('hidden', !isLetter);
    const checkedRadio = document.querySelector('input[name="pk-body-source"]:checked');
    const attached = isLetter && !!checkedRadio && checkedRadio.value === 'attached';
    const attachRow = document.getElementById('pk-attach-row');
    if (attachRow) attachRow.classList.toggle('hidden', !attached);
    ['pkf_subject', 'pkf_letter_body', 'pkf_cc_list', 'pkf_confidential'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.closest('.form-group').classList.toggle('hidden', attached);
    });

    // Nothing to convert to Word in this mode, and an inert button is worse
    // than none — hide it rather than leave it clickable with no effect.
    const pdfBtn = document.getElementById('btn-generate-packet-pdf');
    const docxBtn = document.getElementById('btn-generate-packet-docx');
    if (pdfBtn) pdfBtn.textContent = attached ? 'Save Attached Letter' : 'Generate Packet (PDF)';
    if (docxBtn) docxBtn.classList.toggle('hidden', attached);
  }

  document.querySelectorAll('input[name="pk-body-source"]').forEach(r => {
    r.addEventListener('change', updateBodySourceUI);
  });

  const pickScanBtn = document.getElementById('btn-pick-letter-scan');
  if (pickScanBtn) pickScanBtn.addEventListener('click', async () => {
    const res = await appApi.pickLetterScan();
    const note = document.getElementById('pk-attach-note');
    if (res.error) { if (note) note.textContent = res.error; return; }
    if (note) note.textContent = '';
    if (!res.canceled) {
      attachedScanData = { dataUri: res.dataUri, extension: res.extension };
      document.getElementById('pk-attach-filename').textContent = `Attached (.${res.extension})`;
    }
  });

  const pkKind = document.getElementById('pk-kind');
  if (pkKind) pkKind.addEventListener('change', () => {
    const def = packetDef(pkKind.value);
    renderPacketFields(def, packetFormValues());
    renderPacketContents(def);
    document.querySelector('input[name="pk-body-source"][value="typed"]').checked = true;
    attachedScanData = null;
    document.getElementById('pk-attach-filename').textContent = '';
    updateBodySourceUI();
  });

  // Same idea as the document preflight: say what will be blank BEFORE it is
  // printed and filed, without blocking. Field-specific checks are gated on
  // whether the current packet kind actually declares that field — the
  // driver-license packet has no item_description, and the claim & delivery
  // packet has no hearing_type, so a check for one must not fire for the
  // other's kind.
  async function packetPreflight() {
    const box = document.getElementById('packet-warnings');
    box.innerHTML = '';
    if (!currentPacketId) { box.classList.add('hidden'); return; }
    const def = packetDef(document.getElementById('pk-kind').value);
    const fieldIds = new Set((def.fields || []).map(f => f.id));
    const v = packetFormValues();
    const problems = [];
    if (!document.getElementById('pk-letterhead_id').value) {
      problems.push('No letterhead selected — the letter (and memorandum, if this packet has one) will print "[NO LETTERHEAD SELECTED]". Set one up in Settings → Letterheads.');
    }
    if (fieldIds.has('item_description') && (!v.item_description || !v.item_description.trim())) {
      problems.push('No item described — the memo and both answers will print "[NO ITEM DESCRIBED]".');
    }
    if (!v.packet_date) problems.push('No filing date — the letter and every document that carries it will print a blank.');
    if (!v.recipient_name) problems.push('No recipient name — the letter has nobody to address.');
    if (fieldIds.has('hearing_type') && (!v.hearing_type || !v.hearing_type.trim())) {
      problems.push('No hearing type — the letter and the Appearance both print it.');
    }
    if (fieldIds.has('client_dob') && !v.client_dob) {
      problems.push('No client date of birth — the Appearance\'s IN RE: block prints it.');
    }
    if (fieldIds.has('client_license_number') && (!v.client_license_number || !v.client_license_number.trim())) {
      problems.push('No driver license number — the letter and the Appearance both print it.');
    }
    if (def.requiresCaseNumber !== false) {
      const m = await appApi.dbGet('SELECT case_number, court_id FROM matters WHERE id = ?', [currentMatterId]);
      if (m && !m.case_number) problems.push('The matter has no case number — it prints in the letter, the memo and every caption.');
    }
    if (!problems.length) { box.classList.add('hidden'); return; }
    const title = document.createElement('div');
    title.style.fontWeight = 'bold';
    title.textContent = 'Check before filing:';
    box.appendChild(title);
    const ul = document.createElement('ul');
    ul.style.margin = '4px 0 0 18px';
    problems.forEach(t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
    box.appendChild(ul);
    box.classList.remove('hidden');
  }

  let lastPacketDir = null;

  // Shared by generatePacket() (writes files) and the packet preview (renders
  // only). Must stay in sync with generatePacket()'s own loop body.
  async function buildPacketDocument(p, def, enclosures, matter, attorney, i) {
    const spec = def.documents[i];
    const dt = window.DocumentEngine.doctypes.find(d => d.id === spec.doc_type);
    if (!dt) return null;
    const fields = { packet: p, enclosures, spec };
    // The packet identity travels on the matter object so main.js can freeze
    // the packet folder and key the reuse check per packet.
    const forDoc = { ...matter, packet: { id: p.id, kind: p.kind, label: p.label,
      packet_date: p.packet_date, sort_order: i, recipient_name: p.recipient_name,
      subject: fields.packet.subject } };
    const blocks = dt.build(forDoc, attorney, fields);
    return { dt, fields, forDoc, blocks, spec };
  }

  // Generate every document in the packet, in order, into one folder.
  function generatePacket(mode) {
    if (!currentPacketId) return;
    // Captured at the click, before anything waits: the folder-owner picker
    // or a queued save can sit pending while the user moves elsewhere.
    const matterId = currentMatterId;
    const packetId = currentPacketId;
    // The form is saved and read at the click too — both read the screen,
    // which may show another packet by the time a queued save runs.
    const includeSignature = document.getElementById('pk-include-signature').checked;
    const prepared = savePacket().then(() => gatherRenderData({ skipDocType: true, includeSignature }));
    return queueSave(async () => {
      await runGeneratePacket(mode, matterId, packetId, await prepared);
      // The first generate freezes a letter's folder; show its client as fixed.
      await refreshPacketClient(packetId);
    });
  }

  async function runGeneratePacket(mode, matterId, packetId, { matter, attorney }) {
    const p = await appApi.dbGet('SELECT * FROM packets WHERE id = ?', [packetId]);
    const def = packetDef(p.kind);
    const enclosures = window.DocumentEngine.packetEnclosures(def);

    matter.letterhead = p.letterhead_id
      ? await appApi.dbGet('SELECT * FROM letterheads WHERE id = ?', [p.letterhead_id])
      : null;
    // The proof of service prints COUNTY OF [X]; it comes from the court.
    if (matter.court_id) {
      const c = await appApi.dbGet('SELECT county FROM courts WHERE id = ?', [matter.court_id]);
      if (c) matter.court_county = c.county || '';
    }

    // attach-a-scan: the letter already exists outside the app — copy its
    // stored bytes to the packet's output folder instead of building blocks
    // and calling renderHtml()/generateDocx() for this document.
    if (p.body_source === 'attached') {
      const box = document.getElementById('packet-result');
      if (!p.attached_scan_data) {
        document.getElementById('packet-result-text').textContent =
          'No file is attached yet — use "Attach File…" first.';
        box.classList.remove('hidden');
        return;
      }
      const spec = def.documents[0];
      const fileLabel = spec.file_label || spec.title;
      const forDoc = { ...matter, packet: { id: p.id, kind: p.kind, label: p.label,
        packet_date: p.packet_date, sort_order: 0, recipient_name: p.recipient_name,
        subject: p.subject } };
      const { output_dir, ...matterForSnapshot } = forDoc;
      const res = await withFolderOwner(matterId, () =>
        appApi.saveAttachedFile(p.attached_scan_data, forDoc, fileLabel, spec.doc_type));
      if (res && res.needsFolderOwner) {
        document.getElementById('packet-result-text').textContent = folderOwnerMessage(res);
      } else if (res && res.path) {
        // The row is written only once the file exists: a cancelled folder
        // choice leaves no history entry pointing at nothing.
        // Stored under pdf_path regardless of the attached file's actual
        // extension (pdf/png/jpg) — that's the column the documents list
        // already opens/shows-in-folder from, and there is only ever one
        // output file for an attached letter, never a separate PDF and Word
        // pair the way a rendered document can have.
        await appApi.dbRun(
          `INSERT INTO documents (matter_id, packet_id, sort_order, doc_type, field_data,
             matter_snapshot, attorney_snapshot, pdf_path, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [matterId, p.id, 0, spec.doc_type, JSON.stringify({ packet: p, attached: true }),
           JSON.stringify(matterForSnapshot), JSON.stringify(attorney || null),
           res.stored, new Date().toISOString(), new Date().toISOString()]);
        document.getElementById('packet-result-text').textContent = `Attached letter saved:\n${res.path}`;
        lastPacketDir = res.path;
        await logActivity('packet_generated', `Generated packet: ${p.label || def.label}`, { matterId });
      } else {
        document.getElementById('packet-result-text').textContent =
          (res && res.error) || 'Failed to save the attached file.';
      }
      box.classList.remove('hidden');
      if (currentMatterId === matterId) {
        await loadPackets(matterId);
        loadDocuments(matterId);
      }
      return;
    }

    const written = [];
    let refused = null;
    for (let i = 0; i < def.documents.length; i++) {
      const doc = await buildPacketDocument(p, def, enclosures, matter, attorney, i);
      if (!doc) continue;
      const { dt, fields, forDoc, blocks, spec } = doc;

      const { output_dir, ...matterForSnapshot } = forDoc;

      // file_label, not title: the filename must stay short (Windows path
      // limit) and free of apostrophes. The full legal title still prints
      // inside the documents that list it.
      const fileLabel = spec.file_label || spec.title;
      // Every document in the packet shares the one case folder, and the
      // first save freezes it — so the folder-owner question can only come
      // up on the first document, and is asked at most once per packet.
      const res = await withFolderOwner(matterId, () => mode === 'pdf'
        ? appApi.generatePdf(window.DocumentEngine.renderHtml(blocks, forDoc, attorney), forDoc, fileLabel, dt.id)
        : appApi.generateDocx(blocks, forDoc, attorney, fileLabel, dt.id));

      // Cancelled: nothing was written, and if the first document cannot be
      // placed none can. Stop. The same for a refusal (the documents folder
      // is not available): every later document would be refused too.
      if (res && (res.needsFolderOwner || res.error)) {
        refused = res;
        break;
      }

      // The row is written only once the file exists.
      if (res && res.path) {
        await appApi.dbRun(
          `INSERT INTO documents (matter_id, packet_id, sort_order, doc_type, field_data,
             matter_snapshot, attorney_snapshot, ${mode === 'pdf' ? 'pdf_path' : 'docx_path'}, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [matterId, p.id, i, dt.id, JSON.stringify(fields),
           JSON.stringify(matterForSnapshot), JSON.stringify(attorney || null),
           res.stored, new Date().toISOString(), new Date().toISOString()]);
        written.push(res.path);
        lastPacketDir = res.path;
      }
    }

    const box = document.getElementById('packet-result');
    document.getElementById('packet-result-text').textContent = refused
      ? (refused.error ? `${refused.error}${written.length ? `\n\n${written.length} document(s) written before that:\n` + written.join('\n') : ''}`
        : folderOwnerMessage(refused))
      : `${written.length} document(s) written:\n` + written.join('\n');
    if (refused && refused.error) refreshRootBanner();
    box.classList.remove('hidden');
    if (written.length) {
      await logActivity('packet_generated',
        `Generated packet: ${p.label || def.label} (${written.length} document(s))`, { matterId });
    }
    if (currentMatterId === matterId) {
      await loadPackets(matterId);
      loadDocuments(matterId);
    }
  }

  const genPkPdf = document.getElementById('btn-generate-packet-pdf');
  if (genPkPdf) genPkPdf.addEventListener('click', () => generatePacket('pdf'));
  const genPkDocx = document.getElementById('btn-generate-packet-docx');
  if (genPkDocx) genPkDocx.addEventListener('click', () => generatePacket('docx'));
  const openPkFolder = document.getElementById('btn-open-packet-folder');
  if (openPkFolder) openPkFolder.addEventListener('click', async () => {
    if (!lastPacketDir) return;
    const res = await appApi.showInFolder(lastPacketDir);
    if (!res.ok) alert(res.error);
  });
  // A8: the fixed, always-in-the-DOM date fields. Dynamically built ones
  // (court dates, payments, priors, packet fields, ...) call withTodayButton
  // themselves, at the point each row is created. per-dob is deliberately
  // left out — nobody's date of birth is today.
  ['per-intake_date', 'mat-date_of_offense'].forEach(id => {
    const el = document.getElementById(id);
    if (el) withTodayButton(el);
  });

  // The documents folder is not available (an unplugged or network drive, a
  // backup restored before its Legal Documents folder was copied across).
  // Main never switches folders by itself, so this stays on screen, in the
  // page, for as long as it is true — re-asked on startup, whenever the window
  // regains focus (the drive may have been plugged back in) and after any
  // refused save — and clears itself once the folder is back.
  document.getElementById('startup-notice-settings').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('nav-settings').click();
  });
  window.addEventListener('focus', () => { refreshRootBanner(); });
  refreshRootBanner();

  // Version in the corner, so a bug report can say which build it came from.
  (async function showAppVersion() {
    const el = document.getElementById('app-version');
    if (!el || !appApi.appVersion) return;
    try { el.textContent = 'v' + await appApi.appVersion(); } catch { /* cosmetic only */ }
  })();

  // App zoom: the magnifiers either side of the percentage step through
  // main.js ZOOM_STEPS; the percentage itself goes back to 100%. Main does the
  // zooming and remembers it for this computer; this only draws the controls.
  (async function setupAppZoom() {
    const out = document.getElementById('btn-zoom-out');
    const inn = document.getElementById('btn-zoom-in');
    const level = document.getElementById('zoom-level');
    if (!out || !inn || !level || !appApi.getZoom) return;
    let steps = [0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
    let factor = 1;
    const paint = (f) => {
      factor = f;
      level.textContent = `${Math.round(f * 100)}%`;
      // aria-disabled, not disabled: the ends still take focus and say why
      // nothing happens, and the look matches the other disabled buttons.
      out.setAttribute('aria-disabled', String(f <= steps[0]));
      inn.setAttribute('aria-disabled', String(f >= steps[steps.length - 1]));
    };
    const go = async (f) => { try { paint(await appApi.setZoom(f)); } catch { /* stays as it was */ } };
    const step = (dir) => {
      const i = steps.indexOf(factor);
      const next = steps[i + dir];
      if (i !== -1 && next !== undefined) go(next);
    };
    out.addEventListener('click', () => step(-1));
    inn.addEventListener('click', () => step(1));
    level.addEventListener('click', () => go(1));
    appApi.onZoomChanged(paint);
    try {
      const z = await appApi.getZoom();
      steps = z.steps;
      paint(z.factor);
    } catch { /* the controls stay at 100% */ }
  })();

  // ---- Global search -------------------------------------------------------
  // One box over the three things worth jumping to: a client, a matter, or a
  // case number. Case numbers are searched in matter_cases as well as on the
  // matter itself, because an appeal carries the case below and that number is
  // often the one the user remembers.
  //
  // Plain LIKE, no index and no full-text: at this scale (hundreds of rows in
  // a local SQLite file) it is the correct amount of machinery. Document
  // CONTENTS are deliberately out of scope.
  (function setupGlobalSearch() {
    const input = document.getElementById('global-search');
    const box = document.getElementById('global-search-results');
    const caret = document.getElementById('global-search-caret');
    const menu = document.getElementById('global-search-menu');
    const archivedToggle = document.getElementById('global-search-archived');
    if (!input || !box) return;

    let timer = null;
    let firstHit = null;

    const close = () => { box.classList.add('hidden'); box.innerHTML = ''; firstHit = null; };

    // % and _ are wildcards; a case number legitimately contains neither, but
    // a typed one may, and an unescaped _ silently matches any character.
    const escapeLike = (t) => t.replace(/[\\%_]/g, c => '\\' + c);

    caret.addEventListener('mousedown', (e) => {
      e.preventDefault(); // don't blur the search input
      menu.classList.toggle('hidden');
    });
    // Same reasoning as the result items below: without this, clicking the
    // checkbox blurs #global-search first, which closes the menu out from
    // under the click. preventDefault on mousedown blocks the focus shift;
    // the checkbox still toggles normally on the click that follows.
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    // The input's blur (below) only closes the menu when the input had focus.
    // Opened from the caret with the box empty and unfocused, nothing ever
    // closed it: it stayed open over whatever screen came next. So close it
    // on any press outside the menu and caret, and on Escape anywhere.
    // (showView closes it on navigation.)
    document.addEventListener('mousedown', (e) => {
      if (!menu.contains(e.target) && e.target !== caret) menu.classList.add('hidden');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') menu.classList.add('hidden');
    });
    archivedToggle.addEventListener('change', () => { if (input.value.trim().length >= 2) run(); });

    async function fetchGroup(archived) {
      const term = input.value.trim();
      const like = `%${escapeLike(term)}%`;

      const people = await appApi.dbAll(
        `SELECT id, display_name, is_contact FROM people
         WHERE archived = ? AND display_name LIKE ? ESCAPE '\\'
         ORDER BY display_name COLLATE NOCASE LIMIT 20`, [archived ? 1 : 0, like]);

      const direct = await appApi.dbAll(
        `SELECT id, short_name, case_number FROM matters
         WHERE archived = ? AND (short_name LIKE ? ESCAPE '\\' OR case_number LIKE ? ESCAPE '\\')
         ORDER BY created_at DESC LIMIT 20`, [archived ? 1 : 0, like, like]);

      const viaCases = await appApi.dbAll(
        `SELECT DISTINCT m.id, m.short_name, m.case_number
         FROM matter_cases mc JOIN matters m ON m.id = mc.matter_id
         WHERE m.archived = ? AND mc.case_number LIKE ? ESCAPE '\\'
         ORDER BY m.created_at DESC LIMIT 20`, [archived ? 1 : 0, like]);

      const seen = new Set(direct.map(m => m.id));
      const matters = [...direct, ...viaCases.filter(m => !seen.has(m.id))];
      // Contacts (judges, clerks, opposing counsel) are their own group and
      // open on the contact page.
      return { people: people.filter(p => !p.is_contact), contacts: people.filter(p => p.is_contact), matters };
    }

    async function run() {
      const term = input.value.trim();
      if (term.length < 2) { close(); return; }

      const active = await fetchGroup(false);
      const archived = archivedToggle.checked ? await fetchGroup(true) : { people: [], contacts: [], matters: [] };

      render(active, archived);
    }

    function render(active, archived) {
      box.innerHTML = '';
      firstHit = null;
      if (![active, archived].some(g => g.people.length || g.contacts.length || g.matters.length)) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:8px 10px; color:#666;';
        empty.textContent = 'No matches.';
        box.appendChild(empty);
        box.classList.remove('hidden');
        return;
      }

      const group = (label, rows, onPick, labelOf, isArchived) => {
        if (!rows.length) return;
        const h = document.createElement('div');
        h.style.cssText = 'padding:4px 10px; background:#eee; font-weight:bold; font-size:0.85em;';
        h.textContent = isArchived ? `${label} (archived)` : label;
        box.appendChild(h);
        rows.forEach(r => {
          const item = document.createElement('div');
          item.className = isArchived ? 'search-result-archived' : '';
          item.style.cssText = 'padding:5px 10px; cursor:pointer;';
          // textContent, not innerHTML: these are client names and case numbers.
          item.textContent = labelOf(r);
          item.addEventListener('mouseenter', () => { item.style.background = '#e6f0ff'; });
          item.addEventListener('mouseleave', () => { item.style.background = ''; });
          // mousedown, not click: blur fires first and would close the box out
          // from under the click.
          item.addEventListener('mousedown', (e) => { e.preventDefault(); onPick(r); });
          box.appendChild(item);
          if (!firstHit) firstHit = () => onPick(r);
        });
      };

      // openPerson/openMatter each switch to their own view already.
      const openPersonHit = (r) => { close(); input.value = ''; openPerson(r.id); };
      const openMatterHit = (r) => { close(); input.value = ''; openMatter(r.id); };
      const openContactHit = (r) => { close(); input.value = ''; openContact(r.id); };
      const personLabel = (r) => r.display_name;
      const matterLabel = (r) => r.case_number ? `${r.short_name} — ${r.case_number}` : r.short_name;

      group('Clients', active.people, openPersonHit, personLabel, false);
      group('Contacts', active.contacts, openContactHit, personLabel, false);
      group('Matters', active.matters, openMatterHit, matterLabel, false);
      // Archived matches render below the active ones, visually marked.
      group('Clients', archived.people, openPersonHit, personLabel, true);
      group('Contacts', archived.contacts, openContactHit, personLabel, true);
      group('Matters', archived.matters, openMatterHit, matterLabel, true);

      box.classList.remove('hidden');
    }

    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 180); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); input.blur(); }
      if (e.key === 'Enter' && firstHit) { e.preventDefault(); firstHit(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { close(); menu.classList.add('hidden'); }, 150));
  })();
});