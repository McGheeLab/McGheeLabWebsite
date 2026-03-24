/* ================================================================
   class-scheduler.js  —  Course Builder (V3.8)
   Tab-based page builder with nested widgets, autosave, and preview.
   Tabs contain sections; sections contain widgets.
   Uses McgheeLab.Scheduler for the speakers scheduling component.
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

(() => {

/* ─── Registries ─────────────────────────────────────────────── */
const SECTION_REG = {
  overview:    { label: 'Overview',       component: 'text',    field: 'overviewContent' },
  syllabus:    { label: 'Syllabus',       component: 'text',    field: 'syllabusContent' },
  schedule:    { label: 'Class Schedule', component: 'text',    field: 'scheduleContent' },
  speakers:    { label: 'Guest Speakers', component: 'speakers' },
  files:       { label: 'Files',          component: 'files',   path: 'files' },
  simulations: { label: 'Simulations',    component: 'text',    field: 'simulationsContent' },
  lectures:    { label: 'Lecture Notes',  component: 'files',   path: 'lectures' },
  homeworks:   { label: 'Assignments',    component: 'files',   path: 'homeworks', hasDue: true },
  exams:       { label: 'Exams',          component: 'files',   path: 'exams',     hasDue: true }
};

const WIDGET_REG = {
  text:    { label: 'Text Block' },
  image:   { label: 'Image' },
  video:   { label: 'Video' },
  links:   { label: 'Link List' },
  embed:   { label: 'Embed' },
  divider: { label: 'Divider' }
};

/* ─── Module State ───────────────────────────────────────────── */
let _scheduleId = null;
let _classData = null;
let _speakers = [];
let _currentSpeaker = null;
let _viewType = 'public';
let _useKeyAuth = false;
let _adminViewMode = 'admin';
let _previewSpeakerIdx = 0;
let _tabs = [];
let _activeTabId = null;
let _previewMode = false;
let _fileData = {};
let _dirty = false;
let _autosaveTimer = null;
let _hashChangeHandler = null;
let _beforeUnloadHandler = null;

/* ─── Default Schedule Seed ──────────────────────────────────── */
const DEFAULT_SCHEDULES = {
  'bme295c': {
    id: 'bme295c',
    title: 'BME 295C',
    subtitle: 'Research Seminar Series',
    semester: 'Summer 2026',
    description: 'A graduate seminar featuring invited PI presentations on cutting-edge bioengineering topics.',
    sections: ['overview', 'speakers', 'files'],
    mode: 'sessions',
    startDate: '2026-06-08',
    endDate: '2026-06-12',
    slotDefs: [
      { start: '08:30', end: '10:30' },
      { start: '10:30', end: '12:30' }
    ],
    startHour: 8, endHour: 18, granularity: 30,
    ownerUid: null,
    overviewContent: ''
  }
};

/* ================================================================
   HELPERS
   ================================================================ */
function esc(s) { const el = document.createElement('div'); el.textContent = s ?? ''; return el.innerHTML; }

function generateKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function getInviteKeyFromURL() {
  const hash = window.location.hash || '';
  const q = hash.indexOf('?');
  if (q === -1) return null;
  return new URLSearchParams(hash.slice(q + 1)).get('key') || null;
}

function buildInviteURL(scheduleId, key) {
  return `${location.origin}${location.pathname}#/classes/${scheduleId}?key=${key}`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderText(raw) {
  if (!raw) return '<p class="muted-text">No content yet.</p>';
  return raw.split('\n').map(line => {
    const linked = esc(line).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    return linked || '<br>';
  }).join('<br>');
}

function genBlockId() {
  return 'blk_' + Math.random().toString(16).slice(2, 8);
}

function genTabId() {
  return 'tab_' + Math.random().toString(16).slice(2, 8);
}

/* ─── Editing check ─────────────────────────────────────────── */
function isEditing() { return _viewType === 'admin' && !_previewMode; }

/* ─── Tab / Section Utilities ───────────────────────────────── */
function getActiveTab() { return _tabs.find(t => t.id === _activeTabId) || _tabs[0]; }

function getAllUsedSections() {
  const keys = new Set();
  _tabs.forEach(t => (t.sections || []).forEach(s => keys.add(s.key)));
  return keys;
}

function tabsToSections() {
  const keys = [];
  _tabs.forEach(t => (t.sections || []).forEach(s => { if (!keys.includes(s.key)) keys.push(s.key); }));
  return keys;
}

function findWidgetById(id) {
  const tab = getActiveTab();
  if (!tab) return null;
  for (const sec of (tab.sections || [])) {
    const w = (sec.widgets || []).find(w => w.id === id);
    if (w) return w;
  }
  return null;
}

function findSectionForWidget(widgetId) {
  const tab = getActiveTab();
  if (!tab) return null;
  for (const sec of (tab.sections || [])) {
    if ((sec.widgets || []).some(w => w.id === widgetId)) return sec;
  }
  return null;
}

/* ─── Migration from legacy formats ─────────────────────────── */
function migrateLegacy(schedule) {
  if (schedule.tabs && schedule.tabs.length) {
    return JSON.parse(JSON.stringify(schedule.tabs));
  }
  // Migrate from flat layout or sections array
  const layout = schedule.layout
    ? JSON.parse(JSON.stringify(schedule.layout))
    : (schedule.sections || ['overview']).map(key => ({ type: 'section', key, id: genBlockId() }));

  const sections = [];
  let current = null;
  for (const block of layout) {
    if (block.type === 'section') {
      current = { key: block.key, id: block.id || genBlockId(), widgets: [] };
      sections.push(current);
    } else if (block.type === 'widget') {
      if (!current) {
        current = { key: 'overview', id: genBlockId(), widgets: [] };
        sections.push(current);
      }
      const w = { ...block };
      delete w.type;
      if (!w.id) w.id = genBlockId();
      current.widgets.push(w);
    }
  }
  if (!sections.length) {
    sections.push({ key: 'overview', id: genBlockId(), widgets: [] });
  }
  return [{ id: genTabId(), name: 'Home', sections }];
}

/* ================================================================
   DATABASE
   ================================================================ */
const ScheduleDB = {
  async getSchedule(id) {
    const doc = await McgheeLab.db.collection('schedules').doc(id).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  async saveSchedule(data) {
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    const id = data.id; const rest = Object.assign({}, data); delete rest.id;
    await McgheeLab.db.collection('schedules').doc(id).set(rest, { merge: true });
    return id;
  },
  async getSpeakers(scheduleId) {
    const snap = await McgheeLab.db.collection('participants')
      .where('scheduleId', '==', scheduleId).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async getSpeakerByKey(key) {
    const doc = await McgheeLab.db.collection('participants').doc(key).get();
    return doc.exists ? { id: doc.id, ...doc.data() } : null;
  },
  async addSpeaker(data) {
    const key = generateKey();
    data.key = key;
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await McgheeLab.db.collection('participants').doc(key).set(data);
    return key;
  },
  async updateSpeaker(id, data) {
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await McgheeLab.db.collection('participants').doc(id).update(data);
  },
  async updateSpeakerByKey(key, data) {
    data.key = key;
    data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await McgheeLab.db.collection('participants').doc(key).update(data);
  },
  async deleteSpeaker(id) {
    await McgheeLab.db.collection('participants').doc(id).delete();
  },
  async getFiles(classId, section) {
    const snap = await McgheeLab.db.collection('classFiles')
      .where('classId', '==', classId).where('section', '==', section).get();
    const files = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    files.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    return files;
  },
  async addFile(data) {
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    const ref = await McgheeLab.db.collection('classFiles').add(data);
    return ref.id;
  },
  async deleteFile(fileId, storagePath) {
    if (storagePath) {
      try { await firebase.storage().ref(storagePath).delete(); } catch (e) { console.warn('Storage delete failed:', e); }
    }
    await McgheeLab.db.collection('classFiles').doc(fileId).delete();
  }
};

async function resolveSchedule(scheduleId) {
  try {
    const remote = await ScheduleDB.getSchedule(scheduleId);
    if (remote) return remote;
  } catch (e) { /* fallback */ }
  return DEFAULT_SCHEDULES[scheduleId] || null;
}

/* ================================================================
   RENDER — sync shell (called from app.js)
   ================================================================ */
function renderClassPage(scheduleId) {
  scheduleId = scheduleId || 'bme295c';
  const sched = DEFAULT_SCHEDULES[scheduleId] || { title: 'Schedule', subtitle: '', semester: '', description: '' };
  return `
    <div class="class-page max-w" data-schedule-id="${esc(scheduleId)}">
      <div class="section card reveal">
        <div class="class-header">
          <div class="cb-header-row">
            <a href="#/classes" class="class-back-link">&larr; All Classes</a>
            <div class="cb-header-actions" id="cb-header-actions"></div>
          </div>
          <h2 id="sched-title">${esc(sched.title)}</h2>
          <p class="class-subtitle" id="sched-subtitle">${esc(sched.subtitle || '')}${sched.semester ? ' &mdash; ' + esc(sched.semester) : ''}</p>
        </div>
      </div>
      <div id="class-page-content"><p class="muted-text" style="padding:2rem;text-align:center;">Loading...</p></div>
    </div>
  `;
}

/* ================================================================
   WIRE — async data load + canvas build
   ================================================================ */
async function wireClassPage(scheduleId) {
  scheduleId = scheduleId || 'bme295c';
  _scheduleId = scheduleId;
  cleanupListeners();

  const Auth = McgheeLab.Auth;
  const isAdmin = Auth?.currentProfile?.role === 'admin';
  const isLoggedIn = !!Auth?.currentUser;
  const inviteKey = getInviteKeyFromURL();

  let schedule = await resolveSchedule(scheduleId);
  if (!schedule) {
    const c = document.getElementById('class-page-content');
    if (c) c.innerHTML = '<p class="muted-text">Schedule not found.</p>';
    return;
  }

  // Seed default on first admin visit
  if (isAdmin && DEFAULT_SCHEDULES[scheduleId] && !schedule.updatedAt) {
    const seed = Object.assign({}, DEFAULT_SCHEDULES[scheduleId]);
    if (!seed.ownerUid && Auth.currentUser) seed.ownerUid = Auth.currentUser.uid;
    try { await ScheduleDB.saveSchedule(seed); schedule = await resolveSchedule(scheduleId); } catch (e) {}
  }

  // Update header
  const titleEl = document.getElementById('sched-title');
  const subtitleEl = document.getElementById('sched-subtitle');
  if (titleEl) titleEl.textContent = schedule.title || 'Schedule';
  if (subtitleEl) subtitleEl.innerHTML = esc(schedule.subtitle || '') + (schedule.semester ? ' &mdash; ' + esc(schedule.semester) : '');

  // Load speakers
  let speakers = [];
  try { speakers = await ScheduleDB.getSpeakers(scheduleId); } catch (e) {}

  // Auto-link UID
  if (isLoggedIn && Auth.currentUser.email) {
    const email = Auth.currentUser.email.toLowerCase();
    for (const sp of speakers) {
      if (sp.speakerEmail?.toLowerCase() === email && !sp.speakerUid) {
        try { await ScheduleDB.updateSpeaker(sp.id, { speakerUid: Auth.currentUser.uid }); sp.speakerUid = Auth.currentUser.uid; } catch (e) {}
      }
    }
  }

  // Identify current speaker
  let currentSpeaker = null, useKeyAuth = false;
  if (inviteKey) {
    currentSpeaker = speakers.find(s => s.id === inviteKey || s.key === inviteKey);
    if (!currentSpeaker) try { currentSpeaker = await ScheduleDB.getSpeakerByKey(inviteKey); } catch (e) {}
    if (currentSpeaker) useKeyAuth = true;
  }
  if (!currentSpeaker && isLoggedIn) {
    currentSpeaker = speakers.find(s =>
      s.speakerUid === Auth.currentUser.uid ||
      s.speakerEmail?.toLowerCase() === Auth.currentUser.email?.toLowerCase()
    );
  }

  // Store state
  _classData = schedule;
  _speakers = speakers;
  _currentSpeaker = currentSpeaker;
  _useKeyAuth = useKeyAuth;
  _viewType = isAdmin ? 'admin' : (currentSpeaker ? 'guest' : 'public');
  _previewMode = false;

  // Resolve tabs (tabs field or migrate from layout/sections)
  _tabs = migrateLegacy(schedule);
  _activeTabId = _tabs[0]?.id || null;

  // Pre-load file data for ALL file-type sections across ALL tabs
  _fileData = {};
  const fileSections = [];
  _tabs.forEach(tab => {
    (tab.sections || []).forEach(sec => {
      if (SECTION_REG[sec.key]?.component === 'files') fileSections.push(sec);
    });
  });
  await Promise.all(fileSections.map(async (sec) => {
    const reg = SECTION_REG[sec.key];
    try { _fileData[sec.key] = await ScheduleDB.getFiles(_scheduleId, reg.path || sec.key); } catch (e) { _fileData[sec.key] = []; }
  }));

  // Header actions
  const hdrActions = document.getElementById('cb-header-actions');
  if (hdrActions && _viewType === 'admin') {
    hdrActions.innerHTML = `
      <span id="cb-autosave-status" class="cb-autosave-status cb-status-saved">Saved</span>
      <button type="button" id="cb-preview-btn" class="btn btn-small">Preview</button>
      <button type="button" id="cb-save-btn" class="btn btn-small">Save Now</button>
      <button type="button" id="cb-settings-btn" class="btn btn-small btn-secondary">Settings</button>
    `;
  }

  // Build canvas
  const content = document.getElementById('class-page-content');
  if (!content) return;
  _dirty = false;
  content.innerHTML = buildCanvasHTML();
  wireCanvas();

  // Admin: autosave + header buttons + beforeunload
  if (_viewType === 'admin') {
    startAutosave();
    document.getElementById('cb-save-btn')?.addEventListener('click', () => persistAll());
    document.getElementById('cb-settings-btn')?.addEventListener('click', () => openSettings());
    document.getElementById('cb-preview-btn')?.addEventListener('click', () => togglePreview());
    _beforeUnloadHandler = (e) => { if (_dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', _beforeUnloadHandler);
  }

  // Cleanup on navigate away
  _hashChangeHandler = () => {
    const hash = window.location.hash || '';
    if (!hash.includes('/classes/' + _scheduleId)) cleanupListeners();
  };
  window.addEventListener('hashchange', _hashChangeHandler);
}

function cleanupListeners() {
  if (_dirty) persistAll();
  stopAutosave();
  if (_hashChangeHandler) { window.removeEventListener('hashchange', _hashChangeHandler); _hashChangeHandler = null; }
  if (_beforeUnloadHandler) { window.removeEventListener('beforeunload', _beforeUnloadHandler); _beforeUnloadHandler = null; }
}

/* ================================================================
   PREVIEW TOGGLE
   ================================================================ */
function togglePreview() {
  if (_previewMode) {
    _previewMode = false;
    const btn = document.getElementById('cb-preview-btn');
    if (btn) btn.textContent = 'Preview';
  } else {
    gatherContentFromDOM();
    _previewMode = true;
    const btn = document.getElementById('cb-preview-btn');
    if (btn) btn.textContent = 'Edit';
  }
  refreshCanvas();
}

/* ================================================================
   CANVAS HTML
   ================================================================ */
function buildCanvasHTML() {
  const editing = isEditing();
  const tab = getActiveTab();

  let html = '';

  // Preview banner
  if (_viewType === 'admin' && _previewMode) {
    html += '<div class="cb-preview-banner"><span>Viewing as public</span></div>';
  }

  // Tab bar
  html += buildTabBar();

  // Add Section dropdown (admin editing only)
  if (editing) {
    const usedKeys = getAllUsedSections();
    html += `<div class="cb-add-section-bar">
      <div class="cb-mobile-dropdown">
        <button type="button" class="btn btn-small" id="cb-add-section-btn">+ Section</button>
        <div class="cb-dropdown-menu" id="cb-section-dropdown">${buildSectionDropdownItems(usedKeys)}</div>
      </div>
    </div>`;
  }

  if (!tab) {
    html += '<p class="muted-text" style="text-align:center;padding:2rem;">No tabs yet. Click + to create one.</p>';
    return html;
  }

  // Canvas with sections
  html += `<div class="cb-canvas${editing ? '' : ' cb-canvas-readonly'}" id="cb-canvas">`;
  const sections = tab.sections || [];
  if (!sections.length) {
    html += editing
      ? '<div class="cb-empty-hint">Add sections to this tab using the button above.</div>'
      : '<p class="muted-text" style="text-align:center;padding:2rem;">No content yet.</p>';
  } else {
    sections.forEach(sec => {
      html += buildSectionBlockHTML(sec);
    });
  }
  html += '</div>';
  return html;
}

/* ─── Tab Bar ───────────────────────────────────────────────── */
function buildTabBar() {
  const editing = isEditing();
  let html = '<div class="cb-tab-bar">';
  _tabs.forEach(tab => {
    const active = tab.id === _activeTabId;
    html += `<div class="cb-tab${active ? ' cb-tab-active' : ''}" data-tab-id="${tab.id}">
      <span class="cb-tab-name">${esc(tab.name)}</span>
      ${editing ? `<button type="button" class="cb-tab-delete" data-tab-id="${tab.id}" title="Delete tab">&times;</button>` : ''}
    </div>`;
  });
  if (editing) {
    html += '<button type="button" class="cb-tab-add" id="cb-add-tab" title="Add tab">+</button>';
  }
  html += '</div>';
  return html;
}

/* ─── Dropdown Builders ─────────────────────────────────────── */
function buildSectionDropdownItems(usedKeys) {
  return Object.entries(SECTION_REG).map(([key, reg]) => {
    const used = usedKeys?.has(key);
    return `<button type="button" class="cb-dropdown-item${used ? ' cb-dropdown-used' : ''}" data-add-type="section" data-add-key="${key}" ${used ? 'disabled' : ''}>${esc(reg.label)}</button>`;
  }).join('');
}

function buildWidgetDropdownItems() {
  return Object.entries(WIDGET_REG).map(([kind, reg]) => {
    return `<button type="button" class="cb-dropdown-item" data-add-type="widget" data-add-key="${kind}">${esc(reg.label)}</button>`;
  }).join('');
}

/* ================================================================
   SECTION BLOCK HTML
   ================================================================ */
function buildSectionBlockHTML(section) {
  const editing = isEditing();
  const reg = SECTION_REG[section.key];
  const label = reg?.label || section.key;

  if (!editing) {
    // Public / preview: read-only section + widgets
    let html = `<div class="cb-section cb-section-readonly" data-section-id="${section.id}">`;
    html += `<h3 class="cb-section-title-readonly">${esc(label)}</h3>`;
    html += `<div class="cb-section-body">${renderSectionBody(section)}</div>`;
    (section.widgets || []).forEach(w => {
      const wBody = renderWidgetBody(w);
      if (wBody) {
        if (w.kind === 'divider') { html += '<hr class="cb-divider" />'; }
        else { html += `<div class="cb-widget cb-widget-readonly"><div class="cb-widget-body">${wBody}</div></div>`; }
      }
    });
    html += '</div>';
    return html;
  }

  // Admin editing: section chrome + body + widgets + add-widget
  let html = `<div class="cb-section" data-section-id="${section.id}" data-section-key="${section.key}">`;
  // Chrome bar
  html += `<div class="cb-section-chrome">
    <span class="cb-section-handle" title="Drag to reorder">&#x2801;&#x2801;</span>
    <span class="cb-section-label">${esc(label)}</span>
    <span class="cb-block-type-badge">Section</span>
    <div class="cb-block-actions">
      <button type="button" class="cb-section-move" data-dir="up" title="Move up">&uarr;</button>
      <button type="button" class="cb-section-move" data-dir="down" title="Move down">&darr;</button>
      <button type="button" class="cb-section-remove" title="Remove section">&times;</button>
    </div>
  </div>`;
  // Section body
  html += `<div class="cb-section-body">${renderSectionBody(section)}</div>`;
  // Nested widgets (always render drop zone)
  html += `<div class="cb-widgets-area" data-section-id="${section.id}">`;
  (section.widgets || []).forEach(w => {
    html += buildWidgetBlockHTML(w, section.id);
  });
  html += '</div>';
  // Add widget dropdown
  html += `<div class="cb-add-widget-bar">
    <div class="cb-mobile-dropdown">
      <button type="button" class="btn btn-small btn-ghost cb-add-widget-trigger" data-section-id="${section.id}">+ Widget</button>
      <div class="cb-dropdown-menu cb-widget-dropdown-menu">${buildWidgetDropdownItems()}</div>
    </div>
  </div>`;
  html += '</div>';
  return html;
}

/* ================================================================
   WIDGET BLOCK HTML
   ================================================================ */
function buildWidgetBlockHTML(widget, sectionId) {
  const editing = isEditing();
  const label = WIDGET_REG[widget.kind]?.label || widget.kind;

  if (!editing) {
    if (widget.kind === 'divider') return '<hr class="cb-divider" />';
    const body = renderWidgetBody(widget);
    return body ? `<div class="cb-widget cb-widget-readonly"><div class="cb-widget-body">${body}</div></div>` : '';
  }

  return `<div class="cb-widget" data-widget-id="${widget.id}" data-widget-kind="${widget.kind}" data-parent-section="${sectionId}">
    <div class="cb-widget-chrome">
      <span class="cb-widget-handle" title="Drag to reorder">&#x2801;&#x2801;</span>
      <span class="cb-widget-label">${esc(label)}</span>
      <span class="cb-block-type-badge">Widget</span>
      <div class="cb-block-actions">
        <button type="button" class="cb-widget-move" data-dir="up" title="Move up">&uarr;</button>
        <button type="button" class="cb-widget-move" data-dir="down" title="Move down">&darr;</button>
        <button type="button" class="cb-widget-remove" title="Remove widget">&times;</button>
      </div>
    </div>
    <div class="cb-widget-body">${renderWidgetBody(widget)}</div>
  </div>`;
}

/* ================================================================
   SECTION BODY RENDERERS
   ================================================================ */
function renderSectionBody(section) {
  const reg = SECTION_REG[section.key];
  if (!reg) return '<p class="muted-text">Unknown section.</p>';
  const editing = isEditing();

  switch (reg.component) {
    case 'text': {
      const content = _classData[reg.field] || '';
      if (editing) {
        return `<textarea class="cb-textarea" data-field="${reg.field}" rows="6" placeholder="Enter ${reg.label.toLowerCase()} content...">${esc(content)}</textarea>
          <p class="muted-text" style="margin:4px 0 0;font-size:.75rem;">Plain text. URLs auto-link. Blank lines for paragraphs.</p>`;
      }
      return `<div class="text-preview">${renderText(content)}</div>`;
    }
    case 'files': {
      const files = _fileData[section.key] || [];
      const canUpload = editing || (_viewType === 'guest' && section.key === 'files');
      let html = '';
      if (canUpload) {
        html += `<div class="file-upload-area">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;">
            <div class="form-group" style="flex:2;min-width:200px;">
              <label>Upload File</label>
              <input type="file" class="cb-file-input" data-section-key="${section.key}" />
            </div>
            <div class="form-group" style="flex:1;min-width:150px;">
              <label>Description</label>
              <input type="text" class="cb-file-desc" placeholder="Brief description" />
            </div>
            ${reg.hasDue ? '<div class="form-group" style="min-width:140px;"><label>Due</label><input type="date" class="cb-file-due" /></div>' : ''}
            <button type="button" class="btn cb-file-upload-btn" data-section-key="${section.key}">Upload</button>
          </div>
          <div class="cb-file-status save-status"></div>
        </div>`;
      }
      html += `<div class="cb-file-list" data-section-key="${section.key}">${buildFileListHTML(files, reg)}</div>`;
      return html;
    }
    case 'speakers':
      return `<div id="cb-speakers-container">${McgheeLab.Scheduler?.render?.(buildSchedulerConfig()) || '<p class="muted-text">Scheduler not loaded.</p>'}</div>`;
    default:
      return '<p class="muted-text">Unknown component.</p>';
  }
}

function buildFileListHTML(files, reg) {
  if (!files.length) return '<p class="muted-text">No files yet.</p>';
  const editing = isEditing();
  let html = '<div style="overflow-x:auto;"><table class="scheduler-table"><thead><tr>';
  html += '<th>Name</th><th>Description</th>';
  if (reg.hasDue) html += '<th>Due</th>';
  html += '<th>Size</th><th>Uploaded</th><th></th>';
  if (editing) html += '<th></th>';
  html += '</tr></thead><tbody>';
  files.forEach(f => {
    const date = f.createdAt?.toDate?.() ? f.createdAt.toDate().toLocaleDateString() : '-';
    html += `<tr>
      <td>${esc(f.fileName || 'File')}</td>
      <td class="muted-text">${esc(f.description || '')}</td>`;
    if (reg.hasDue) html += `<td>${esc(f.dueDate || '-')}</td>`;
    html += `<td class="muted-text">${fmtSize(f.fileSize || 0)}</td>
      <td class="muted-text">${esc(f.uploadedByName || '-')}<br><small>${date}</small></td>
      <td><a href="${esc(f.fileUrl)}" target="_blank" rel="noopener" class="btn btn-small">Download</a></td>`;
    if (editing) html += `<td><button class="btn btn-danger btn-small cb-file-delete" data-file-id="${f.id}" data-storage-path="${esc(f.storagePath || '')}">Delete</button></td>`;
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
}

/* ================================================================
   WIDGET BODY RENDERERS
   ================================================================ */
function renderWidgetBody(widget) {
  const editing = isEditing();
  switch (widget.kind) {
    case 'text': {
      const content = widget.content || '';
      if (editing) {
        return `<textarea class="cb-textarea cb-widget-text" data-widget-id="${widget.id}" rows="4" placeholder="Enter text...">${esc(content)}</textarea>`;
      }
      return content ? `<div class="text-preview">${renderText(content)}</div>` : '';
    }
    case 'image': {
      const url = widget.url || '';
      const caption = widget.caption || '';
      let html = '';
      if (url) {
        html += `<div class="cb-image-preview"><img src="${esc(url)}" alt="${esc(caption)}" loading="lazy" style="max-width:100%;border-radius:8px;" /></div>`;
        if (caption && !editing) html += `<p class="muted-text" style="text-align:center;margin-top:6px;font-size:.85rem;">${esc(caption)}</p>`;
      }
      if (editing) {
        html += `<div class="cb-image-controls" style="margin-top:8px;">
          <input type="file" class="cb-image-input" data-widget-id="${widget.id}" accept="image/*" />
          <input type="text" class="cb-image-caption-input" data-widget-id="${widget.id}" placeholder="Caption (optional)" value="${esc(caption)}" style="margin-top:4px;width:100%;" />
          <div class="cb-image-status save-status"></div>
        </div>`;
      }
      return html || (editing ? '<p class="muted-text">Upload an image above.</p>' : '');
    }
    case 'video': {
      const url = widget.url || '';
      const caption = widget.caption || '';
      let html = '';
      if (url) {
        const embedUrl = getVideoEmbedUrl(url);
        if (embedUrl) {
          html += `<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;">
            <iframe src="${esc(embedUrl)}" style="position:absolute;top:0;left:0;width:100%;height:100%;" frameborder="0" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen></iframe>
          </div>`;
        } else {
          html += `<video src="${esc(url)}" controls style="max-width:100%;border-radius:8px;"></video>`;
        }
        if (caption && !editing) html += `<p class="muted-text" style="text-align:center;margin-top:6px;font-size:.85rem;">${esc(caption)}</p>`;
      }
      if (editing) {
        html += `<div style="margin-top:8px;">
          <input type="url" class="cb-video-url" data-widget-id="${widget.id}" placeholder="YouTube, Vimeo, or direct video URL" value="${esc(url)}" style="width:100%;" />
          <input type="text" class="cb-video-caption" data-widget-id="${widget.id}" placeholder="Caption (optional)" value="${esc(caption)}" style="margin-top:4px;width:100%;" />
        </div>`;
      }
      return html || '';
    }
    case 'links': {
      const items = widget.items || [];
      if (editing) {
        let html = `<div class="cb-links-editor" data-widget-id="${widget.id}">`;
        items.forEach((item, i) => {
          html += `<div class="cb-link-row" data-index="${i}" style="display:flex;gap:6px;margin-bottom:6px;">
            <input type="text" class="cb-link-label" placeholder="Label" value="${esc(item.label || '')}" style="flex:1;" />
            <input type="url" class="cb-link-url" placeholder="https://..." value="${esc(item.url || '')}" style="flex:2;" />
            <button type="button" class="btn btn-danger btn-small cb-link-remove">&times;</button>
          </div>`;
        });
        html += `<button type="button" class="btn btn-small cb-link-add" data-widget-id="${widget.id}">+ Add Link</button></div>`;
        return html;
      }
      if (!items.length) return '';
      return '<ul class="cb-link-list">' + items.filter(it => it.url).map(it =>
        `<li><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.label || it.url)}</a></li>`
      ).join('') + '</ul>';
    }
    case 'embed': {
      const raw = widget.html || '';
      if (editing) {
        return `<textarea class="cb-textarea cb-embed-editor" data-widget-id="${widget.id}" rows="4" placeholder="Paste HTML or iframe embed code...">${esc(raw)}</textarea>
          ${raw ? '<div class="cb-embed-preview" style="margin-top:8px;border:1px solid rgba(255,255,255,.1);border-radius:8px;overflow:hidden;">' + raw + '</div>' : ''}`;
      }
      return raw ? `<div class="cb-embed-preview">${raw}</div>` : '';
    }
    case 'divider':
      return '<hr class="cb-divider" />';
    default:
      return '<p class="muted-text">Unknown widget.</p>';
  }
}

function getVideoEmbedUrl(url) {
  if (!url) return null;
  let m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (m) return 'https://www.youtube.com/embed/' + m[1];
  m = url.match(/vimeo\.com\/(\d+)/);
  if (m) return 'https://player.vimeo.com/video/' + m[1];
  return null;
}

/* ================================================================
   CANVAS WIRING
   ================================================================ */
function wireCanvas() {
  wireTabBar();
  if (isEditing()) {
    wireSectionActions();
    wireWidgetActions();
    wireBlockEditors();
    wireAddDropdowns();
    initDragAndDrop();
  }
  // Wire speakers section if present in active tab
  const tab = getActiveTab();
  if (tab?.sections?.some(s => s.key === 'speakers')) {
    try { McgheeLab.Scheduler?.wire?.('cb-speakers-container', buildSchedulerConfig()); } catch (e) { console.warn('Scheduler wire error:', e); }
  }
}

/* ─── Tab Bar Wiring ─────────────────────────────────────────── */
function wireTabBar() {
  // Tab switching
  document.querySelectorAll('.cb-tab[data-tab-id]').forEach(tabEl => {
    tabEl.addEventListener('click', (e) => {
      if (e.target.classList.contains('cb-tab-delete')) return;
      switchTab(tabEl.dataset.tabId);
    });
  });

  if (isEditing()) {
    // Tab rename (double-click)
    document.querySelectorAll('.cb-tab-name').forEach(span => {
      span.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const tabId = span.closest('.cb-tab')?.dataset.tabId;
        renameTab(tabId);
      });
    });

    // Tab delete
    document.querySelectorAll('.cb-tab-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTab(btn.dataset.tabId);
      });
    });

    // Tab add
    document.getElementById('cb-add-tab')?.addEventListener('click', () => addTab());
  }
}

/* ─── Section Actions ────────────────────────────────────────── */
function wireSectionActions() {
  document.querySelectorAll('.cb-section-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const secId = btn.closest('.cb-section')?.dataset.sectionId;
      if (secId && confirm('Remove this section and its widgets?')) removeSection(secId);
    });
  });
  document.querySelectorAll('.cb-section-move').forEach(btn => {
    btn.addEventListener('click', () => {
      const secId = btn.closest('.cb-section')?.dataset.sectionId;
      if (secId) moveSection(secId, btn.dataset.dir === 'up' ? -1 : 1);
    });
  });
}

/* ─── Widget Actions ─────────────────────────────────────────── */
function wireWidgetActions() {
  document.querySelectorAll('.cb-widget-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const wEl = btn.closest('.cb-widget');
      const widgetId = wEl?.dataset.widgetId;
      if (widgetId && confirm('Remove this widget?')) removeWidget(widgetId);
    });
  });
  document.querySelectorAll('.cb-widget-move').forEach(btn => {
    btn.addEventListener('click', () => {
      const wEl = btn.closest('.cb-widget');
      const widgetId = wEl?.dataset.widgetId;
      if (widgetId) moveWidget(widgetId, btn.dataset.dir === 'up' ? -1 : 1);
    });
  });
}

/* ─── Block Editors ──────────────────────────────────────────── */
function wireBlockEditors() {
  // Mark dirty on any editor input
  document.querySelectorAll('.cb-textarea, .cb-widget-text, .cb-video-url, .cb-video-caption, .cb-image-caption-input, .cb-embed-editor, .cb-link-label, .cb-link-url').forEach(el => {
    el.addEventListener('input', () => markDirty());
  });

  // Link add
  document.querySelectorAll('.cb-link-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const widget = findWidgetById(btn.dataset.widgetId);
      if (!widget) return;
      if (!widget.items) widget.items = [];
      gatherContentFromDOM();
      widget.items.push({ label: '', url: '' });
      markDirty();
      refreshCanvas();
    });
  });

  // Link remove
  document.querySelectorAll('.cb-link-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const editor = btn.closest('.cb-links-editor');
      const row = btn.closest('.cb-link-row');
      const widget = findWidgetById(editor?.dataset.widgetId);
      const idx = parseInt(row?.dataset.index);
      if (widget?.items && !isNaN(idx)) {
        gatherContentFromDOM();
        widget.items.splice(idx, 1);
        markDirty();
        refreshCanvas();
      }
    });
  });

  // File upload
  document.querySelectorAll('.cb-file-upload-btn').forEach(btn => {
    btn.addEventListener('click', () => handleFileUpload(btn));
  });

  // File delete
  document.querySelectorAll('.cb-file-delete').forEach(btn => {
    btn.addEventListener('click', () => handleFileDelete(btn));
  });

  // Image upload
  document.querySelectorAll('.cb-image-input').forEach(input => {
    input.addEventListener('change', () => handleImageUpload(input));
  });
}

/* ─── Add Section / Widget Dropdowns ─────────────────────────── */
function wireAddDropdowns() {
  // Add Section dropdown
  const secBtn = document.getElementById('cb-add-section-btn');
  const secDrop = document.getElementById('cb-section-dropdown');
  secBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllDropdowns();
    secDrop?.classList.toggle('cb-dropdown-open');
  });

  secDrop?.querySelectorAll('.cb-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      if (item.disabled) return;
      addSection(item.dataset.addKey);
      closeAllDropdowns();
    });
  });

  // Add Widget dropdowns (one per section)
  document.querySelectorAll('.cb-add-widget-trigger').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      const menu = btn.closest('.cb-mobile-dropdown')?.querySelector('.cb-widget-dropdown-menu');
      menu?.classList.toggle('cb-dropdown-open');
    });
  });

  document.querySelectorAll('.cb-widget-dropdown-menu .cb-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      const sectionId = item.closest('.cb-add-widget-bar')?.querySelector('.cb-add-widget-trigger')?.dataset.sectionId;
      if (sectionId) addWidget(sectionId, item.dataset.addKey);
      closeAllDropdowns();
    });
  });

  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.cb-mobile-dropdown')) closeAllDropdowns();
  }, { capture: false });
}

function closeAllDropdowns() {
  document.querySelectorAll('.cb-dropdown-menu').forEach(d => d.classList.remove('cb-dropdown-open'));
}

/* ================================================================
   FILE / IMAGE HANDLERS
   ================================================================ */
async function handleFileUpload(btn) {
  const sectionKey = btn.dataset.sectionKey;
  const sectionEl = btn.closest('.cb-section');
  const fileInput = sectionEl?.querySelector('.cb-file-input');
  const file = fileInput?.files?.[0];
  if (!file) { alert('Select a file first.'); return; }
  if (file.size > 50 * 1024 * 1024) { alert('File too large (50 MB max).'); return; }

  const st = sectionEl.querySelector('.cb-file-status');
  if (st) st.textContent = 'Uploading...';
  const reg = SECTION_REG[sectionKey];
  const storagePath = `classes/${_scheduleId}/${reg?.path || sectionKey}/${Date.now()}_${file.name}`;

  try {
    const ref = firebase.storage().ref(storagePath);
    await ref.put(file);
    const url = await ref.getDownloadURL();
    const Auth = McgheeLab.Auth;
    await ScheduleDB.addFile({
      classId: _scheduleId, section: reg?.path || sectionKey,
      fileName: file.name, fileUrl: url, storagePath, fileSize: file.size, contentType: file.type,
      description: sectionEl.querySelector('.cb-file-desc')?.value?.trim() || '',
      dueDate: sectionEl.querySelector('.cb-file-due')?.value || null,
      uploadedBy: Auth?.currentUser?.uid || null,
      uploadedByName: _currentSpeaker?.speakerName || Auth?.currentProfile?.name || 'Unknown'
    });
    if (st) st.textContent = 'Uploaded!';
    fileInput.value = '';
    const descInput = sectionEl.querySelector('.cb-file-desc');
    if (descInput) descInput.value = '';
    setTimeout(() => { if (st) st.textContent = ''; }, 2000);
    // Refresh file list
    _fileData[sectionKey] = await ScheduleDB.getFiles(_scheduleId, reg?.path || sectionKey);
    const listEl = sectionEl.querySelector('.cb-file-list');
    if (listEl) {
      listEl.innerHTML = buildFileListHTML(_fileData[sectionKey], reg);
      listEl.querySelectorAll('.cb-file-delete').forEach(b => b.addEventListener('click', () => handleFileDelete(b)));
    }
  } catch (e) { if (st) st.textContent = 'Upload failed.'; console.error(e); }
}

async function handleFileDelete(btn) {
  if (!confirm('Delete this file?')) return;
  const sectionEl = btn.closest('.cb-section');
  const listEl = sectionEl?.querySelector('.cb-file-list');
  const sectionKey = listEl?.dataset.sectionKey;
  try {
    await ScheduleDB.deleteFile(btn.dataset.fileId, btn.dataset.storagePath);
    if (sectionKey) {
      const reg = SECTION_REG[sectionKey];
      _fileData[sectionKey] = await ScheduleDB.getFiles(_scheduleId, reg?.path || sectionKey);
      if (listEl) {
        listEl.innerHTML = buildFileListHTML(_fileData[sectionKey], reg);
        listEl.querySelectorAll('.cb-file-delete').forEach(b => b.addEventListener('click', () => handleFileDelete(b)));
      }
    }
  } catch (e) { alert('Failed to delete.'); }
}

async function handleImageUpload(input) {
  const widgetId = input.dataset.widgetId;
  const widget = findWidgetById(widgetId);
  const widgetEl = document.querySelector(`.cb-widget[data-widget-id="${widgetId}"]`);
  if (!widget || !input.files?.[0]) return;
  const file = input.files[0];
  if (file.size > 10 * 1024 * 1024) { alert('Image too large (10 MB max).'); return; }

  const st = widgetEl?.querySelector('.cb-image-status');
  if (st) st.textContent = 'Uploading...';
  const storagePath = `classes/${_scheduleId}/widgets/${widgetId}_${Date.now()}`;
  try {
    const ref = firebase.storage().ref(storagePath);
    await ref.put(file);
    widget.url = await ref.getDownloadURL();
    widget.storagePath = storagePath;
    markDirty();
    if (st) st.textContent = 'Uploaded!';
    setTimeout(() => { gatherContentFromDOM(); refreshCanvas(); }, 500);
  } catch (e) { if (st) st.textContent = 'Upload failed.'; console.error(e); }
}

/* ================================================================
   DRAG AND DROP (sections in canvas + widgets in sections)
   ================================================================ */
function initDragAndDrop() {
  const canvas = document.getElementById('cb-canvas');
  if (!canvas) return;

  /* ── Section DnD ─────────────────────────────────────────── */
  // Section handles enable drag on parent section
  canvas.querySelectorAll('.cb-section-handle').forEach(handle => {
    handle.addEventListener('mousedown', () => {
      handle.closest('.cb-section')?.setAttribute('draggable', 'true');
    });
  });

  // Section drag events
  canvas.querySelectorAll('.cb-section').forEach(sec => {
    sec.addEventListener('dragstart', (e) => {
      if (!sec.getAttribute('draggable')) { e.preventDefault(); return; }
      e.dataTransfer.setData('text/plain', JSON.stringify({
        source: 'section', sectionId: sec.dataset.sectionId
      }));
      e.dataTransfer.effectAllowed = 'move';
      sec.classList.add('cb-dragging');
      setTimeout(() => { sec.style.opacity = '0.3'; }, 0);
    });
    sec.addEventListener('dragend', () => {
      sec.classList.remove('cb-dragging');
      sec.style.opacity = '';
      sec.removeAttribute('draggable');
      removeDropIndicators();
    });
  });

  /* ── Widget DnD ──────────────────────────────────────────── */
  // Widget handles enable drag on parent widget
  canvas.querySelectorAll('.cb-widget-handle').forEach(handle => {
    handle.addEventListener('mousedown', () => {
      handle.closest('.cb-widget')?.setAttribute('draggable', 'true');
    });
  });

  // Widget drag events — stopPropagation so section doesn't capture them
  canvas.querySelectorAll('.cb-widget').forEach(wEl => {
    wEl.addEventListener('dragstart', (e) => {
      if (!wEl.getAttribute('draggable')) { e.preventDefault(); return; }
      e.stopPropagation();
      e.dataTransfer.setData('text/plain', JSON.stringify({
        source: 'widget', widgetId: wEl.dataset.widgetId, fromSection: wEl.dataset.parentSection
      }));
      e.dataTransfer.effectAllowed = 'move';
      wEl.classList.add('cb-dragging');
      setTimeout(() => { wEl.style.opacity = '0.3'; }, 0);
    });
    wEl.addEventListener('dragend', () => {
      wEl.classList.remove('cb-dragging');
      wEl.style.opacity = '';
      wEl.removeAttribute('draggable');
      removeDropIndicators();
    });
  });

  /* ── Widget drop zones (each .cb-widgets-area) ───────────── */
  canvas.querySelectorAll('.cb-widgets-area').forEach(area => {
    area.addEventListener('dragover', (e) => {
      // Only accept widget drags — check if a widget is being dragged
      if (!canvas.querySelector('.cb-widget.cb-dragging')) return;
      e.preventDefault();
      e.stopPropagation();
      showWidgetDropIndicator(area, e.clientY);
    });
    area.addEventListener('dragleave', (e) => {
      if (!area.contains(e.relatedTarget)) removeDropIndicators();
    });
    area.addEventListener('drop', (e) => {
      if (!canvas.querySelector('.cb-widget.cb-dragging')) return;
      e.preventDefault();
      e.stopPropagation();
      removeDropIndicators();
      const dropIdx = getWidgetDropIndex(area, e.clientY);
      const toSectionId = area.dataset.sectionId;
      try {
        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
        if (data.source === 'widget' && toSectionId) {
          reorderWidgetDnD(data.widgetId, data.fromSection, toSectionId, dropIdx);
        }
      } catch (err) { console.warn('Widget drop error:', err); }
    });
  });

  /* ── Section drop zone (canvas level) ────────────────────── */
  canvas.addEventListener('dragover', (e) => {
    // Only show section indicators when a section is being dragged
    if (!canvas.querySelector('.cb-section.cb-dragging')) return;
    e.preventDefault();
    showSectionDropIndicator(canvas, e.clientY);
  });
  canvas.addEventListener('dragleave', (e) => {
    if (!canvas.contains(e.relatedTarget)) removeDropIndicators();
  });
  canvas.addEventListener('drop', (e) => {
    if (!canvas.querySelector('.cb-section.cb-dragging')) return;
    e.preventDefault();
    removeDropIndicators();
    const dropIdx = getSectionDropIndex(canvas, e.clientY);
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      if (data.source === 'section') reorderSection(data.sectionId, dropIdx);
    } catch (err) { console.warn('Section drop error:', err); }
  });

  /* ── Cleanup draggable on mouseup ────────────────────────── */
  document.addEventListener('mouseup', () => {
    canvas.querySelectorAll('[draggable="true"]:not(.cb-dragging)').forEach(el => el.removeAttribute('draggable'));
  });
}

/* ─── Section drop helpers ───────────────────────────────────── */
function showSectionDropIndicator(canvas, clientY) {
  removeDropIndicators();
  const sections = [...canvas.querySelectorAll('.cb-section:not(.cb-dragging)')];
  let before = null;
  for (const s of sections) {
    const rect = s.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) { before = s; break; }
  }
  const ind = document.createElement('div');
  ind.className = 'cb-drop-indicator';
  if (before) canvas.insertBefore(ind, before);
  else canvas.appendChild(ind);
}

function getSectionDropIndex(canvas, clientY) {
  const sections = [...canvas.querySelectorAll('.cb-section:not(.cb-dragging)')];
  for (let i = 0; i < sections.length; i++) {
    const rect = sections[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return sections.length;
}

/* ─── Widget drop helpers ────────────────────────────────────── */
function showWidgetDropIndicator(area, clientY) {
  removeDropIndicators();
  const widgets = [...area.querySelectorAll('.cb-widget:not(.cb-dragging)')];
  let before = null;
  for (const w of widgets) {
    const rect = w.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) { before = w; break; }
  }
  const ind = document.createElement('div');
  ind.className = 'cb-drop-indicator';
  if (before) area.insertBefore(ind, before);
  else area.appendChild(ind);
}

function getWidgetDropIndex(area, clientY) {
  const widgets = [...area.querySelectorAll('.cb-widget:not(.cb-dragging)')];
  for (let i = 0; i < widgets.length; i++) {
    const rect = widgets[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return widgets.length;
}

function removeDropIndicators() {
  document.querySelectorAll('.cb-drop-indicator').forEach(el => el.remove());
}

/* ─── Widget DnD reorder (supports cross-section moves) ──────── */
function reorderWidgetDnD(widgetId, fromSectionId, toSectionId, newIndex) {
  const tab = getActiveTab();
  if (!tab) return;
  gatherContentFromDOM();
  const fromSec = (tab.sections || []).find(s => s.id === fromSectionId);
  const toSec = (tab.sections || []).find(s => s.id === toSectionId);
  if (!fromSec || !toSec) return;
  const oldIdx = (fromSec.widgets || []).findIndex(w => w.id === widgetId);
  if (oldIdx === -1) return;
  const [widget] = fromSec.widgets.splice(oldIdx, 1);
  toSec.widgets = toSec.widgets || [];
  // Adjust index if moving within same section
  const adj = (fromSectionId === toSectionId && newIndex > oldIdx) ? newIndex - 1 : newIndex;
  toSec.widgets.splice(Math.max(0, Math.min(adj, toSec.widgets.length)), 0, widget);
  markDirty();
  refreshCanvas();
}

/* ================================================================
   TAB MANAGEMENT
   ================================================================ */
function addTab() {
  const name = prompt('New tab name:', 'New Tab');
  if (!name || !name.trim()) return;
  gatherContentFromDOM();
  const tab = { id: genTabId(), name: name.trim(), sections: [] };
  _tabs.push(tab);
  _activeTabId = tab.id;
  markDirty();
  refreshCanvas();
}

function deleteTab(tabId) {
  if (_tabs.length <= 1) { alert('Cannot delete the last tab.'); return; }
  if (!confirm('Delete this tab and all its content?')) return;
  gatherContentFromDOM();
  _tabs = _tabs.filter(t => t.id !== tabId);
  if (_activeTabId === tabId) _activeTabId = _tabs[0]?.id;
  markDirty();
  refreshCanvas();
}

function renameTab(tabId) {
  const tab = _tabs.find(t => t.id === tabId);
  if (!tab) return;
  const newName = prompt('Tab name:', tab.name);
  if (newName && newName.trim() && newName.trim() !== tab.name) {
    tab.name = newName.trim();
    markDirty();
    refreshCanvas();
  }
}

function switchTab(tabId) {
  if (tabId === _activeTabId) return;
  gatherContentFromDOM();
  _activeTabId = tabId;
  refreshCanvas();
}

/* ================================================================
   SECTION MANAGEMENT
   ================================================================ */
function addSection(key) {
  const tab = getActiveTab();
  if (!tab) return;
  // Check uniqueness across all tabs
  if (getAllUsedSections().has(key)) return;
  gatherContentFromDOM();
  tab.sections = tab.sections || [];
  tab.sections.push({ key, id: genBlockId(), widgets: [] });
  markDirty();
  refreshCanvas();
}

function removeSection(sectionId) {
  const tab = getActiveTab();
  if (!tab) return;
  gatherContentFromDOM();
  tab.sections = (tab.sections || []).filter(s => s.id !== sectionId);
  markDirty();
  refreshCanvas();
}

function moveSection(sectionId, direction) {
  const tab = getActiveTab();
  if (!tab?.sections) return;
  gatherContentFromDOM();
  const idx = tab.sections.findIndex(s => s.id === sectionId);
  if (idx === -1) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= tab.sections.length) return;
  const [sec] = tab.sections.splice(idx, 1);
  tab.sections.splice(newIdx, 0, sec);
  markDirty();
  refreshCanvas();
}

function reorderSection(sectionId, newIndex) {
  const tab = getActiveTab();
  if (!tab?.sections) return;
  gatherContentFromDOM();
  const oldIdx = tab.sections.findIndex(s => s.id === sectionId);
  if (oldIdx === -1) return;
  const [sec] = tab.sections.splice(oldIdx, 1);
  const adj = newIndex > oldIdx ? newIndex - 1 : newIndex;
  tab.sections.splice(Math.max(0, Math.min(adj, tab.sections.length)), 0, sec);
  markDirty();
  refreshCanvas();
}

/* ================================================================
   WIDGET MANAGEMENT
   ================================================================ */
function addWidget(sectionId, kind) {
  const tab = getActiveTab();
  if (!tab) return;
  const sec = (tab.sections || []).find(s => s.id === sectionId);
  if (!sec) return;
  gatherContentFromDOM();
  sec.widgets = sec.widgets || [];
  const widget = { kind, id: genBlockId() };
  if (kind === 'text') widget.content = '';
  else if (kind === 'image') { widget.url = ''; widget.caption = ''; }
  else if (kind === 'video') { widget.url = ''; widget.caption = ''; }
  else if (kind === 'links') widget.items = [{ label: '', url: '' }];
  else if (kind === 'embed') widget.html = '';
  sec.widgets.push(widget);
  markDirty();
  refreshCanvas();
}

function removeWidget(widgetId) {
  const sec = findSectionForWidget(widgetId);
  if (!sec) return;
  gatherContentFromDOM();
  sec.widgets = (sec.widgets || []).filter(w => w.id !== widgetId);
  markDirty();
  refreshCanvas();
}

function moveWidget(widgetId, direction) {
  const sec = findSectionForWidget(widgetId);
  if (!sec?.widgets) return;
  gatherContentFromDOM();
  const idx = sec.widgets.findIndex(w => w.id === widgetId);
  if (idx === -1) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= sec.widgets.length) return;
  const [widget] = sec.widgets.splice(idx, 1);
  sec.widgets.splice(newIdx, 0, widget);
  markDirty();
  refreshCanvas();
}

/* ================================================================
   REFRESH
   ================================================================ */
function refreshCanvas() {
  const content = document.getElementById('class-page-content');
  if (!content) return;
  content.innerHTML = buildCanvasHTML();
  wireCanvas();
}

/* ================================================================
   CONTENT GATHERING (read DOM editors → module state)
   ================================================================ */
function gatherContentFromDOM() {
  // Text section fields (stored in _classData)
  document.querySelectorAll('.cb-textarea[data-field]').forEach(ta => {
    _classData[ta.dataset.field] = ta.value;
  });
  // Widget text
  document.querySelectorAll('.cb-widget-text').forEach(ta => {
    const w = findWidgetById(ta.dataset.widgetId);
    if (w) w.content = ta.value;
  });
  // Widget video
  document.querySelectorAll('.cb-video-url').forEach(inp => {
    const w = findWidgetById(inp.dataset.widgetId);
    if (w) w.url = inp.value;
  });
  document.querySelectorAll('.cb-video-caption').forEach(inp => {
    const w = findWidgetById(inp.dataset.widgetId);
    if (w) w.caption = inp.value;
  });
  // Widget image caption
  document.querySelectorAll('.cb-image-caption-input').forEach(inp => {
    const w = findWidgetById(inp.dataset.widgetId);
    if (w) w.caption = inp.value;
  });
  // Widget embed
  document.querySelectorAll('.cb-embed-editor').forEach(ta => {
    const w = findWidgetById(ta.dataset.widgetId);
    if (w) w.html = ta.value;
  });
  // Widget links
  document.querySelectorAll('.cb-links-editor').forEach(editor => {
    const w = findWidgetById(editor.dataset.widgetId);
    if (!w) return;
    w.items = [...editor.querySelectorAll('.cb-link-row')].map(row => ({
      label: row.querySelector('.cb-link-label')?.value || '',
      url: row.querySelector('.cb-link-url')?.value || ''
    }));
  });
}

/* ================================================================
   AUTOSAVE
   ================================================================ */
function markDirty() {
  _dirty = true;
  const st = document.getElementById('cb-autosave-status');
  if (st) { st.textContent = 'Unsaved'; st.className = 'cb-autosave-status cb-status-dirty'; }
}

function startAutosave() {
  stopAutosave();
  _autosaveTimer = setInterval(() => { if (_dirty) persistAll(); }, 30000);
}

function stopAutosave() {
  if (_autosaveTimer) { clearInterval(_autosaveTimer); _autosaveTimer = null; }
}

async function persistAll() {
  const st = document.getElementById('cb-autosave-status');
  if (st) { st.textContent = 'Saving...'; st.className = 'cb-autosave-status cb-status-saving'; }

  gatherContentFromDOM();

  try {
    const saveData = { id: _scheduleId, tabs: _tabs, sections: tabsToSections() };
    // Include text section content fields from all tabs
    _tabs.forEach(tab => {
      (tab.sections || []).forEach(sec => {
        const reg = SECTION_REG[sec.key];
        if (reg?.field && _classData[reg.field] !== undefined) saveData[reg.field] = _classData[reg.field];
      });
    });
    await ScheduleDB.saveSchedule(saveData);
    _dirty = false;
    if (st) { st.textContent = 'Saved'; st.className = 'cb-autosave-status cb-status-saved'; }
  } catch (e) {
    console.error('Autosave failed:', e);
    if (st) { st.textContent = 'Save failed'; st.className = 'cb-autosave-status cb-status-error'; }
  }
}

/* ================================================================
   SETTINGS MODAL
   ================================================================ */
function openSettings() {
  let modal = document.getElementById('cb-settings-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'cb-settings-modal';
  modal.className = 'cb-modal-overlay';
  const cd = _classData.classDates || {};
  const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const daysCheckboxes = DAY_NAMES.map((d, i) =>
    `<label class="settings-check"><input type="checkbox" value="${i}" ${(cd.daysOfWeek || []).includes(i) ? 'checked' : ''}> ${d}</label>`
  ).join('');

  modal.innerHTML = `
    <div class="cb-modal">
      <div class="cb-modal-header">
        <h3>Course Settings</h3>
        <button type="button" class="cb-modal-close">&times;</button>
      </div>
      <div class="cb-modal-body">
        <div class="form-group">
          <label>Title</label>
          <input type="text" id="cs-title" value="${esc(_classData.title || '')}" />
        </div>
        <div class="form-group">
          <label>Subtitle</label>
          <input type="text" id="cs-subtitle" value="${esc(_classData.subtitle || '')}" />
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div class="form-group">
            <label>Semester</label>
            <input type="text" id="cs-semester" value="${esc(_classData.semester || '')}" />
          </div>
          <div class="form-group">
            <label>Level</label>
            <input type="text" id="cs-level" value="${esc(_classData.level || '')}" placeholder="e.g., Graduate" />
          </div>
        </div>
        <div class="form-group">
          <label>Description</label>
          <textarea id="cs-description" rows="3">${esc(_classData.description || '')}</textarea>
        </div>
        <hr style="border-color:rgba(255,255,255,.08);margin:16px 0;" />
        <h4>Class Schedule</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div class="form-group">
            <label>Start Date</label>
            <input type="date" id="cs-start-date" value="${esc(cd.startDate || '')}" />
          </div>
          <div class="form-group">
            <label>End Date</label>
            <input type="date" id="cs-end-date" value="${esc(cd.endDate || '')}" />
          </div>
        </div>
        <div class="form-group">
          <label>Days of Week</label>
          <div id="cs-days" style="display:flex;gap:6px;flex-wrap:wrap;">${daysCheckboxes}</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
          <div class="form-group">
            <label>Start Time</label>
            <input type="time" id="cs-start-time" value="${esc(cd.startTime || '09:00')}" />
          </div>
          <div class="form-group">
            <label>End Time</label>
            <input type="time" id="cs-end-time" value="${esc(cd.endTime || '10:30')}" />
          </div>
          <div class="form-group">
            <label>Frequency</label>
            <select id="cs-frequency">
              <option value="weekly" ${cd.frequency === 'weekly' ? 'selected' : ''}>Weekly</option>
              <option value="biweekly" ${cd.frequency === 'biweekly' ? 'selected' : ''}>Biweekly</option>
              <option value="monthly" ${cd.frequency === 'monthly' ? 'selected' : ''}>Monthly</option>
              <option value="once" ${cd.frequency === 'once' ? 'selected' : ''}>One-time</option>
            </select>
          </div>
        </div>
        <hr style="border-color:rgba(255,255,255,.08);margin:16px 0;" />
        <div class="form-group">
          <label>Registration Link</label>
          <input type="url" id="cs-reg-link" value="${esc(_classData.registrationLink || '')}" placeholder="https://..." />
        </div>
        <div style="margin-top:16px;">
          <button type="button" id="cs-save-btn" class="btn btn-primary">Save Settings</button>
          <span id="cs-save-status" class="save-status"></span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('.cb-modal-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  document.getElementById('cs-save-btn').addEventListener('click', async () => {
    const st = document.getElementById('cs-save-status');
    st.textContent = 'Saving...';
    try {
      const daysOfWeek = [...document.querySelectorAll('#cs-days input:checked')].map(cb => parseInt(cb.value));
      const classDates = {
        startDate: document.getElementById('cs-start-date').value || '',
        endDate: document.getElementById('cs-end-date').value || '',
        daysOfWeek,
        startTime: document.getElementById('cs-start-time').value || '09:00',
        endTime: document.getElementById('cs-end-time').value || '10:30',
        frequency: document.getElementById('cs-frequency').value || 'weekly'
      };
      const updates = {
        id: _scheduleId,
        title: document.getElementById('cs-title').value.trim(),
        subtitle: document.getElementById('cs-subtitle').value.trim(),
        semester: document.getElementById('cs-semester').value.trim(),
        level: document.getElementById('cs-level').value.trim(),
        description: document.getElementById('cs-description').value.trim(),
        classDates,
        registrationLink: document.getElementById('cs-reg-link').value.trim()
      };
      await ScheduleDB.saveSchedule(updates);
      Object.assign(_classData, updates);
      const titleEl = document.getElementById('sched-title');
      const subtitleEl = document.getElementById('sched-subtitle');
      if (titleEl) titleEl.textContent = _classData.title || 'Schedule';
      if (subtitleEl) subtitleEl.innerHTML = esc(_classData.subtitle || '') + (_classData.semester ? ' &mdash; ' + esc(_classData.semester) : '');
      st.textContent = 'Saved!';
      setTimeout(() => modal.remove(), 1000);
    } catch (e) { st.textContent = 'Error: ' + e.message; }
  });
}

/* ================================================================
   SCHEDULER CONFIG
   ================================================================ */
function buildSchedulerConfig() {
  return {
    scheduleId: _scheduleId,
    schedule: _classData,
    speakers: _speakers,
    currentSpeaker: _currentSpeaker,
    viewType: _viewType,
    useKeyAuth: _useKeyAuth,
    adminViewMode: _adminViewMode,
    previewSpeakerIdx: _previewSpeakerIdx,
    buildInviteURL,
    onSaveSpeaker: async (id, data, isKeyAuth) => {
      if (isKeyAuth) await ScheduleDB.updateSpeakerByKey(id, data);
      else await ScheduleDB.updateSpeaker(id, data);
    },
    onSaveSchedule: async (data) => { await ScheduleDB.saveSchedule(data); },
    onAddSpeaker: async (data) => { await ScheduleDB.addSpeaker(data); },
    onDeleteSpeaker: async (id) => { await ScheduleDB.deleteSpeaker(id); },
    onRefresh: async () => { await wireClassPage(_scheduleId); },
    onSwitchView: (mode, speakerIdx) => {
      _adminViewMode = mode;
      _previewSpeakerIdx = speakerIdx || 0;
      refreshCanvas();
    }
  };
}

/* ================================================================
   EXPORTS
   ================================================================ */
McgheeLab.renderClassPage = renderClassPage;
McgheeLab.wireClassPage   = wireClassPage;
McgheeLab.ScheduleDB      = ScheduleDB;

})();
