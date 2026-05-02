/* people.js — unified lab people page.
 *
 * SINGLE source of truth: Firestore `users/{uid}` (the website's canonical
 * user collection). RM adds lab-management fields directly on those docs
 * (appointment, effort_pct, primary_funding, start, end, notes); the
 * website's existing fields (name, email, role, category, photo, bio) are
 * unchanged. A simple filter bar replaces the old Roster / Alumni / Website
 * tabs — alumni are just users with category=='alumni'.
 *
 * Admin promotes/demotes via the Role button (writes role + category to
 * users/{uid} — admin-only per firestore.rules).
 *
 * Legacy `people/{id}` Firestore collection (migrated from
 * data/people/roster.json + alumni.json) is kept as a backfill source: the
 * "Backfill from roster" button (admin-only) walks the legacy collection
 * and merges lab-management fields onto matching users/{uid} by email.
 */

const LAB_FIELDS = [
  { key: 'category', label: 'Category', type: 'select',
    options: ['pi', 'postdoc', 'grad', 'undergrad', 'highschool', 'alumni'], required: true },
  { key: 'appointment', label: 'Appointment / Position', type: 'text',
    placeholder: 'e.g. PhD Student, 9-month faculty, Postdoc Co-PI' },
  { key: 'effort_pct', label: 'Effort %', type: 'number' },
  { key: 'primary_funding', label: 'Primary Funding', type: 'text',
    placeholder: 'e.g. hard-money, prostate-gels-r01' },
  { key: 'start', label: 'Start Date', type: 'date' },
  { key: 'end', label: 'End Date', type: 'date' },
  { key: 'notes', label: 'Notes', type: 'textarea' },
];

const PEOPLE_CAT_LABEL = {
  pi: 'PI', postdoc: 'Postdoc', grad: 'Grad', undergrad: 'Undergrad',
  highschool: 'High School', alumni: 'Alumni', guest: 'Guest',
};
const PEOPLE_CAT_ORDER = ['pi', 'postdoc', 'grad', 'undergrad', 'highschool', 'alumni', 'guest'];
const ROLE_OPTIONS = ['admin', 'editor', 'contributor', 'guest'];

let activeCategoryFilter = 'all';
let _searchQuery = '';
let _users = [];
let _liveUnsub = null;

async function loadAndRender() {
  if (typeof firebridge === 'undefined' || !firebridge.isReady()) {
    const c = document.getElementById('content');
    if (c) c.innerHTML =
      '<div class="empty-state">' +
        '<p>Not signed in.</p>' +
        '<p style="margin-top:8px"><a href="/rm/index.html">Go home</a> to sign in first.</p>' +
      '</div>';
    return;
  }
  try {
    const _d = await api.load('lab/users.json');
    _users = (_d && _d.users) || [];
  } catch (err) {
    document.getElementById('content').innerHTML =
      '<div class="empty-state" style="color:var(--red);">Error loading users: ' + err.message + '</div>';
    return;
  }
  render();
}

function render() {
  // Filter bar (categories + search)
  const tabs = document.getElementById('tabs');
  if (tabs) {
    tabs.innerHTML = '';
    const counts = { all: _users.filter(u => u.role !== 'guest').length };
    PEOPLE_CAT_ORDER.forEach(c => { counts[c] = _users.filter(u => u.category === c).length; });
    const make = (key, label) => {
      const btn = document.createElement('button');
      btn.className = 'tab-btn' + (activeCategoryFilter === key ? ' active' : '');
      btn.textContent = label + ' (' + (counts[key] || 0) + ')';
      btn.onclick = () => { activeCategoryFilter = key; render(); };
      tabs.appendChild(btn);
    };
    make('all', 'All');
    PEOPLE_CAT_ORDER.forEach(c => {
      if ((counts[c] || 0) > 0 || c === 'guest') make(c, PEOPLE_CAT_LABEL[c]);
    });
  }

  // Filter
  let list = _users.slice();
  if (activeCategoryFilter !== 'all') {
    list = list.filter(u => u.category === activeCategoryFilter);
  } else {
    list = list.filter(u => u.role !== 'guest');
  }
  if (_searchQuery) {
    const q = _searchQuery.toLowerCase();
    list = list.filter(u =>
      (u.name || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q) ||
      (u.appointment || '').toLowerCase().includes(q) ||
      (u.primary_funding || '').toLowerCase().includes(q)
    );
  }
  // Sort by category order then name
  list.sort((a, b) => {
    const oa = PEOPLE_CAT_ORDER.indexOf(a.category || 'guest');
    const ob = PEOPLE_CAT_ORDER.indexOf(b.category || 'guest');
    return (oa - ob) || (a.name || '').localeCompare(b.name || '');
  });

  const content = document.getElementById('content');
  if (!list.length) {
    content.innerHTML =
      '<div class="empty-state">No matching members. ' +
      '<button class="btn" onclick="openInviteForm()">+ Invite</button></div>';
    _wireSearchBox();
    return;
  }

  let html =
    '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;">' +
      '<input type="search" id="ppl-search" placeholder="Search name, email, appointment, funding…" ' +
        'value="' + _esc(_searchQuery) + '" ' +
        'style="flex:1;padding:6px 10px;border:1px solid var(--border,#d1d5db);border-radius:6px;font-size:14px;">' +
      (firebridge.isAdmin() ? '<button class="btn" onclick="backfillRosterToUsers()" title="Merge legacy people/roster + alumni JSON into users/{uid} by email">Backfill from roster</button>' : '') +
    '</div>';

  html += '<table class="data-table"><thead><tr>' +
    '<th>Name</th>' +
    '<th>Category</th>' +
    '<th>Appointment</th>' +
    '<th>Effort</th>' +
    '<th>Funding</th>' +
    '<th>Start</th>' +
    '<th>Status</th>' +
    '<th>Actions</th>' +
    '</tr></thead><tbody>';
  list.forEach(u => {
    const photo = (u.photo && (u.photo.thumb || u.photo.medium))
      ? '<img src="' + _esc(u.photo.thumb || u.photo.medium) + '" alt="" ' +
        'style="width:28px;height:28px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:6px;">'
      : '<span style="display:inline-block;width:28px;height:28px;border-radius:50%;background:#e5e7eb;text-align:center;line-height:28px;font-size:11px;color:#6b7280;margin-right:6px;vertical-align:middle;">' +
        _esc((u.name || '?').slice(0, 1).toUpperCase()) + '</span>';
    const cat = u.category || 'guest';
    const status = (u.end && u.end !== '' && u.end !== 'TBD' && u.end < _todayStr())
      ? '<span class="chip chip-muted">ended</span>'
      : (u.role === 'guest'
        ? '<span class="chip chip-amber">pending</span>'
        : '<span class="chip chip-green">active</span>');
    const isAdmin = firebridge.isAdmin();
    html += '<tr>' +
      '<td>' + photo + '<strong>' + _esc(u.name || '(no name)') + '</strong>' +
        (u.email ? '<br><small style="color:var(--text-muted);">' + _esc(u.email) + '</small>' : '') + '</td>' +
      '<td><span class="chip">' + _esc(PEOPLE_CAT_LABEL[cat] || cat) + '</span></td>' +
      '<td>' + _esc(u.appointment || '') + '</td>' +
      '<td>' + (u.effort_pct != null ? u.effort_pct + '%' : '') + '</td>' +
      '<td>' + _esc(u.primary_funding || '') + '</td>' +
      '<td>' + (u.start ? formatDate(u.start) : '') + '</td>' +
      '<td>' + status + '</td>' +
      '<td class="row-actions">' +
        (isAdmin ? '<button onclick="editLabFields(\'' + _esc(u.id) + '\')">Edit</button>' : '') +
        (isAdmin ? '<button onclick="changeRole(\'' + _esc(u.id) + '\',\'' + _esc(u.role || '') + '\',\'' + _esc(u.category || '') + '\')">Role</button>' : '') +
      '</td></tr>';
  });
  html += '</tbody></table>';

  content.innerHTML = html;
  _wireSearchBox();
}

function _wireSearchBox() {
  const box = document.getElementById('ppl-search');
  if (!box) return;
  let t;
  box.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      _searchQuery = box.value.trim();
      render();
      // Re-focus + restore caret since render() rewrites the DOM.
      const fresh = document.getElementById('ppl-search');
      if (fresh) { fresh.focus(); fresh.setSelectionRange(_searchQuery.length, _searchQuery.length); }
    }, 120);
  });
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function _todayStr() { return new Date().toISOString().slice(0, 10); }

/* ---- Edit lab-management fields (admin only) ---- */

window.editLabFields = function (uid) {
  const u = _users.find(x => x.id === uid);
  if (!u) return;
  // Pre-fill form values from existing user doc.
  const initial = {
    category: u.category || 'grad',
    appointment: u.appointment || '',
    effort_pct: u.effort_pct,
    primary_funding: u.primary_funding || '',
    start: u.start || '',
    end: u.end || '',
    notes: u.notes || '',
  };
  openForm({
    title: 'Edit Lab Profile — ' + (u.name || u.email || uid),
    fields: LAB_FIELDS,
    values: initial,
    onSave: async function (vals) {
      const update = {
        category: vals.category,
        appointment: vals.appointment || '',
        effort_pct: vals.effort_pct == null ? null : Number(vals.effort_pct),
        primary_funding: vals.primary_funding || '',
        start: vals.start || '',
        end: vals.end || '',
        notes: vals.notes || '',
      };
      // Optimistic: mutate local + render NOW; save in background.
      Object.assign(u, update);
      render();
      try {
        await firebridge.updateDoc('users', uid, update);
      } catch (err) {
        console.error('[people] editLabFields save failed:', err);
        alert('Save failed: ' + err.message);
      }
    },
  });
};

/* ---- Change role/category (admin only) ---- */

window.changeRole = function (uid, currentRole, currentCategory) {
  const u = _users.find(x => x.id === uid);
  openForm({
    title: 'Change Role & Category — ' + (u && u.name || uid),
    fields: [
      { key: 'role', label: 'Role (access tier)', type: 'select', options: ROLE_OPTIONS, required: true },
      { key: 'category', label: 'Category (lab tier)', type: 'select',
        options: ['pi', 'postdoc', 'grad', 'undergrad', 'highschool', 'alumni', 'guest'], required: true },
    ],
    values: { role: currentRole || 'contributor', category: currentCategory || 'grad' },
    onSave: async function (vals) {
      if (u) { u.role = vals.role; u.category = vals.category; render(); }
      try {
        await firebridge.updateDoc('users', uid, { role: vals.role, category: vals.category });
      } catch (err) {
        console.error('[people] changeRole save failed:', err);
        alert('Role update failed: ' + err.message);
      }
    },
  });
};

/* ---- Invite a new member ---- */

window.openInviteForm = function () {
  openForm({
    title: 'Send Invitation',
    fields: [
      { key: 'category', label: 'Category', type: 'select',
        options: ['pi', 'postdoc', 'grad', 'undergrad', 'highschool'], required: true },
      { key: 'note', label: 'Note (optional)', type: 'text',
        placeholder: 'e.g. New PhD student starting Fall 2026' },
    ],
    values: { category: 'grad' },
    onSave: async function (vals) {
      const token = 'inv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      await firebridge.setDoc('invitations', token, {
        category: vals.category,
        note: vals.note || '',
        used: false,
        createdBy: firebridge.getUser().uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, false);
      alert('Invitation created!\n\nToken: ' + token +
        '\n\nShare this link with the new member:\n' +
        'https://mcgheelab.com/#/login?token=' + token);
    },
  });
};

/* ---- One-time backfill: legacy people/{id} → users/{uid} by email ---- */

window.backfillRosterToUsers = async function () {
  if (!firebridge.isAdmin()) { alert('Admin only.'); return; }
  if (!confirm(
    'This walks the legacy people/{id} Firestore collection and merges any ' +
    'matching members (by email) into the corresponding users/{uid} doc. ' +
    'Existing users/{uid} fields are preserved unless empty. Run once.'
  )) return;
  let merged = 0, orphans = [];
  try {
    const peopleSnap = await firebridge.collection('people').get();
    const users = await firebridge.getAll('users');
    const byEmail = {};
    users.forEach(u => { if (u.email) byEmail[u.email.toLowerCase().trim()] = u; });
    for (const doc of peopleSnap.docs) {
      const p = doc.data();
      const email = (p.email || '').toLowerCase().trim();
      if (!email) { orphans.push(p.name || doc.id); continue; }
      const u = byEmail[email];
      if (!u) { orphans.push(p.name || email); continue; }
      // Merge lab-mgmt fields ONLY if the user doc doesn't already have them.
      const update = {};
      ['appointment', 'primary_funding', 'start', 'end', 'notes'].forEach(k => {
        if ((u[k] == null || u[k] === '') && p[k]) update[k] = p[k];
      });
      if ((u.effort_pct == null) && p.effort_pct != null) update.effort_pct = p.effort_pct;
      // Map kind=alumni to category=alumni (only if user has no category).
      if (!u.category && p.kind === 'alumni') update.category = 'alumni';
      if (Object.keys(update).length) {
        await firebridge.updateDoc('users', u.id, update);
        merged++;
      }
    }
    alert('Backfill complete.\n\n' +
      merged + ' user(s) merged.\n' +
      orphans.length + ' legacy entries had no matching user/{uid} (no Firebase account yet): ' +
      (orphans.slice(0, 5).join(', ') + (orphans.length > 5 ? '…' : '')));
    loadAndRender();
  } catch (err) {
    console.error('[people] backfill failed:', err);
    alert('Backfill failed: ' + err.message);
  }
};

/* ---- Live tab-to-tab sync via users/{uid} onSnapshot ---- */

function attachLiveSync() {
  if (_liveUnsub) return;
  if (typeof firebridge === 'undefined' || !firebridge.collection) return;
  try {
    let firstFire = true;
    _liveUnsub = firebridge.collection('users').onSnapshot(snap => {
      _users = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      if (firstFire) { firstFire = false; return; }
      render();
    }, err => console.warn('[people] users snapshot error:', err.message));
  } catch (err) {
    console.warn('[people] live sync attach failed:', err.message);
  }
}

/* ---- Boot ---- */

const _addBtn = document.getElementById('add-member');
if (_addBtn) {
  _addBtn.textContent = '+ Invite';
  _addBtn.onclick = () => openInviteForm();
}

(async function () {
  if (typeof firebridge !== 'undefined' && firebridge.whenAuthResolved) {
    await firebridge.whenAuthResolved();
  }
  await loadAndRender();
  attachLiveSync();
})();
