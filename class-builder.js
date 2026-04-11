/* ================================================================
   class-builder.js  —  Course Builder (V3.13)
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
  exams:       { label: 'Exams',          component: 'files',   path: 'exams',     hasDue: true },
  modules:     { label: 'Learning Modules', component: 'modules' }
};

const WIDGET_REG = {
  text:       { label: 'Text Block' },
  image:      { label: 'Image' },
  video:      { label: 'Video' },
  links:      { label: 'Link List' },
  embed:      { label: 'Embed' },
  simulation: { label: 'Simulation' },
  divider:    { label: 'Divider' }
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
let _moduleManifest = null;  // Cached manifest.json for file picker

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
/** Escape for safe use inside HTML attribute values (escapes quotes too) */
function escAttr(s) { return (s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

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

function findSectionById(sectionId) {
  for (const tab of _tabs) {
    const sec = (tab.sections || []).find(s => s.id === sectionId);
    if (sec) return sec;
  }
  return null;
}

/* ─── Migration from legacy formats ─────────────────────────── */
function migrateLegacy(schedule) {
  // Ensure every section has name, collapsed, content, storagePath fields
  function ensureSectionFields(sec, schedule) {
    const reg = SECTION_REG[sec.key];
    if (!sec.name) sec.name = reg?.label || sec.key;
    if (sec.collapsed === undefined) sec.collapsed = false;
    // Migrate text content from schedule-level fields to per-section
    if (reg?.component === 'text' && sec.content === undefined) {
      sec.content = schedule[reg.field] || '';
    }
    // Migrate file storage path
    if (reg?.component === 'files' && !sec.storagePath) {
      sec.storagePath = reg.path || sec.key;
    }
    return sec;
  }

  if (schedule.tabs && schedule.tabs.length) {
    const tabs = JSON.parse(JSON.stringify(schedule.tabs));
    tabs.forEach(tab => {
      (tab.sections || []).forEach(sec => ensureSectionFields(sec, schedule));
    });
    return tabs;
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
  sections.forEach(sec => ensureSectionFields(sec, schedule));
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
    const path = sec.storagePath || SECTION_REG[sec.key]?.path || sec.key;
    try { _fileData[sec.id] = await ScheduleDB.getFiles(_scheduleId, path); } catch (e) { _fileData[sec.id] = []; }
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
    html += `<div class="cb-add-section-bar">
      <div class="cb-mobile-dropdown">
        <button type="button" class="btn btn-small" id="cb-add-section-btn">+ Section</button>
        <div class="cb-dropdown-menu" id="cb-section-dropdown">${buildSectionDropdownItems()}</div>
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
function buildSectionDropdownItems() {
  return Object.entries(SECTION_REG).map(([key, reg]) => {
    return `<button type="button" class="cb-dropdown-item" data-add-type="section" data-add-key="${key}">${esc(reg.label)}</button>`;
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
  const typeLabel = reg?.label || section.key;
  const displayName = section.name || typeLabel;
  const collapseIcon = section.collapsed ? '&#x25B6;' : '&#x25BC;';

  if (!editing) {
    // Public / preview: read-only section + widgets
    let html = `<div class="cb-section cb-section-readonly cb-section-type-${esc(section.key)}" data-section-id="${section.id}">`;
    html += `<div class="cb-section-header-row">
      <button type="button" class="cb-section-collapse-toggle" data-section-id="${section.id}" title="Collapse/expand">${collapseIcon}</button>
      <h3 class="cb-section-title-readonly">${esc(displayName)}</h3>
    </div>`;
    html += `<div class="cb-section-collapsible${section.collapsed ? ' cb-collapsed' : ''}" data-section-id="${section.id}">`;
    html += `<div class="cb-section-body">${renderSectionBody(section)}</div>`;
    (section.widgets || []).forEach(w => {
      const wBody = renderWidgetBody(w);
      if (wBody) {
        if (w.kind === 'divider') { html += '<hr class="cb-divider" />'; }
        else { html += `<div class="cb-widget cb-widget-readonly"><div class="cb-widget-body">${wBody}</div></div>`; }
      }
    });
    html += '</div>'; // close collapsible
    html += '</div>'; // close section
    return html;
  }

  // Admin editing: section chrome + body + widgets + add-widget
  let html = `<div class="cb-section cb-section-type-${esc(section.key)}" data-section-id="${section.id}" data-section-key="${section.key}">`;
  // Chrome bar
  html += `<div class="cb-section-chrome">
    <span class="cb-section-handle" title="Drag to reorder">&#x2801;&#x2801;</span>
    <button type="button" class="cb-section-collapse-toggle" data-section-id="${section.id}" title="Collapse/expand">${collapseIcon}</button>
    <span class="cb-section-label" title="Double-click to rename">${esc(displayName)}</span>
    <span class="cb-block-type-badge">${esc(typeLabel)}</span>
    <div class="cb-block-actions">
      <button type="button" class="cb-section-move" data-dir="up" title="Move up">&uarr;</button>
      <button type="button" class="cb-section-move" data-dir="down" title="Move down">&darr;</button>
      <button type="button" class="cb-section-remove" title="Remove section">&times;</button>
    </div>
  </div>`;
  // Collapsible body
  html += `<div class="cb-section-collapsible${section.collapsed ? ' cb-collapsed' : ''}" data-section-id="${section.id}">`;
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
  html += '</div>'; // close collapsible
  html += '</div>'; // close section
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
      const content = section.content || '';
      if (editing) {
        return `<textarea class="cb-textarea cb-section-text" data-section-id="${section.id}" rows="6" placeholder="Enter ${(section.name || reg.label).toLowerCase()} content...">${esc(content)}</textarea>
          <p class="muted-text" style="margin:4px 0 0;font-size:.75rem;">Plain text. URLs auto-link. Blank lines for paragraphs.</p>`;
      }
      return `<div class="text-preview">${renderText(content)}</div>`;
    }
    case 'files': {
      const files = _fileData[section.id] || [];
      const canUpload = editing || (_viewType === 'guest' && section.key === 'files');
      let html = '';
      if (canUpload) {
        html += `<div class="file-upload-area">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;">
            <div class="form-group" style="flex:2;min-width:200px;">
              <label>Upload File</label>
              <input type="file" class="cb-file-input" data-section-id="${section.id}" />
            </div>
            <div class="form-group" style="flex:1;min-width:150px;">
              <label>Description</label>
              <input type="text" class="cb-file-desc" placeholder="Brief description" />
            </div>
            ${reg.hasDue ? '<div class="form-group" style="min-width:140px;"><label>Due</label><input type="date" class="cb-file-due" /></div>' : ''}
            <button type="button" class="btn cb-file-upload-btn" data-section-id="${section.id}">Upload</button>
          </div>
          <div class="cb-file-status save-status"></div>
        </div>`;
      }
      html += `<div class="cb-file-list" data-section-id="${section.id}">${buildFileListHTML(files, reg)}</div>`;
      return html;
    }
    case 'speakers':
      return `<div id="cb-speakers-${section.id}">${McgheeLab.Scheduler?.render?.(buildSchedulerConfig()) || '<p class="muted-text">Scheduler not loaded.</p>'}</div>`;
    case 'modules':
      return renderModulesBody(editing);
    default:
      return '<p class="muted-text">Unknown component.</p>';
  }
}

/* ─── Learning Modules Section Body ────────────────────────── */
function renderModulesBody(editing) {
  const modules = (_classData.modules || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  if (editing) {
    let html = '<div class="cb-modules-manager">';

    if (modules.length) {
      modules.forEach((mod, i) => {
        const hwLabel = getHomeworkLabel(mod.homeworkFileId);
        html += `<div class="cb-mod-card" data-mod-id="${esc(mod.id)}">
          <div class="cb-mod-card-handle">
            <button type="button" class="btn btn-small btn-ghost cb-mod-move" data-dir="up" data-mod-id="${esc(mod.id)}" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
            <button type="button" class="btn btn-small btn-ghost cb-mod-move" data-dir="down" data-mod-id="${esc(mod.id)}" ${i === modules.length - 1 ? 'disabled' : ''}>&darr;</button>
          </div>
          <div class="cb-mod-card-body">
            <div class="cb-mod-card-top">
              <span class="cb-mod-card-num">${i + 1}</span>
              <strong class="cb-mod-card-title">${esc(mod.title || 'Untitled')}</strong>
              <span class="cb-mod-card-file muted-text">${esc(mod.folder ? mod.folder + '/' : '')}${esc(mod.htmlFile || '—')}</span>
              <label class="cb-mod-card-pub" title="Published">
                <input type="checkbox" class="cb-mod-published" data-mod-id="${esc(mod.id)}" ${mod.published ? 'checked' : ''} /> Visible
              </label>
            </div>
            <div class="cb-mod-card-bottom">
              <button type="button" class="btn btn-small btn-ghost cb-mod-edit-hw" data-mod-id="${esc(mod.id)}">Homework: ${hwLabel ? esc(hwLabel) : '<em>None</em>'}</button>
            </div>
          </div>
          <button type="button" class="btn btn-danger btn-small cb-mod-delete" data-mod-id="${esc(mod.id)}" title="Remove">&times;</button>
        </div>`;
      });
    } else {
      html += '<p class="muted-text" style="margin:0 0 12px;">No modules configured yet.</p>';
    }

    html += '<button type="button" class="btn btn-small cb-mod-add" style="margin-top:10px;">+ Add Module</button>';
    html += `<p class="muted-text" style="margin:8px 0 0;font-size:.75rem;">Run <code>python3 scripts/scan_modules.py</code> after adding new HTML files.</p>`;
    html += '</div>';
    return html;
  }

  // Public view: clickable module list
  const published = modules.filter(m => m.published);
  if (!published.length) return '<p class="muted-text">No modules available yet.</p>';

  let html = '<div class="cb-modules-list" style="display:flex;flex-direction:column;gap:6px;">';
  published.forEach((mod, i) => {
    const href = `#/classes/${encodeURIComponent(_scheduleId)}/modules/${encodeURIComponent(mod.htmlFile)}`;
    html += `<a href="${href}" class="cb-module-link" style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;text-decoration:none;color:var(--text,#eef2f7);transition:background .2s,border-color .2s;">
      <span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:rgba(91,174,209,.15);color:#5baed1;font-size:.8rem;font-weight:600;flex-shrink:0;">${i + 1}</span>
      <span style="font-weight:500;">${esc(mod.title || mod.htmlFile)}</span>
    </a>`;
  });
  html += '</div>';
  return html;
}

/** Get a display label for a homework file ID */
function getHomeworkLabel(fileId) {
  if (!fileId) return null;
  for (const tab of _tabs) {
    for (const sec of (tab.sections || [])) {
      const reg = SECTION_REG[sec.key];
      if (reg?.component === 'files' && reg.hasDue) {
        const files = _fileData[sec.id] || [];
        const f = files.find(x => x.id === fileId);
        if (f) return f.fileName || f.description || fileId;
      }
    }
  }
  return fileId;
}

/** Fetch and cache the module manifest */
async function loadManifest() {
  if (_moduleManifest) return _moduleManifest;
  try {
    const resp = await fetch('modules/manifest.json?_=' + Date.now());
    if (resp.ok) _moduleManifest = await resp.json();
  } catch (e) {
    console.warn('[ClassBuilder] Could not load modules/manifest.json:', e);
  }
  return _moduleManifest || { folders: {} };
}

/** Build a flat list of all module files from the manifest for searching/browsing */
function flattenManifest(manifest) {
  const items = [];
  for (const [folder, data] of Object.entries(manifest.folders || {})) {
    for (const file of (data.files || [])) {
      items.push({ folder, folderLabel: data.label || folder, name: file.name, title: file.title });
    }
  }
  return items;
}

/** Build a flat list of all homework files from classFiles for searching/browsing */
function flattenHomeworkFiles() {
  const items = [];
  for (const tab of _tabs) {
    for (const sec of (tab.sections || [])) {
      const reg = SECTION_REG[sec.key];
      if (reg?.component === 'files' && reg.hasDue) {
        const files = _fileData[sec.id] || [];
        for (const f of files) {
          items.push({
            id: f.id,
            label: (sec.name || reg.label) + ': ' + (f.fileName || f.description || f.id),
            fileName: f.fileName || '',
            section: sec.name || reg.label
          });
        }
      }
    }
  }
  return items;
}

/* ─── FILE PICKER MODAL ────────────────────────────────────── */
/**
 * Open a generic file picker modal. Works for both module files and homework files.
 * @param {Object} opts
 * @param {string} opts.title       - Modal heading
 * @param {Array}  opts.items       - Array of pickable items
 * @param {Function} opts.renderItem  - (item) => { html, searchText }
 * @param {Function} opts.onSelect    - (item) => void
 * @param {string} [opts.groupKey]  - Optional property to group items by (e.g. 'folder')
 * @param {string} [opts.groupLabel] - Optional property for group display name
 */
function openFilePicker(opts) {
  let modal = document.getElementById('cb-filepicker-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'cb-filepicker-modal';
  modal.className = 'cb-modal-overlay';

  const items = opts.items || [];
  const grouped = {};
  if (opts.groupKey) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const g = item[opts.groupKey] || 'Other';
      if (!grouped[g]) grouped[g] = { label: item[opts.groupLabel] || g, entries: [] };
      grouped[g].entries.push({ item, idx: i });
    }
  }

  let listHtml = '';
  if (opts.groupKey && Object.keys(grouped).length > 0) {
    for (const [gKey, gData] of Object.entries(grouped)) {
      listHtml += `<div class="cb-fp-group" data-group="${escAttr(gKey)}">
        <div class="cb-fp-group-label">${esc(gData.label)}</div>`;
      for (const entry of gData.entries) {
        const r = opts.renderItem(entry.item);
        listHtml += `<div class="cb-fp-item" data-fp-idx="${entry.idx}" data-search="${escAttr(r.searchText.toLowerCase())}">${r.html}</div>`;
      }
      listHtml += '</div>';
    }
  } else {
    for (let i = 0; i < items.length; i++) {
      const r = opts.renderItem(items[i]);
      listHtml += `<div class="cb-fp-item" data-fp-idx="${i}" data-search="${escAttr(r.searchText.toLowerCase())}">${r.html}</div>`;
    }
  }

  if (!items.length) {
    listHtml = '<p class="muted-text" style="padding:1rem;text-align:center;">No files found. Run <code>python3 scripts/scan_modules.py</code> to refresh.</p>';
  }

  modal.innerHTML = `
    <div class="cb-modal cb-fp-modal">
      <div class="cb-modal-header">
        <h3>${esc(opts.title || 'Select File')}</h3>
        <button type="button" class="cb-modal-close">&times;</button>
      </div>
      <div class="cb-fp-search-wrap">
        <input type="text" id="cb-fp-search" class="cb-fp-search" placeholder="Search files..." autofocus />
      </div>
      <div class="cb-fp-list" id="cb-fp-list">
        ${listHtml}
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Close handlers
  modal.querySelector('.cb-modal-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  // Search filtering
  const searchInput = modal.querySelector('#cb-fp-search');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    modal.querySelectorAll('.cb-fp-item').forEach(el => {
      const match = !q || el.dataset.search.includes(q);
      el.style.display = match ? '' : 'none';
    });
    // Hide empty groups
    modal.querySelectorAll('.cb-fp-group').forEach(g => {
      const visible = g.querySelectorAll('.cb-fp-item[style=""], .cb-fp-item:not([style])');
      // Check if any child items are visible
      let anyVisible = false;
      g.querySelectorAll('.cb-fp-item').forEach(item => {
        if (item.style.display !== 'none') anyVisible = true;
      });
      g.style.display = anyVisible ? '' : 'none';
    });
  });

  // Item click
  modal.querySelectorAll('.cb-fp-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.fpIdx);
      if (!isNaN(idx)) { opts.onSelect(items[idx]); modal.remove(); }
    });
  });

  // Focus search
  setTimeout(() => searchInput.focus(), 50);
}

/* ─── ADD MODULE MODAL ─────────────────────────────────────── */
async function openAddModuleModal() {
  const manifest = await loadManifest();
  const allFiles = flattenManifest(manifest);

  let modal = document.getElementById('cb-addmod-modal');
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'cb-addmod-modal';
  modal.className = 'cb-modal-overlay';

  // Build folder-organized dropdown options
  let optionsHtml = '<option value="">— Select a file —</option>';
  for (const [folder, data] of Object.entries(manifest.folders || {})) {
    optionsHtml += `<optgroup label="${esc(data.label || folder)}">`;
    for (const file of (data.files || [])) {
      optionsHtml += `<option value="${escAttr(folder + '/' + file.name)}" data-title="${escAttr(file.title)}">${esc(file.name)}</option>`;
    }
    optionsHtml += '</optgroup>';
  }

  modal.innerHTML = `
    <div class="cb-modal cb-addmod-modal">
      <div class="cb-modal-header">
        <h3>Add Learning Module</h3>
        <button type="button" class="cb-modal-close">&times;</button>
      </div>
      <div class="cb-modal-body">
        <div class="form-group">
          <label>Lesson Title</label>
          <input type="text" id="cb-addmod-title" placeholder="e.g. Introduction to Microfluidics" />
        </div>
        <div class="form-group">
          <label>Module File</label>
          <select id="cb-addmod-dropdown">${optionsHtml}</select>
        </div>
        <div class="form-group">
          <label style="margin-bottom:4px;">Or search all files</label>
          <input type="text" id="cb-addmod-search" placeholder="Type to search..." />
          <div class="cb-addmod-results" id="cb-addmod-results"></div>
        </div>
        <div class="cb-addmod-selected" id="cb-addmod-selected" style="display:none;">
          <span class="muted-text">Selected:</span> <strong id="cb-addmod-sel-label"></strong>
        </div>
      </div>
      <div class="cb-modal-footer">
        <button type="button" class="btn btn-secondary cb-modal-close">Cancel</button>
        <button type="button" class="btn btn-primary" id="cb-addmod-confirm">Add Module</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  let selectedFile = null; // { folder, name, title }

  const titleInput = modal.querySelector('#cb-addmod-title');
  const dropdown = modal.querySelector('#cb-addmod-dropdown');
  const searchInput = modal.querySelector('#cb-addmod-search');
  const resultsDiv = modal.querySelector('#cb-addmod-results');
  const selectedDiv = modal.querySelector('#cb-addmod-selected');
  const selLabel = modal.querySelector('#cb-addmod-sel-label');

  function selectFile(folder, name, title) {
    selectedFile = { folder, name, title };
    selLabel.textContent = folder + '/' + name;
    selectedDiv.style.display = '';
    if (!titleInput.value.trim()) titleInput.value = title || '';
    // Reset search
    searchInput.value = '';
    resultsDiv.innerHTML = '';
  }

  // Dropdown change
  dropdown.addEventListener('change', () => {
    const val = dropdown.value;
    if (!val) return;
    const [folder, ...rest] = val.split('/');
    const name = rest.join('/');
    const opt = dropdown.selectedOptions[0];
    selectFile(folder, name, opt?.dataset.title || '');
  });

  // Search
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    if (!q) { resultsDiv.innerHTML = ''; return; }
    const matches = allFiles.filter(f =>
      f.name.toLowerCase().includes(q) ||
      f.title.toLowerCase().includes(q) ||
      f.folder.toLowerCase().includes(q) ||
      f.folderLabel.toLowerCase().includes(q)
    ).slice(0, 20);

    if (!matches.length) {
      resultsDiv.innerHTML = '<div class="cb-addmod-noresult muted-text">No matches</div>';
      return;
    }

    resultsDiv.innerHTML = matches.map(f =>
      `<div class="cb-fp-item cb-addmod-result-item" data-folder="${escAttr(f.folder)}" data-name="${escAttr(f.name)}" data-title="${escAttr(f.title)}">
        <span class="cb-fp-item-folder">${esc(f.folderLabel)}</span>
        <span class="cb-fp-item-name">${esc(f.name)}</span>
        <span class="cb-fp-item-title muted-text">${esc(f.title)}</span>
      </div>`
    ).join('');

    resultsDiv.querySelectorAll('.cb-addmod-result-item').forEach(el => {
      el.addEventListener('click', () => selectFile(el.dataset.folder, el.dataset.name, el.dataset.title));
    });
  });

  // Close
  modal.querySelectorAll('.cb-modal-close').forEach(el => el.addEventListener('click', () => modal.remove()));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  // Confirm
  modal.querySelector('#cb-addmod-confirm').addEventListener('click', () => {
    if (!selectedFile) { alert('Please select a module file.'); return; }
    const title = titleInput.value.trim() || selectedFile.title || selectedFile.name;
    gatherContentFromDOM();
    if (!_classData.modules) _classData.modules = [];
    const maxOrder = _classData.modules.reduce((mx, m) => Math.max(mx, m.order ?? 0), -1);
    _classData.modules.push({
      id: 'mod_' + generateKey().slice(0, 8),
      title,
      htmlFile: selectedFile.name,
      folder: selectedFile.folder,
      order: maxOrder + 1,
      homeworkFileId: null,
      published: true
    });
    markDirty();
    modal.remove();
    refreshCanvas();
  });

  setTimeout(() => titleInput.focus(), 50);
}

/* ─── HOMEWORK PICKER MODAL ────────────────────────────────── */
function openHomeworkPicker(modId) {
  const hwFiles = flattenHomeworkFiles();
  const mod = (_classData.modules || []).find(m => m.id === modId);
  if (!mod) return;

  openFilePicker({
    title: 'Link Homework',
    items: hwFiles,
    groupKey: 'section',
    groupLabel: 'section',
    renderItem: (item) => ({
      html: `<span class="cb-fp-item-name">${esc(item.fileName)}</span>
             <span class="cb-fp-item-title muted-text">${esc(item.section)}</span>`,
      searchText: item.label + ' ' + item.fileName
    }),
    onSelect: (item) => {
      gatherContentFromDOM();
      mod.homeworkFileId = item.id;
      markDirty();
      refreshCanvas();
    }
  });
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
    case 'simulation': {
      const code = widget.code || '';
      const title = widget.title || '';
      const lang = widget.lang || 'html';
      const srcdocFn = lang === 'python' ? buildPythonSrcdoc : buildSimSrcdoc;
      if (editing) {
        let html = `<input type="text" class="cb-sim-title" data-widget-id="${widget.id}" placeholder="Simulation title (optional)" value="${esc(title)}" style="width:100%;margin-bottom:8px;" />`;
        html += `<div style="margin-bottom:8px;">
          <label class="muted-text" style="font-size:.75rem;margin-right:6px;">Language:</label>
          <select class="cb-sim-lang" data-widget-id="${widget.id}" style="font-size:.82rem;padding:3px 6px;border-radius:4px;background:rgba(255,255,255,.08);color:var(--text,#eef2f7);border:1px solid rgba(255,255,255,.12);">
            <option value="html"${lang === 'html' ? ' selected' : ''}>HTML / JavaScript</option>
            <option value="python"${lang === 'python' ? ' selected' : ''}>Python (Pyodide)</option>
          </select>
        </div>`;
        const placeholder = lang === 'python'
          ? 'Write Python code here...\n\nprint(), matplotlib, numpy, and scipy are supported.\nUse SimExport.log(label, value) to let students export data.'
          : 'Paste HTML + JavaScript simulation code here...\n\nTip: Use SimExport.log(label, value) inside your code to let students export data.';
        html += `<textarea class="cb-textarea cb-sim-code" data-widget-id="${widget.id}" rows="12" placeholder="${escAttr(placeholder)}">${esc(code)}</textarea>`;
        html += `<p class="muted-text" style="margin:4px 0 0;font-size:.75rem;">${lang === 'python' ? 'Python code. Runs via Pyodide (WebAssembly CPython) in a sandboxed iframe.' : 'HTML + JS simulation code. Runs in a sandboxed iframe. Students can edit a local copy.'}</p>`;
        if (code) {
          html += `<div class="cb-sim-admin-preview" style="margin-top:12px;">
            <p class="muted-text" style="font-size:.75rem;margin-bottom:4px;">Preview:</p>
            <div class="cb-sim-container" data-widget-id="${widget.id}">
              <iframe class="cb-sim-iframe" data-widget-id="${widget.id}" sandbox="allow-scripts" srcdoc="${escAttr(srcdocFn(code, widget.id))}" style="width:100%;height:400px;border:1px solid rgba(255,255,255,.15);border-radius:8px;background:#fff;"></iframe>
            </div>
          </div>`;
        }
        return html;
      }
      // Public / student view
      if (!code) return '';
      let html = '';
      if (title) html += `<h4 class="cb-sim-view-title">${esc(title)}</h4>`;
      html += `<div class="cb-sim-container" data-widget-id="${widget.id}" data-lang="${lang}">
        <div class="cb-sim-toolbar">
          <button type="button" class="btn btn-small cb-sim-toggle-code" data-widget-id="${widget.id}" title="Edit code locally">Edit Code</button>
          <button type="button" class="btn btn-small cb-sim-run" data-widget-id="${widget.id}" title="Re-run simulation">Run</button>
          <button type="button" class="btn btn-small cb-sim-reset" data-widget-id="${widget.id}" title="Reset to original code">Reset</button>
          <button type="button" class="btn btn-small cb-sim-export" data-widget-id="${widget.id}" title="Export simulation data as CSV">Export Data</button>
          <button type="button" class="btn btn-small cb-sim-fullscreen" data-widget-id="${widget.id}" title="Fullscreen">&#x26F6; Fullscreen</button>
        </div>
        <div class="cb-sim-code-panel" data-widget-id="${widget.id}" style="display:none;">
          <textarea class="cb-textarea cb-sim-student-code" data-widget-id="${widget.id}" rows="10">${esc(code)}</textarea>
        </div>
        <iframe class="cb-sim-iframe" data-widget-id="${widget.id}" sandbox="allow-scripts" srcdoc="${escAttr(srcdocFn(code, widget.id))}" style="width:100%;height:500px;border:1px solid rgba(255,255,255,.15);border-radius:8px;background:#fff;"></iframe>
      </div>`;
      return html;
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

/* ─── Simulation helpers ────────────────────────────────────── */

/** Wrap user simulation code with the SimExport bridge preamble */
function buildSimSrcdoc(code, widgetId) {
  const wid = widgetId || '';
  const preamble = `<script>
window.SimExport = {
  _data: [],
  log: function(label, value) {
    this._data.push({ label: String(label), value: value, t: Date.now() });
  },
  _flush: function() {
    parent.postMessage({ type: 'sim-export', widgetId: '${wid}', data: JSON.parse(JSON.stringify(this._data)) }, '*');
  }
};
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'sim-flush') SimExport._flush();
});
<\/script>`;
  // If the code contains <head>, inject preamble after <head>
  if (/<head[^>]*>/i.test(code)) {
    return code.replace(/<head[^>]*>/i, '$&' + preamble);
  }
  // Otherwise prepend
  return preamble + code;
}

/** Build srcdoc for Python code using Pyodide (WebAssembly CPython) */
function buildPythonSrcdoc(code, widgetId) {
  const wid = widgetId || '';
  // Encode the Python code as base64 to avoid any escaping issues
  const codeB64 = btoa(unescape(encodeURIComponent(code)));
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'SF Mono','Fira Code','Consolas',monospace; font-size:14px; background:#1e1e2e; color:#cdd6f4; padding:12px; }
  #status { color:#a6adc8; margin-bottom:8px; }
  #output { white-space:pre-wrap; word-wrap:break-word; line-height:1.5; }
  .err { color:#f38ba8; }
  .plot-img { max-width:100%; border-radius:6px; margin:8px 0; background:#fff; }
</style>
</head><body>
<div id="status">Loading Python runtime...</div>
<div id="output"></div>
<script>
window.SimExport = {
  _data: [],
  log: function(label, value) {
    this._data.push({ label: String(label), value: value, t: Date.now() });
  },
  _flush: function() {
    parent.postMessage({ type: 'sim-export', widgetId: '${wid}', data: JSON.parse(JSON.stringify(this._data)) }, '*');
  }
};
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'sim-flush') SimExport._flush();
});

var _out = document.getElementById('output');
var _status = document.getElementById('status');

function appendOutput(text, cls) {
  var span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  _out.appendChild(span);
}

async function runPython() {
  _out.innerHTML = '';
  _status.textContent = 'Loading Pyodide...';
  try {
    if (!window.loadPyodide) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/pyodide/v0.27.5/full/pyodide.js';
      document.head.appendChild(s);
      await new Promise(function(r,j){ s.onload=r; s.onerror=function(){j(new Error('Failed to load Pyodide'))}; });
    }
    _status.textContent = 'Initializing Python...';
    var pyodide = await loadPyodide();
    _status.textContent = 'Installing packages...';
    await pyodide.loadPackage(['micropip']);
    // Pre-load common scientific packages
    var code = atob('${codeB64}');
    var needsNumpy = /\\b(numpy|np)\\b/.test(code);
    var needsMatplotlib = /\\b(matplotlib|plt)\\b/.test(code);
    var needsScipy = /\\bscipy\\b/.test(code);
    var pkgs = [];
    if (needsNumpy) pkgs.push('numpy');
    if (needsMatplotlib) pkgs.push('matplotlib');
    if (needsScipy) pkgs.push('scipy');
    if (pkgs.length) {
      _status.textContent = 'Installing ' + pkgs.join(', ') + '...';
      await pyodide.loadPackage(pkgs);
    }
    // Redirect stdout/stderr
    pyodide.runPython(\`
import sys, io
class _Out:
    def __init__(self, is_err=False):
        self.is_err = is_err
    def write(self, text):
        if text:
            from js import appendOutput
            appendOutput(text, 'err' if self.is_err else '')
    def flush(self): pass
sys.stdout = _Out()
sys.stderr = _Out(True)
\`);
    // Provide SimExport bridge to Python
    pyodide.runPython(\`
from js import window
class SimExport:
    @staticmethod
    def log(label, value):
        window.SimExport.log(str(label), float(value) if isinstance(value,(int,float)) else str(value))
\`);
    // If matplotlib is loaded, set up non-interactive backend + auto-show
    if (needsMatplotlib) {
      pyodide.runPython(\`
import matplotlib
matplotlib.use('AGG')
import matplotlib.pyplot as plt
_orig_show = plt.show
def _patched_show(*a, **kw):
    import io, base64
    from js import document
    for fig_num in plt.get_fignums():
        fig = plt.figure(fig_num)
        buf = io.BytesIO()
        fig.savefig(buf, format='png', dpi=100, bbox_inches='tight', facecolor='white')
        buf.seek(0)
        b64 = base64.b64encode(buf.read()).decode()
        img = document.createElement('img')
        img.src = 'data:image/png;base64,' + b64
        img.className = 'plot-img'
        document.getElementById('output').appendChild(img)
    plt.close('all')
plt.show = _patched_show
\`);
    }
    _status.textContent = 'Running...';
    await pyodide.runPythonAsync(code);
    // Auto-show any remaining matplotlib figures
    if (needsMatplotlib) {
      await pyodide.runPythonAsync(\`
import matplotlib.pyplot as plt
if plt.get_fignums():
    plt.show()
\`);
    }
    _status.textContent = 'Done.';
    setTimeout(function(){ _status.style.display='none'; }, 1500);
  } catch(err) {
    _status.textContent = 'Error';
    appendOutput(err.message || String(err), 'err');
  }
}
runPython();
<\/script>
</body></html>`;
}

/** Store per-widget export data from simulations */
const _simExportData = {};

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
  // Wire collapse toggles and section rename (always, for both admin and readonly)
  wireSectionCollapse();
  if (isEditing()) wireSectionRename();
  // Wire speakers sections if present in active tab
  const tab = getActiveTab();
  (tab?.sections || []).filter(s => s.key === 'speakers').forEach(sec => {
    try { McgheeLab.Scheduler?.wire?.('cb-speakers-' + sec.id, buildSchedulerConfig()); } catch (e) { console.warn('Scheduler wire error:', e); }
  });
  // Wire simulation widgets (works in both admin preview and public view)
  wireSimulations();
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

/* ─── Section Collapse ───────────────────────────────────────── */
function wireSectionCollapse() {
  document.querySelectorAll('.cb-section-collapse-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sectionId = btn.dataset.sectionId;
      const sec = findSectionById(sectionId);
      if (!sec) return;
      sec.collapsed = !sec.collapsed;
      // Find collapsible wrapper within the same parent section element
      const sectionEl = btn.closest('.cb-section');
      const collapsible = sectionEl?.querySelector('.cb-section-collapsible');
      if (collapsible) collapsible.classList.toggle('cb-collapsed', sec.collapsed);
      btn.innerHTML = sec.collapsed ? '&#x25B6;' : '&#x25BC;';
      if (isEditing()) markDirty();
    });
  });
}

/* ─── Section Rename ─────────────────────────────────────────── */
function wireSectionRename() {
  document.querySelectorAll('.cb-section-label').forEach(span => {
    span.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const secId = span.closest('.cb-section')?.dataset.sectionId;
      if (secId) renameSection(secId);
    });
  });
}

function renameSection(sectionId) {
  const sec = findSectionById(sectionId);
  if (!sec) return;
  const newName = prompt('Section name:', sec.name);
  if (newName && newName.trim() && newName.trim() !== sec.name) {
    sec.name = newName.trim();
    markDirty();
    refreshCanvas();
  }
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
  document.querySelectorAll('.cb-textarea, .cb-widget-text, .cb-video-url, .cb-video-caption, .cb-image-caption-input, .cb-embed-editor, .cb-sim-code, .cb-sim-title, .cb-link-label, .cb-link-url').forEach(el => {
    el.addEventListener('input', () => markDirty());
  });
  // Language selector — gather + refresh so placeholder and preview update
  document.querySelectorAll('.cb-sim-lang').forEach(sel => {
    sel.addEventListener('change', () => { gatherContentFromDOM(); markDirty(); refreshCanvas(); });
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

  // Module editors
  wireModuleEditors();
}

/* ─── Module Editor Wiring ────────────────────────────────────── */
function wireModuleEditors() {
  // Published checkbox
  document.querySelectorAll('.cb-mod-published').forEach(el => {
    el.addEventListener('change', () => markDirty());
  });

  // Add module — open modal
  document.querySelectorAll('.cb-mod-add').forEach(btn => {
    btn.addEventListener('click', () => openAddModuleModal());
  });

  // Edit homework — open picker
  document.querySelectorAll('.cb-mod-edit-hw').forEach(btn => {
    btn.addEventListener('click', () => openHomeworkPicker(btn.dataset.modId));
  });

  // Delete module
  document.querySelectorAll('.cb-mod-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const modId = btn.dataset.modId;
      if (!confirm('Remove this module?')) return;
      gatherContentFromDOM();
      _classData.modules = (_classData.modules || []).filter(m => m.id !== modId);
      markDirty();
      refreshCanvas();
    });
  });

  // Move module up/down
  document.querySelectorAll('.cb-mod-move').forEach(btn => {
    btn.addEventListener('click', () => {
      const modId = btn.dataset.modId;
      const dir = btn.dataset.dir;
      gatherContentFromDOM();
      const modules = (_classData.modules || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const idx = modules.findIndex(m => m.id === modId);
      if (idx < 0) return;
      const swapIdx = dir === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= modules.length) return;
      const tmpOrder = modules[idx].order;
      modules[idx].order = modules[swapIdx].order;
      modules[swapIdx].order = tmpOrder;
      markDirty();
      refreshCanvas();
    });
  });

  // Pre-load manifest in background for fast modal open
  loadManifest();
}

/* ─── Simulation Wiring (public + admin) ────────────────────── */
function wireSimulations() {
  // Listen for export data from simulation iframes
  if (!window._simMessageListenerAttached) {
    window._simMessageListenerAttached = true;
    window.addEventListener('message', (e) => {
      if (e.data?.type === 'sim-export' && e.data.widgetId) {
        _simExportData[e.data.widgetId] = e.data.data || [];
        downloadSimCSV(e.data.widgetId);
      }
    });
  }

  // Toggle code editor panel
  document.querySelectorAll('.cb-sim-toggle-code').forEach(btn => {
    btn.addEventListener('click', () => {
      const wid = btn.dataset.widgetId;
      const panel = btn.closest('.cb-sim-container')?.querySelector('.cb-sim-code-panel[data-widget-id="' + wid + '"]');
      if (!panel) return;
      const visible = panel.style.display !== 'none';
      panel.style.display = visible ? 'none' : 'block';
      btn.textContent = visible ? 'Edit Code' : 'Hide Code';
    });
  });

  // Run button — re-render iframe with student's edited code
  document.querySelectorAll('.cb-sim-run').forEach(btn => {
    btn.addEventListener('click', () => {
      const wid = btn.dataset.widgetId;
      const container = btn.closest('.cb-sim-container');
      const ta = container?.querySelector('.cb-sim-student-code[data-widget-id="' + wid + '"]');
      const iframe = container?.querySelector('.cb-sim-iframe[data-widget-id="' + wid + '"]');
      if (!ta || !iframe) return;
      const lang = container.dataset.lang || 'html';
      const fn = lang === 'python' ? buildPythonSrcdoc : buildSimSrcdoc;
      iframe.srcdoc = fn(ta.value, wid);
      _simExportData[wid] = [];
    });
  });

  // Reset button — restore original admin code
  document.querySelectorAll('.cb-sim-reset').forEach(btn => {
    btn.addEventListener('click', () => {
      const wid = btn.dataset.widgetId;
      const widget = findWidgetById(wid);
      if (!widget) return;
      const container = btn.closest('.cb-sim-container');
      const ta = container?.querySelector('.cb-sim-student-code[data-widget-id="' + wid + '"]');
      const iframe = container?.querySelector('.cb-sim-iframe[data-widget-id="' + wid + '"]');
      if (ta) ta.value = widget.code || '';
      if (iframe) {
        const lang = container?.dataset.lang || widget.lang || 'html';
        const fn = lang === 'python' ? buildPythonSrcdoc : buildSimSrcdoc;
        iframe.srcdoc = fn(widget.code || '', wid);
      }
      _simExportData[wid] = [];
    });
  });

  // Export data button — ask iframe to flush, then download
  document.querySelectorAll('.cb-sim-export').forEach(btn => {
    btn.addEventListener('click', () => {
      const wid = btn.dataset.widgetId;
      const container = btn.closest('.cb-sim-container');
      const iframe = container?.querySelector('.cb-sim-iframe[data-widget-id="' + wid + '"]');
      if (!iframe?.contentWindow) { alert('Simulation not loaded.'); return; }
      // Tell iframe to flush its data
      iframe.contentWindow.postMessage({ type: 'sim-flush' }, '*');
      // Data will arrive via the message listener above → triggers downloadSimCSV
    });
  });

  // Fullscreen button
  document.querySelectorAll('.cb-sim-fullscreen').forEach(btn => {
    btn.addEventListener('click', () => {
      const container = btn.closest('.cb-sim-container');
      if (!container) return;
      if (container.requestFullscreen) container.requestFullscreen();
      else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen();
    });
  });

  // srcdoc is now set inline via escAttr() in the HTML — no post-render patching needed.
}

/** Convert simulation export data to CSV and trigger download */
function downloadSimCSV(widgetId) {
  const data = _simExportData[widgetId];
  if (!data || !data.length) { alert('No data exported from this simulation yet.\n\nUse SimExport.log(label, value) in your simulation code to log data.'); return; }
  const headers = ['timestamp', 'label', 'value'];
  let csv = headers.join(',') + '\n';
  data.forEach(row => {
    csv += [row.t, '"' + String(row.label).replace(/"/g, '""') + '"', row.value].join(',') + '\n';
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const widget = findWidgetById(widgetId);
  a.download = (widget?.title || 'simulation') + '_data.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
  const sectionId = btn.dataset.sectionId;
  const sec = findSectionById(sectionId);
  const sectionEl = btn.closest('.cb-section');
  const fileInput = sectionEl?.querySelector('.cb-file-input');
  const file = fileInput?.files?.[0];
  if (!file) { alert('Select a file first.'); return; }
  if (file.size > 50 * 1024 * 1024) { alert('File too large (50 MB max).'); return; }

  const reg = sec ? SECTION_REG[sec.key] : null;
  const filePath = sec?.storagePath || reg?.path || sec?.key || sectionId;
  const st = sectionEl.querySelector('.cb-file-status');
  if (st) st.textContent = 'Uploading...';
  const storagePath = `classes/${_scheduleId}/${filePath}/${Date.now()}_${file.name}`;

  try {
    const ref = firebase.storage().ref(storagePath);
    await ref.put(file);
    const url = await ref.getDownloadURL();
    const Auth = McgheeLab.Auth;
    await ScheduleDB.addFile({
      classId: _scheduleId, section: filePath,
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
    _fileData[sectionId] = await ScheduleDB.getFiles(_scheduleId, filePath);
    const listEl = sectionEl.querySelector('.cb-file-list');
    if (listEl) {
      listEl.innerHTML = buildFileListHTML(_fileData[sectionId], reg);
      listEl.querySelectorAll('.cb-file-delete').forEach(b => b.addEventListener('click', () => handleFileDelete(b)));
    }
  } catch (e) { if (st) st.textContent = 'Upload failed.'; console.error(e); }
}

async function handleFileDelete(btn) {
  if (!confirm('Delete this file?')) return;
  const sectionEl = btn.closest('.cb-section');
  const sectionId = sectionEl?.dataset.sectionId;
  const sec = sectionId ? findSectionById(sectionId) : null;
  const listEl = sectionEl?.querySelector('.cb-file-list');
  try {
    await ScheduleDB.deleteFile(btn.dataset.fileId, btn.dataset.storagePath);
    if (sec) {
      const reg = SECTION_REG[sec.key];
      const filePath = sec.storagePath || reg?.path || sec.key;
      _fileData[sectionId] = await ScheduleDB.getFiles(_scheduleId, filePath);
      if (listEl) {
        listEl.innerHTML = buildFileListHTML(_fileData[sectionId], reg);
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
  const reg = SECTION_REG[key];
  const defaultName = reg?.label || key;
  const name = prompt('Section name:', defaultName);
  if (!name || !name.trim()) return;
  gatherContentFromDOM();
  tab.sections = tab.sections || [];
  const sec = { key, id: genBlockId(), name: name.trim(), collapsed: false, widgets: [], content: '' };
  if (reg?.component === 'files') sec.storagePath = sec.id;
  tab.sections.push(sec);
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
  else if (kind === 'simulation') { widget.code = ''; widget.title = ''; widget.lang = 'html'; }
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
  // Text section content (stored per-section on section object)
  document.querySelectorAll('.cb-section-text[data-section-id]').forEach(ta => {
    const sec = findSectionById(ta.dataset.sectionId);
    if (sec) sec.content = ta.value;
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
  // Widget simulation
  document.querySelectorAll('.cb-sim-code').forEach(ta => {
    const w = findWidgetById(ta.dataset.widgetId);
    if (w) w.code = ta.value;
  });
  document.querySelectorAll('.cb-sim-title').forEach(inp => {
    const w = findWidgetById(inp.dataset.widgetId);
    if (w) w.title = inp.value;
  });
  document.querySelectorAll('.cb-sim-lang').forEach(sel => {
    const w = findWidgetById(sel.dataset.widgetId);
    if (w) w.lang = sel.value;
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
  // Learning modules — only published checkbox is editable inline
  document.querySelectorAll('.cb-mod-published[data-mod-id]').forEach(cb => {
    const mod = (_classData.modules || []).find(m => m.id === cb.dataset.modId);
    if (mod) mod.published = cb.checked;
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
    const saveData = { id: _scheduleId, tabs: _tabs, sections: tabsToSections(), modules: _classData.modules || [] };
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
   MODULE VIEWER — iframe wrapper for standalone lesson HTML files
   Route: #/classes/{classId}/modules/{filename}
   ================================================================ */
function renderModuleViewer(classId, moduleFile) {
  // iframe src is set by wireModuleViewer after looking up the folder from Firestore
  return `
    <div class="cb-module-viewer-page">
      <div class="cb-module-nav-bar" id="cb-module-nav-bar">
        <a href="#/classes/${esc(classId)}" class="cb-module-back">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          <span id="cb-module-class-title">Back to Class</span>
        </a>
        <div class="cb-module-center">
          <span class="cb-module-progress" id="cb-module-progress"></span>
          <span class="cb-module-title" id="cb-module-title"></span>
        </div>
        <div class="cb-module-nav" id="cb-module-nav"></div>
      </div>
      <div class="cb-module-iframe-wrap">
        <iframe
          id="cb-module-iframe"
          class="cb-module-iframe"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        ></iframe>
      </div>
    </div>
  `;
}

async function wireModuleViewer(classId, moduleFile) {
  const db = McgheeLab.db;
  if (!db) return;

  try {
    const doc = await db.collection('schedules').doc(classId).get();
    if (!doc.exists) return;

    const schedule = doc.data();
    const modules = (schedule.modules || [])
      .filter(m => m.published)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const currentIdx = modules.findIndex(m => m.htmlFile === moduleFile);
    const current = currentIdx >= 0 ? modules[currentIdx] : null;
    const prev = currentIdx > 0 ? modules[currentIdx - 1] : null;
    const next = (currentIdx >= 0 && currentIdx < modules.length - 1) ? modules[currentIdx + 1] : null;

    // Set iframe src using the folder from the module data
    const iframe = document.getElementById('cb-module-iframe');
    if (iframe) {
      const folder = current?.folder || classId;
      iframe.src = `modules/${encodeURIComponent(folder)}/${encodeURIComponent(moduleFile)}`;
      iframe.addEventListener('load', () => {
        try {
          const h = iframe.contentDocument?.documentElement?.scrollHeight;
          if (h) iframe.style.height = h + 'px';
        } catch (e) {
          iframe.style.height = 'calc(100vh - 60px)';
        }
      });
    }

    // Class title
    const titleEl = document.getElementById('cb-module-class-title');
    if (titleEl) titleEl.textContent = schedule.title || classId;

    // Module title + progress
    const modTitle = document.getElementById('cb-module-title');
    const modProgress = document.getElementById('cb-module-progress');
    if (modTitle) modTitle.textContent = current?.title || moduleFile;
    if (modProgress && currentIdx >= 0) modProgress.textContent = `Lesson ${currentIdx + 1} of ${modules.length}`;

    // Prev / Next / Homework nav buttons
    const navEl = document.getElementById('cb-module-nav');
    if (navEl) {
      let navHtml = '';

      if (prev) {
        navHtml += `<a href="#/classes/${esc(classId)}/modules/${encodeURIComponent(prev.htmlFile)}" class="cb-module-nav-btn" title="${esc(prev.title)}">&larr; Prev</a>`;
      } else {
        navHtml += '<span class="cb-module-nav-btn cb-module-nav-disabled">&larr; Prev</span>';
      }

      if (current?.homeworkFileId) {
        try {
          const fDoc = await db.collection('classFiles').doc(current.homeworkFileId).get();
          if (fDoc.exists && fDoc.data().fileUrl) {
            navHtml += `<a href="${esc(fDoc.data().fileUrl)}" target="_blank" rel="noopener" class="cb-module-nav-btn cb-module-nav-hw">Homework</a>`;
          }
        } catch (e) { /* skip */ }
      }

      if (next) {
        navHtml += `<a href="#/classes/${esc(classId)}/modules/${encodeURIComponent(next.htmlFile)}" class="cb-module-nav-btn" title="${esc(next.title)}">Next &rarr;</a>`;
      } else {
        navHtml += '<span class="cb-module-nav-btn cb-module-nav-disabled">Next &rarr;</span>';
      }

      navEl.innerHTML = navHtml;
    }
  } catch (err) {
    console.warn('[ModuleViewer] Failed to load class data:', err);
  }
}

/* ================================================================
   EXPORTS
   ================================================================ */
McgheeLab.renderClassPage    = renderClassPage;
McgheeLab.wireClassPage      = wireClassPage;
McgheeLab.renderModuleViewer = renderModuleViewer;
McgheeLab.wireModuleViewer   = wireModuleViewer;
McgheeLab.ScheduleDB         = ScheduleDB;

})();
