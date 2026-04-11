/* ================================================================
   Equipment Scheduler — McGheeLab Lab App
   Book microscopes, printers, and shared equipment.
   Color-coded priority, per-device calendars, training permissions,
   and Google Calendar sync.
   ================================================================ */

(() => {
  'use strict';

  const appEl = document.getElementById('app');
  function db() {
    if (typeof firebase === 'undefined') throw new Error('Firebase SDK not loaded');
    return firebase.firestore();
  }
  const TS = () => firebase.firestore.FieldValue.serverTimestamp();

  /* ─── State ──────────────────────────────────────────────── */
  let _user = null;
  let _profile = null;
  let _equipment = [];            // device catalog
  let _bookings = [];             // current view's bookings
  let _myTraining = null;         // current user's training doc
  let _settings = null;           // equipmentSettings/config
  let _allUsers = [];             // for co-operator picker & training mgmt

  let _currentTab = 'equipment';  // 'equipment' | 'calendar' | 'mybookings' | 'admin'
  let _calView = 'week';          // 'week' | 'month'
  let _weekOffset = 0;
  let _monthDate = null;          // { year, month }
  let _selectedEquipId = '';      // '' = all equipment
  let _adminSection = 'devices';  // 'devices' | 'training' | 'settings'

  let _unsubBookings = null;
  let _unsubEquipment = null;
  let _toastTimer = null;
  let _gcalToken = null;

  // Zoom state for weekly calendar (index into ZOOM_LEVELS)
  // 48 slots per day — at 4px/slot the full day is 192px (fits any screen)
  const ZOOM_LEVELS = [4, 6, 9, 14, 20, 28, 40, 56, 76]; // px per half-hour slot
  let _zoomIdx = 4; // default 20px

  // Drag-select state for weekly calendar
  let _drag = null; // { col, startRow, endRow, date }

  /* ─── Priority colors (defaults, overridden by settings) ── */
  const DEFAULT_PRIORITY_COLORS = {
    normal:      '#5baed1',
    high:        '#ffc107',
    urgent:      '#e91e63',
    maintenance: '#8a94a6'
  };
  function getPriorityColors() {
    return (_settings && _settings.priorityColors) || DEFAULT_PRIORITY_COLORS;
  }
  function getCertDefs() {
    return (_settings && _settings.certificationDefs) || [];
  }

  /* ─── Category hierarchy ────────────────────────────────── */
  const CATEGORY_ORDER = ['pi', 'postdoc', 'grad', 'undergrad', 'highschool', 'alumni', 'guest'];
  function categoryRank(cat) {
    const idx = CATEGORY_ORDER.indexOf(cat);
    return idx === -1 ? 99 : idx;
  }
  function isBelowCategory(userCat, minCat) {
    return categoryRank(userCat) > categoryRank(minCat);
  }

  /* ─── DB Helpers (EDB) ──────────────────────────────────── */
  const EDB = {
    /* Equipment CRUD */
    async getEquipment() {
      const snap = await db().collection('equipment').orderBy('name').get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async saveEquipment(data) {
      data.updatedAt = TS();
      if (data.id) {
        const { id, ...rest } = data;
        await db().collection('equipment').doc(id).set(rest, { merge: true });
        return id;
      }
      data.createdAt = TS();
      const ref = await db().collection('equipment').add(data);
      return ref.id;
    },
    async deleteEquipment(id) {
      await db().collection('equipment').doc(id).delete();
    },

    /* Bookings */
    async createBooking(data) {
      data.createdAt = TS();
      data.updatedAt = TS();
      const ref = await db().collection('equipmentBookings').add(data);
      return ref.id;
    },
    async updateBooking(id, data) {
      data.updatedAt = TS();
      await db().collection('equipmentBookings').doc(id).update(data);
    },
    async cancelBooking(id) {
      await db().collection('equipmentBookings').doc(id).update({
        status: 'cancelled',
        updatedAt: TS()
      });
    },

    /* Training */
    async getTraining(uid) {
      const doc = await db().collection('equipmentTraining').doc(uid).get();
      return doc.exists ? { id: doc.id, ...doc.data() } : null;
    },
    async getAllTraining() {
      const snap = await db().collection('equipmentTraining').get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async setTraining(uid, data) {
      data.updatedAt = TS();
      await db().collection('equipmentTraining').doc(uid).set(data, { merge: true });
    },

    /* Settings */
    async getSettings() {
      const doc = await db().collection('equipmentSettings').doc('config').get();
      return doc.exists ? doc.data() : null;
    },
    async saveSettings(data) {
      data.updatedAt = TS();
      await db().collection('equipmentSettings').doc('config').set(data, { merge: true });
    },

    /* Users list (for co-operator picker & training admin) */
    async getUsers() {
      const snap = await db().collection('users').get();
      return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    }
  };

  /* ═══════════════════════════════════════════════════════════
     BOOTSTRAP
     ═══════════════════════════════════════════════════════════ */
  document.addEventListener('DOMContentLoaded', () => {
    let booted = false;
    let _bridgeUser = null, _bridgeProfile = null, _fbAuthResolved = false;

    async function tryBoot() {
      if (booted || !_fbAuthResolved || !_bridgeUser) return;
      booted = true;
      _user = _bridgeUser;
      _profile = _bridgeProfile;
      const now = new Date();
      _monthDate = { year: now.getFullYear(), month: now.getMonth() };
      await Promise.all([loadSettings(), loadTraining(), loadUsers()]);
      render();
      subscribeEquipment();
      subscribeUsers();

      if (McgheeLab.MobileShell?.enableTabSwipe) {
        const tabs = [{ id: 'equipment' }, { id: 'calendar' }, { id: 'mybookings' }];
        if (_bridgeProfile?.role === 'admin') tabs.push({ id: 'admin' });
        McgheeLab.MobileShell.enableTabSwipe(tabs, () => _currentTab, (id) => { _currentTab = id; render(); });
      }
    }

    McgheeLab.AppBridge.init();
    if (McgheeLab.MobileShell) McgheeLab.MobileShell.configure({ appId: 'equipment', title: 'Equipment Scheduler' });
    McgheeLab.AppBridge.onReady((user, profile) => {
      if (!user) return;
      _bridgeUser = user;
      _bridgeProfile = profile;
      tryBoot();
    });

    if (typeof firebase !== 'undefined' && firebase.auth) {
      firebase.auth().onAuthStateChanged(async (fbUser) => {
        _fbAuthResolved = true;
        if (booted) return;
        if (fbUser && !_bridgeUser) {
          try {
            const doc = await db().collection('users').doc(fbUser.uid).get();
            const profile = doc.exists ? doc.data() : { role: 'guest' };
            _bridgeUser = { uid: fbUser.uid, email: fbUser.email, displayName: fbUser.displayName };
            _bridgeProfile = profile;
          } catch (err) {
            _bridgeUser = { uid: fbUser.uid, email: fbUser.email, displayName: fbUser.displayName };
            _bridgeProfile = { role: 'guest' };
          }
        }
        tryBoot();
      });
    }
  });

  async function loadSettings() {
    _settings = await EDB.getSettings();
  }
  async function loadTraining() {
    if (_user) _myTraining = await EDB.getTraining(_user.uid);
  }
  async function loadUsers() {
    _allUsers = await EDB.getUsers();
  }

  function subscribeUsers() {
    db().collection('users').onSnapshot(snap => {
      _allUsers = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    });
  }

  /* ─── Real-time subscriptions ───────────────────────────── */
  function subscribeEquipment() {
    if (_unsubEquipment) _unsubEquipment();
    _unsubEquipment = db().collection('equipment').orderBy('name')
      .onSnapshot(snap => {
        _equipment = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        subscribeBookings();
        render();
      });
  }

  function subscribeBookings() {
    if (_unsubBookings) _unsubBookings();
    const { start, end } = getDateRange();
    // Widen start by 30 days to catch multi-day bookings that began before the view
    const wideStart = new Date(start + 'T00:00:00');
    wideStart.setDate(wideStart.getDate() - 30);
    const wideStartStr = localDateStr(wideStart);
    let query = db().collection('equipmentBookings')
      .where('date', '>=', wideStartStr)
      .where('date', '<=', end);
    if (_selectedEquipId) {
      query = query.where('equipmentId', '==', _selectedEquipId);
    }
    _unsubBookings = query.onSnapshot(snap => {
      // Filter: booking must overlap the view range [start, end]
      _bookings = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(b => (b.endDate || b.date) >= start);
      renderCalendarBody();
    });
  }

  /* ═══════════════════════════════════════════════════════════
     DATE / TIME HELPERS
     ═══════════════════════════════════════════════════════════ */
  function esc(s) {
    const el = document.createElement('div');
    el.textContent = s ?? '';
    return el.innerHTML;
  }

  function localDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function todayStr() { return localDateStr(new Date()); }

  function getMonday(offset) {
    const d = new Date();
    const day = d.getDay();
    d.setDate(d.getDate() - ((day === 0 ? 7 : day) - 1) + (offset * 7));
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function getWeekDays(offset) {
    const mon = getMonday(offset);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      return d;
    });
  }

  function getDateRange() {
    if (_calView === 'week') {
      const days = getWeekDays(_weekOffset);
      return { start: localDateStr(days[0]), end: localDateStr(days[6]) };
    }
    const y = _monthDate.year, m = _monthDate.month;
    const first = new Date(y, m, 1);
    const last = new Date(y, m + 1, 0);
    // Extend to full weeks
    const startDay = first.getDay() === 0 ? 6 : first.getDay() - 1;
    first.setDate(first.getDate() - startDay);
    const endDay = last.getDay() === 0 ? 0 : 7 - last.getDay();
    last.setDate(last.getDate() + endDay);
    return { start: localDateStr(first), end: localDateStr(last) };
  }

  function fmtDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function fmtDateFull(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtTime(t) {
    const [h, m] = t.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hr = h % 12 || 12;
    return m === 0 ? `${hr} ${ampm}` : `${hr}:${String(m).padStart(2, '0')} ${ampm}`;
  }
  function fmtWeekRange(offset) {
    const days = getWeekDays(offset);
    const s = days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const e = days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${s} – ${e}`;
  }
  function fmtMonthYear(y, m) {
    return new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  function timeToRow(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 2 + Math.floor(m / 30) + 1; // row 1 = 0:00
  }

  function rowToTime(row) {
    const idx = row - 1; // row 1 = 0:00
    const h = Math.floor(idx / 2);
    const m = (idx % 2) * 30;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function generateTimeSlots(start, end) {
    const slots = [];
    for (let h = start; h < end; h++) {
      slots.push(`${String(h).padStart(2, '0')}:00`);
      slots.push(`${String(h).padStart(2, '0')}:30`);
    }
    return slots;
  }

  /* ═══════════════════════════════════════════════════════════
     PERMISSION CHECKS
     ═══════════════════════════════════════════════════════════ */
  function isAdmin() {
    return _profile && _profile.role === 'admin';
  }

  function canUserBook(equip) {
    if (isAdmin()) return { allowed: true, needsCoOp: false };
    if (!equip || !equip.training) return { allowed: true, needsCoOp: false };
    const t = equip.training;
    // Category restriction
    if (t.restrictToCategories && t.restrictToCategories.length > 0) {
      if (!t.restrictToCategories.includes(_profile.category)) {
        return { allowed: false, reason: 'Your category does not have access to this equipment.' };
      }
    }
    // Certification check
    if (t.required && t.certifications && t.certifications.length > 0) {
      const userCerts = new Set((_myTraining && _myTraining.certifications) || []);
      const missing = t.certifications.filter(c => !userCerts.has(c));
      if (missing.length) {
        const labels = missing.map(id => {
          const def = getCertDefs().find(d => d.id === id);
          return def ? def.label : id;
        });
        return { allowed: false, reason: `Missing training: ${labels.join(', ')}. Contact your admin.` };
      }
    }
    // Co-operator check
    const needsCoOp = t.requiresCoOperator && isBelowCategory(_profile.category, t.coOperatorMinCategory || 'grad');
    return { allowed: true, needsCoOp };
  }

  function getCoOperatorCandidates(minCat) {
    return _allUsers.filter(u =>
      u.uid !== _user.uid &&
      !isBelowCategory(u.category || 'guest', minCat || 'grad')
    );
  }

  function isEquipmentManager(equip) {
    if (!equip) return false;
    return isAdmin() || (equip.managers || []).includes(_user.uid);
  }

  function canBookExtended(equip) {
    if (!equip) return false;
    return isAdmin() || isEquipmentManager(equip) || (equip.extendedTimeUsers || []).includes(_user.uid);
  }

  /* ═══════════════════════════════════════════════════════════
     MAIN RENDER
     ═══════════════════════════════════════════════════════════ */
  function render() {
    if (!_user) return;
    if (McgheeLab.MobileShell?.saveTabScroll) McgheeLab.MobileShell.saveTabScroll('eq-tabs');
    const admin = isAdmin();
    appEl.innerHTML = `
      <div class="eq-layout">
        <div class="eq-tabs" id="eq-tabs">
          <button class="eq-tab ${_currentTab === 'equipment' ? 'eq-tab--active' : ''}" data-tab="equipment">Equipment</button>
          <button class="eq-tab ${_currentTab === 'calendar' ? 'eq-tab--active' : ''}" data-tab="calendar">Calendar</button>
          <button class="eq-tab ${_currentTab === 'mybookings' ? 'eq-tab--active' : ''}" data-tab="mybookings">My Bookings</button>
          ${admin ? `<button class="eq-tab ${_currentTab === 'admin' ? 'eq-tab--active' : ''}" data-tab="admin">Admin</button>` : ''}
        </div>
        <div id="eq-content"></div>
      </div>`;
    wireTabNav();
    renderTab();
    if (McgheeLab.MobileShell?.centerActiveTab) {
      McgheeLab.MobileShell.centerActiveTab(document.getElementById('eq-tabs'), '.eq-tab--active');
    }
  }

  function wireTabNav() {
    appEl.querySelectorAll('.eq-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        _currentTab = btn.dataset.tab;
        render();
      });
    });
  }

  function renderTab() {
    if (_currentTab === 'equipment') renderEquipmentTab();
    else if (_currentTab === 'calendar') renderCalendar();
    else if (_currentTab === 'mybookings') renderMyBookings();
    else if (_currentTab === 'admin') renderAdmin();
  }

  /* ═══════════════════════════════════════════════════════════
     EQUIPMENT TAB
     ═══════════════════════════════════════════════════════════ */
  const CATEGORY_ICONS = {
    microscope: `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="9" r="3"/><path d="M12 12v7"/><path d="M8 22h8"/><path d="M7 2l2 4"/><path d="M17 2l-2 4"/>
    </svg>`,
    bioprinter: `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="8" rx="2"/><path d="M3 11v6a2 2 0 002 2h14a2 2 0 002-2v-6"/><path d="M12 11v4"/><path d="M8 19h8"/>
    </svg>`,
    fabrication: `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>
    </svg>`,
    imaging: `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M2 20h20"/>
    </svg>`,
    other: `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="12" cy="16" r="2"/>
    </svg>`
  };

  function renderEquipmentTab() {
    const content = document.getElementById('eq-content');
    if (!content) return;
    const available = _equipment.filter(e => e.status === 'available');
    const unavailable = _equipment.filter(e => e.status !== 'available');

    if (_equipment.length === 0) {
      content.innerHTML = '<div class="eq-empty" style="padding:2rem;text-align:center">No equipment configured yet.</div>';
      notifyResize();
      return;
    }

    // Count today's bookings per device
    const today = todayStr();
    const todayBookings = _bookings.filter(b => b.status === 'confirmed' && b.date <= today && (b.endDate || b.date) >= today);

    function equipCard(e) {
      const icon = CATEGORY_ICONS[e.category] || CATEGORY_ICONS.other;
      const statusClass = e.status === 'available' ? 'eq-ecard-status--ok' : e.status === 'maintenance' ? 'eq-ecard-status--warn' : 'eq-ecard-status--off';
      const todayCount = todayBookings.filter(b => b.equipmentId === e.id).length;
      const perm = canUserBook(e);
      const certDefs = getCertDefs();
      const requiredCerts = (e.training && e.training.required && e.training.certifications)
        ? e.training.certifications.map(id => { const d = certDefs.find(c => c.id === id); return d ? d.label : id; })
        : [];
      const needsCoOp = e.training && e.training.requiresCoOperator;

      return `<div class="eq-ecard ${e.status !== 'available' ? 'eq-ecard--disabled' : ''}" data-equip-id="${e.id}">
        <div class="eq-ecard-icon">${icon}</div>
        <div class="eq-ecard-body">
          <div class="eq-ecard-header">
            <h3>${esc(e.name)}</h3>
            <span class="eq-ecard-status ${statusClass}">${e.status}</span>
          </div>
          ${e.description ? `<p class="eq-ecard-desc">${esc(e.description)}</p>` : ''}
          <div class="eq-ecard-meta">
            ${e.location ? `<span class="eq-ecard-tag">📍 ${esc(e.location)}</span>` : ''}
            <span class="eq-ecard-tag">${e.maxDurationMin || 480} min max</span>
            ${todayCount > 0 ? `<span class="eq-ecard-tag eq-ecard-tag--active">${todayCount} booking${todayCount > 1 ? 's' : ''} today</span>` : ''}
          </div>
          ${requiredCerts.length || needsCoOp ? `<div class="eq-ecard-reqs">
            ${requiredCerts.map(c => `<span class="eq-ecard-cert">${esc(c)}</span>`).join('')}
            ${needsCoOp ? '<span class="eq-ecard-cert eq-ecard-cert--coop">co-operator required</span>' : ''}
          </div>` : ''}
          ${!perm.allowed ? `<div class="eq-ecard-blocked">${esc(perm.reason)}</div>` : ''}
        </div>
        ${e.status === 'available' ? '<div class="eq-ecard-arrow">›</div>' : ''}
      </div>`;
    }

    content.innerHTML = `
      <div class="eq-ecard-grid">
        ${available.map(equipCard).join('')}
        ${unavailable.length ? `<div class="eq-ecard-divider">Unavailable</div>` + unavailable.map(equipCard).join('') : ''}
      </div>`;

    content.querySelectorAll('.eq-ecard[data-equip-id]').forEach(card => {
      if (card.classList.contains('eq-ecard--disabled')) return;
      card.addEventListener('click', () => {
        _selectedEquipId = card.dataset.equipId;
        _currentTab = 'calendar';
        render();
        subscribeBookings();
      });
    });
    notifyResize();
  }

  /* ═══════════════════════════════════════════════════════════
     CALENDAR TAB
     ═══════════════════════════════════════════════════════════ */
  function renderCalendar() {
    const content = document.getElementById('eq-content');
    if (!content) return;
    const equipOpts = _equipment
      .filter(e => e.status === 'available')
      .map(e => `<option value="${e.id}" ${_selectedEquipId === e.id ? 'selected' : ''}>${esc(e.name)}</option>`)
      .join('');

    const navLabel = _calView === 'week'
      ? fmtWeekRange(_weekOffset)
      : fmtMonthYear(_monthDate.year, _monthDate.month);

    const pc = getPriorityColors();
    const legend = Object.entries(pc).map(([k, c]) =>
      `<span class="eq-legend-item"><span class="eq-legend-dot" style="background:${c}"></span>${k}</span>`
    ).join('');

    content.innerHTML = `
      <div class="eq-cal-header">
        <div class="eq-toolbar">
          <div class="eq-toolbar-left">
            <select id="eq-device-filter" class="eq-select">
              <option value="">All Equipment</option>
              ${equipOpts}
            </select>
            <div class="eq-view-toggle">
              <button class="eq-view-btn ${_calView === 'week' ? 'eq-view-btn--active' : ''}" data-view="week">Week</button>
              <button class="eq-view-btn ${_calView === 'month' ? 'eq-view-btn--active' : ''}" data-view="month">Month</button>
            </div>
          </div>
          <div class="eq-toolbar-center">
            <button class="eq-nav-btn" id="eq-prev">&lsaquo;</button>
            <button class="eq-nav-label" id="eq-today">${navLabel}</button>
            <button class="eq-nav-btn" id="eq-next">&rsaquo;</button>
          </div>
          <div class="eq-toolbar-right">
            <button class="app-btn app-btn--primary" id="eq-new-booking">+ New Booking</button>
          </div>
        </div>
        <div class="eq-legend-row">
          <div class="eq-legend">${legend}</div>
          ${_calView === 'week' ? `<div class="eq-zoom-controls">
            <button class="eq-zoom-btn" id="eq-zoom-out" title="Zoom out">−</button>
            <button class="eq-zoom-btn" id="eq-zoom-in" title="Zoom in">+</button>
          </div>` : ''}
        </div>
      </div>
      <div id="eq-calendar-body" class="eq-cal-body"></div>`;
    wireCalendarToolbar();
    renderCalendarBody();
  }

  function wireCalendarToolbar() {
    const filter = document.getElementById('eq-device-filter');
    if (filter) filter.addEventListener('change', () => {
      _selectedEquipId = filter.value;
      subscribeBookings();
    });
    document.querySelectorAll('.eq-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _calView = btn.dataset.view;
        subscribeBookings();
        renderCalendar();
      });
    });
    const prev = document.getElementById('eq-prev');
    const next = document.getElementById('eq-next');
    const today = document.getElementById('eq-today');
    if (prev) prev.addEventListener('click', () => {
      if (_calView === 'week') _weekOffset--;
      else {
        _monthDate.month--;
        if (_monthDate.month < 0) { _monthDate.month = 11; _monthDate.year--; }
      }
      subscribeBookings();
      renderCalendar();
    });
    if (next) next.addEventListener('click', () => {
      if (_calView === 'week') _weekOffset++;
      else {
        _monthDate.month++;
        if (_monthDate.month > 11) { _monthDate.month = 0; _monthDate.year++; }
      }
      subscribeBookings();
      renderCalendar();
    });
    if (today) today.addEventListener('click', () => {
      _weekOffset = 0;
      const now = new Date();
      _monthDate = { year: now.getFullYear(), month: now.getMonth() };
      subscribeBookings();
      renderCalendar();
    });
    const newBtn = document.getElementById('eq-new-booking');
    if (newBtn) newBtn.addEventListener('click', () => openBookingModal());
    // Zoom controls
    const zoomIn = document.getElementById('eq-zoom-in');
    const zoomOut = document.getElementById('eq-zoom-out');
    if (zoomIn) zoomIn.addEventListener('click', () => {
      if (_zoomIdx < ZOOM_LEVELS.length - 1) { _zoomIdx++; renderCalendarBody(); }
    });
    if (zoomOut) zoomOut.addEventListener('click', () => {
      if (_zoomIdx > 0) { _zoomIdx--; renderCalendarBody(); }
    });
  }

  function renderCalendarBody() {
    const body = document.getElementById('eq-calendar-body');
    if (!body) return;
    if (_calView === 'week') renderWeekView(body);
    else renderMonthView(body);
    notifyResize();
  }

  /* ─── Week View ─────────────────────────────────────────── */
  function renderWeekView(container) {
    const days = getWeekDays(_weekOffset);
    const today = todayStr();
    const startHour = 0, endHour = 24;
    const slots = generateTimeSlots(startHour, endHour);
    const activeBookings = _bookings.filter(b => b.status !== 'cancelled');
    // Note: 'needs-rebooking' bookings are included (shown with striped style)

    // Day headers
    const dayHeaders = days.map(d => {
      const ds = localDateStr(d);
      const isToday = ds === today;
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
      const dayNum = d.getDate();
      return `<div class="eq-wk-dayhead eq-wk-sticky-head ${isToday ? 'eq-wk-dayhead--today' : ''}">${dayName}<span class="eq-wk-daynum">${dayNum}</span></div>`;
    }).join('');

    // Time labels
    const timeLabels = slots.map((t, i) => {
      const [h, m] = t.split(':').map(Number);
      if (m !== 0) return `<div class="eq-wk-time eq-wk-time--half" style="grid-row:${i + 2}"></div>`;
      return `<div class="eq-wk-time" style="grid-row:${i + 2}">${fmtTime(t)}</div>`;
    }).join('');

    // Grid cells (clickable)
    let cells = '';
    days.forEach((d, col) => {
      const ds = localDateStr(d);
      slots.forEach((t, row) => {
        cells += `<div class="eq-wk-cell" data-date="${ds}" data-time="${t}" style="grid-column:${col + 2};grid-row:${row + 2}"></div>`;
      });
    });

    // Booking blocks (multi-day bookings render a segment per visible day)
    const pc = getPriorityColors();
    let blocks = '';
    activeBookings.forEach(b => {
      const bEndDate = b.endDate || b.date;
      const color = pc[b.priority] || pc.normal;
      const equipObj = _equipment.find(e => e.id === b.equipmentId);
      const label = _selectedEquipId ? (b.userName || '') : (equipObj ? equipObj.shortName || equipObj.name : b.equipmentName || '');
      const sub = _selectedEquipId ? '' : `<span class="eq-block-user">${esc(b.userName || '')}</span>`;
      const needsRebook = b.status === 'needs-rebooking';
      const pendingApproval = b.status === 'pending-approval';
      const statusTag = needsRebook ? '<span class="eq-block-rebook">needs rebooking</span>'
        : pendingApproval ? '<span class="eq-block-pending">pending approval</span>' : '';
      const isMultiDay = bEndDate > b.date;

      // For each visible day this booking spans, render a segment
      days.forEach((d, dayIdx) => {
        const ds = localDateStr(d);
        if (ds < b.date || ds > bEndDate) return;

        let segStart, segEnd, timeLabel;
        if (!isMultiDay) {
          // Single-day booking
          segStart = b.startTime;
          segEnd = b.endTime;
          timeLabel = `${fmtTime(b.startTime)}–${fmtTime(b.endTime)}`;
        } else if (ds === b.date) {
          // First day of multi-day: start time to end of day
          segStart = b.startTime;
          segEnd = '23:30';
          timeLabel = `${fmtTime(b.startTime)} →`;
        } else if (ds === bEndDate) {
          // Last day of multi-day: start of day to end time
          segStart = '00:00';
          segEnd = b.endTime;
          timeLabel = `→ ${fmtTime(b.endTime)}`;
        } else {
          // Middle day: full day
          segStart = '00:00';
          segEnd = '23:30';
          timeLabel = 'all day';
        }

        const startRow = timeToRow(segStart);
        const endRow = timeToRow(segEnd);
        const span = endRow - startRow;
        if (span <= 0) return;

        const multiDayClass = isMultiDay ? 'eq-wk-block--multiday' : '';
        const segPos = !isMultiDay ? '' : ds === b.date ? 'eq-wk-block--md-first' : ds === bEndDate ? 'eq-wk-block--md-last' : 'eq-wk-block--md-mid';
        blocks += `<div class="eq-wk-block ${needsRebook ? 'eq-wk-block--needs-rebook' : ''} ${pendingApproval ? 'eq-wk-block--pending' : ''} ${multiDayClass} ${segPos}" data-booking-id="${b.id}"
          style="grid-column:${dayIdx + 2};grid-row:${startRow + 1}/span ${span};border-left-color:${color};background:${color}22;">
          <span class="eq-block-label">${esc(label)}</span>
          ${sub}
          <span class="eq-block-time">${timeLabel}</span>
          ${statusTag}
        </div>`;
      });
    });

    const slotH = ZOOM_LEVELS[_zoomIdx];

    // Preserve scroll position across re-renders (zoom, booking updates)
    const oldWrap = container.querySelector('.eq-week-wrap');
    const prevScrollTop = oldWrap ? oldWrap.scrollTop : null;
    const prevSlotH = oldWrap ? parseFloat(oldWrap.dataset.slotH || '0') : 0;

    container.innerHTML = `
      <div class="eq-cal-scroll-area">
        <div class="eq-week-wrap" data-slot-h="${slotH}">
          <div class="eq-week-grid" style="grid-template-rows:auto repeat(${slots.length},${slotH}px);">
            <div class="eq-wk-corner eq-wk-sticky-head"></div>
            ${dayHeaders}
            ${timeLabels}
            ${cells}
            ${blocks}
          </div>
        </div>
        <div class="eq-time-slider" id="eq-time-slider">
          <div class="eq-time-slider-track"></div>
          <div class="eq-time-slider-thumb" id="eq-time-slider-thumb"></div>
        </div>
      </div>`;

    wireWeekGrid(container);
    const wrap = container.querySelector('.eq-week-wrap');
    wirePinchZoom(wrap);
    wireTimeSlider(wrap);

    // Disable mobile-shell's built-in time scroll (we have our own)
    if (McgheeLab.MobileShell?.disableTimeScroll) {
      McgheeLab.MobileShell.disableTimeScroll();
    }

    // Restore or set initial scroll position
    if (prevScrollTop !== null && prevSlotH > 0) {
      // Scale scroll position proportionally when zoom changes
      wrap.scrollTop = prevScrollTop * (slotH / prevSlotH);
    } else {
      // First render: auto-scroll to ~8 AM
      wrap.scrollTop = slotH * 16; // row 16 = 08:00
    }
  }

  function wireWeekGrid(container) {
    const grid = container.querySelector('.eq-week-grid');
    if (!grid) return;
    const cells = container.querySelectorAll('.eq-wk-cell');
    const cellMap = new Map(); // "col-row" -> element
    cells.forEach(cell => {
      const col = cell.style.gridColumn.replace(/[^0-9]/g, '');
      const row = cell.style.gridRow.replace(/[^0-9]/g, '');
      cellMap.set(`${col}-${row}`, cell);
    });

    function getCellInfo(cell) {
      return {
        date: cell.dataset.date,
        time: cell.dataset.time,
        col: parseInt(cell.style.gridColumn),
        row: parseInt(cell.style.gridRow),
      };
    }

    function clearSelection() {
      cells.forEach(c => c.classList.remove('eq-wk-cell--selected'));
    }

    function highlightRange(startCol, startRow, endCol, endRow) {
      clearSelection();
      const minCol = Math.min(startCol, endCol);
      const maxCol = Math.max(startCol, endCol);
      const minR = Math.min(startRow, endRow);
      const maxR = Math.max(startRow, endRow);
      if (minCol === maxCol) {
        // Single day: highlight row range in that column
        for (let r = minR; r <= maxR; r++) {
          const c = cellMap.get(`${minCol}-${r}`);
          if (c) c.classList.add('eq-wk-cell--selected');
        }
      } else {
        // Multi-day: highlight from startRow to bottom in first col, full days in middle, top to endRow in last col
        const totalRows = generateTimeSlots(0, 24).length;
        for (let col = minCol; col <= maxCol; col++) {
          const rStart = col === startCol ? startRow : 2;
          const rEnd = col === endCol ? endRow : totalRows + 1;
          for (let r = rStart; r <= rEnd; r++) {
            const c = cellMap.get(`${col}-${r}`);
            if (c) c.classList.add('eq-wk-cell--selected');
          }
        }
      }
    }

    // Pointer-based drag-to-select (supports multi-day)
    cells.forEach(cell => {
      cell.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const info = getCellInfo(cell);
        _drag = { col: info.col, startRow: info.row, endRow: info.row, endCol: info.col, date: info.date, endDate: info.date };
        highlightRange(info.col, info.row, info.col, info.row);
        grid.setPointerCapture(e.pointerId);
      });
    });

    grid.addEventListener('pointermove', (e) => {
      if (!_drag) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || !el.classList.contains('eq-wk-cell')) return;
      const info = getCellInfo(el);
      _drag.endRow = info.row;
      _drag.endCol = info.col;
      _drag.endDate = info.date;
      highlightRange(_drag.col, _drag.startRow, _drag.endCol, _drag.endRow);
    });

    grid.addEventListener('pointerup', (e) => {
      if (!_drag) return;
      clearSelection();
      // Determine start/end based on chronological order
      let startCol = _drag.col, startRow = _drag.startRow, startDate = _drag.date;
      let endCol = _drag.endCol, endRow = _drag.endRow, endDate = _drag.endDate;
      if (endDate < startDate || (endDate === startDate && endRow < startRow)) {
        [startCol, endCol] = [endCol, startCol];
        [startRow, endRow] = [endRow, startRow];
        [startDate, endDate] = [endDate, startDate];
      }
      const startTime = rowToTime(startRow);
      const endTime = rowToTime(endRow + 1);
      _drag = null;
      openBookingModal({ date: startDate, endDate, startTime, endTime });
    });

    grid.addEventListener('pointercancel', () => {
      _drag = null;
      clearSelection();
    });

    // Click booking block to show detail
    container.querySelectorAll('.eq-wk-block').forEach(block => {
      block.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); // prevent drag-select from starting
      });
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        showBookingDetail(block.dataset.bookingId);
      });
    });
  }

  /* ─── Pinch-to-Zoom on week grid ─────────────────────────── */
  function wirePinchZoom(wrapEl) {
    if (!wrapEl) return;
    let _startDist = 0;
    let _startZoom = _zoomIdx;

    wrapEl.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        _startDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        _startZoom = _zoomIdx;
      }
    }, { passive: true });

    wrapEl.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2) return;
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const ratio = dist / _startDist;
      let newIdx = _startZoom;
      if (ratio > 1.3) newIdx = Math.min(_startZoom + 1, ZOOM_LEVELS.length - 1);
      else if (ratio > 1.7) newIdx = Math.min(_startZoom + 2, ZOOM_LEVELS.length - 1);
      else if (ratio < 0.7) newIdx = Math.max(_startZoom - 1, 0);
      else if (ratio < 0.5) newIdx = Math.max(_startZoom - 2, 0);
      if (newIdx !== _zoomIdx) {
        _zoomIdx = newIdx;
        renderCalendarBody();
      }
    }, { passive: true });
  }

  /* ─── Custom time-slider (scroll indicator for week grid) ── */
  function wireTimeSlider(wrapEl) {
    if (!wrapEl) return;
    const slider = document.getElementById('eq-time-slider');
    const thumb = document.getElementById('eq-time-slider-thumb');
    if (!slider || !thumb) return;

    function syncThumb() {
      const scrollH = wrapEl.scrollHeight;
      const clientH = wrapEl.clientHeight;
      const max = scrollH - clientH;
      if (max <= 0) {
        // Everything fits — hide the slider
        slider.style.display = 'none';
        return;
      }
      slider.style.display = '';
      // Thumb height proportional to visible fraction
      const trackH = slider.clientHeight;
      const ratio = clientH / scrollH;
      const thumbH = Math.max(24, Math.round(ratio * trackH));
      thumb.style.height = thumbH + 'px';
      // Thumb position
      const scrollRatio = wrapEl.scrollTop / max;
      thumb.style.top = Math.round(scrollRatio * (trackH - thumbH)) + 'px';
    }

    wrapEl.addEventListener('scroll', syncThumb, { passive: true });
    requestAnimationFrame(syncThumb);

    // Drag the thumb or click the track to scroll
    let dragging = false;

    function moveToY(clientY) {
      const rect = slider.getBoundingClientRect();
      const thumbH = thumb.offsetHeight;
      const trackH = slider.clientHeight;
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top - thumbH / 2) / (trackH - thumbH)));
      const max = wrapEl.scrollHeight - wrapEl.clientHeight;
      wrapEl.scrollTop = ratio * max;
    }

    // Touch
    slider.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      moveToY(e.touches[0].clientY);
    }, { passive: false });
    slider.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      moveToY(e.touches[0].clientY);
    }, { passive: false });
    slider.addEventListener('touchend', () => { dragging = false; });
    slider.addEventListener('touchcancel', () => { dragging = false; });

    // Mouse
    slider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      moveToY(e.clientY);
      const onMove = (ev) => { if (dragging) moveToY(ev.clientY); };
      const onUp = () => { dragging = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /* ─── Month View ────────────────────────────────────────── */
  function renderMonthView(container) {
    const y = _monthDate.year, m = _monthDate.month;
    const today = todayStr();
    const firstOfMonth = new Date(y, m, 1);
    const lastOfMonth = new Date(y, m + 1, 0);
    const pc = getPriorityColors();
    const activeBookings = _bookings.filter(b => b.status !== 'cancelled');

    // Build grid starting from Monday
    const startDay = firstOfMonth.getDay() === 0 ? 6 : firstOfMonth.getDay() - 1;
    const gridStart = new Date(firstOfMonth);
    gridStart.setDate(gridStart.getDate() - startDay);

    const totalDays = startDay + lastOfMonth.getDate();
    const weeks = Math.ceil(totalDays / 7);

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    let html = '<div class="eq-month-grid">';
    html += dayNames.map(d => `<div class="eq-month-dayhead">${d}</div>`).join('');

    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const date = new Date(gridStart);
        date.setDate(gridStart.getDate() + w * 7 + d);
        const ds = localDateStr(date);
        const isToday = ds === today;
        const inMonth = date.getMonth() === m;
        const dayBookings = activeBookings.filter(b => ds >= b.date && ds <= (b.endDate || b.date));
        const dots = dayBookings.slice(0, 4).map(b => {
          const c = pc[b.priority] || pc.normal;
          return `<span class="eq-month-dot" style="background:${c}" title="${esc(b.equipmentName || '')} - ${esc(b.userName || '')}"></span>`;
        }).join('');
        const more = dayBookings.length > 4 ? `<span class="eq-month-more">+${dayBookings.length - 4}</span>` : '';
        html += `<div class="eq-month-cell ${isToday ? 'eq-month-cell--today' : ''} ${!inMonth ? 'eq-month-cell--out' : ''}" data-date="${ds}">
          <span class="eq-month-num">${date.getDate()}</span>
          <div class="eq-month-dots">${dots}${more}</div>
        </div>`;
      }
    }
    html += '</div>';
    container.innerHTML = html;

    // Click day to switch to week view
    container.querySelectorAll('.eq-month-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        const dateStr = cell.dataset.date;
        const d = new Date(dateStr + 'T00:00:00');
        // Calculate week offset relative to current week's Monday
        const currentMonday = getMonday(0);
        const diffDays = Math.floor((d - currentMonday) / 86400000);
        _weekOffset = Math.floor(diffDays / 7);
        _calView = 'week';
        subscribeBookings();
        renderCalendar();
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     BOOKING MODAL
     ═══════════════════════════════════════════════════════════ */
  function openBookingModal(prefill, editBooking) {
    const isEdit = !!editBooking;
    const equip = _equipment.filter(e => e.status === 'available');
    const preEquipId = editBooking ? editBooking.equipmentId : (_selectedEquipId || (equip[0] ? equip[0].id : ''));
    const preDate = editBooking ? editBooking.date : (prefill && prefill.date) || todayStr();
    const preEndDate = editBooking ? (editBooking.endDate || editBooking.date) : (prefill && prefill.endDate) || preDate;
    const preStart = editBooking ? editBooking.startTime : (prefill && prefill.startTime) || '09:00';
    const preEnd = editBooking ? editBooking.endTime : (prefill && prefill.endTime) || '';
    const prePriority = editBooking ? editBooking.priority : 'normal';
    const preNotes = editBooking ? (editBooking.notes || '') : '';
    const preCoOp = editBooking ? (editBooking.coOperatorUid || '') : '';

    const equipOpts = equip.map(e =>
      `<option value="${e.id}" ${e.id === preEquipId ? 'selected' : ''}>${esc(e.name)} — ${esc(e.location || '')}</option>`
    ).join('');

    const timeOpts = generateTimeSlots(0, 24).map(t =>
      `<option value="${t}">${fmtTime(t)}</option>`
    ).join('');

    const pc = getPriorityColors();
    const priorityOpts = ['normal', 'high', 'urgent'].map(p =>
      `<option value="${p}" ${p === prePriority ? 'selected' : ''}>${p.charAt(0).toUpperCase() + p.slice(1)}</option>`
    ).join('');
    if (isAdmin()) {
      // Admin can also create maintenance blocks
    }

    const overlay = document.createElement('div');
    overlay.className = 'eq-modal-overlay';
    overlay.innerHTML = `
      <div class="eq-modal">
        <div class="eq-modal-header">
          <h3>${isEdit ? 'Edit Booking' : 'New Booking'}</h3>
          <button class="eq-modal-close">&times;</button>
        </div>
        <div class="eq-modal-body">
          <div class="eq-form-group">
            <label>Equipment</label>
            <select id="eq-bk-equip" class="eq-input">${equipOpts}</select>
          </div>
          <div id="eq-bk-perm-msg"></div>
          <div class="eq-form-row">
            <div class="eq-form-group">
              <label>Start Date</label>
              <input type="date" id="eq-bk-date" class="eq-input" value="${preDate}" />
            </div>
            <div class="eq-form-group">
              <label>Start Time</label>
              <select id="eq-bk-start" class="eq-input">${timeOpts}</select>
            </div>
          </div>
          <div class="eq-form-row">
            <div class="eq-form-group">
              <label>End Date</label>
              <input type="date" id="eq-bk-end-date" class="eq-input" value="${preEndDate}" />
            </div>
            <div class="eq-form-group">
              <label>End Time</label>
              <select id="eq-bk-end" class="eq-input">${timeOpts}</select>
            </div>
          </div>
          <div class="eq-form-group">
            <label>Priority</label>
            <div class="eq-priority-row">
              <select id="eq-bk-priority" class="eq-input">${priorityOpts}${isAdmin() ? '<option value="maintenance">Maintenance</option>' : ''}</select>
              <span class="eq-priority-preview" id="eq-bk-priority-dot"></span>
            </div>
          </div>
          <div class="eq-form-group" id="eq-bk-coop-group" style="display:none">
            <label>Co-operator (required)</label>
            <select id="eq-bk-coop" class="eq-input"><option value="">Select a co-operator...</option></select>
          </div>
          <div class="eq-form-group">
            <label>Notes</label>
            <textarea id="eq-bk-notes" class="eq-input" rows="2" placeholder="Optional notes...">${esc(preNotes)}</textarea>
          </div>
          <div id="eq-bk-extended-msg"></div>
          <div id="eq-bk-conflicts" class="eq-conflicts"></div>
          <div id="eq-bk-error" class="eq-error"></div>
        </div>
        <div class="eq-modal-footer">
          <button class="app-btn app-btn--secondary eq-modal-cancel">Cancel</button>
          <button class="app-btn app-btn--primary" id="eq-bk-submit">${isEdit ? 'Save Changes' : 'Book'}</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // Set initial values
    const startSel = overlay.querySelector('#eq-bk-start');
    const endSel = overlay.querySelector('#eq-bk-end');
    startSel.value = preStart;
    if (preEnd) endSel.value = preEnd;
    else {
      // Default end = start + 1 hour
      const [h, m] = preStart.split(':').map(Number);
      endSel.value = `${String(Math.min(h + 1, 23)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    function updatePermissionUI() {
      const eqId = overlay.querySelector('#eq-bk-equip').value;
      const eq = _equipment.find(e => e.id === eqId);
      const perm = canUserBook(eq);
      const permMsg = overlay.querySelector('#eq-bk-perm-msg');
      const coopGroup = overlay.querySelector('#eq-bk-coop-group');
      permMsg.innerHTML = '';
      coopGroup.style.display = 'none';
      if (!perm.allowed) {
        permMsg.innerHTML = `<div class="eq-perm-blocked">${esc(perm.reason)}</div>`;
        overlay.querySelector('#eq-bk-submit').disabled = true;
      } else {
        overlay.querySelector('#eq-bk-submit').disabled = false;
        if (perm.needsCoOp) {
          const minCat = (eq.training && eq.training.coOperatorMinCategory) || 'grad';
          const candidates = getCoOperatorCandidates(minCat);
          const coopSel = overlay.querySelector('#eq-bk-coop');
          coopSel.innerHTML = '<option value="">Select a co-operator...</option>' +
            candidates.map(u =>
              `<option value="${u.uid}" ${u.uid === preCoOp ? 'selected' : ''}>${esc(u.name || u.email || u.uid)} (${u.category || ''})</option>`
            ).join('');
          coopGroup.style.display = 'block';
        }
      }
    }

    function updatePriorityDot() {
      const p = overlay.querySelector('#eq-bk-priority').value;
      const dot = overlay.querySelector('#eq-bk-priority-dot');
      dot.style.background = pc[p] || pc.normal;
    }

    let _conflictDocs = []; // stash for submit handler

    async function checkConflicts() {
      const eqId = overlay.querySelector('#eq-bk-equip').value;
      const date = overlay.querySelector('#eq-bk-date').value;
      const endDate = overlay.querySelector('#eq-bk-end-date').value;
      const start = overlay.querySelector('#eq-bk-start').value;
      const end = overlay.querySelector('#eq-bk-end').value;
      const conflictsEl = overlay.querySelector('#eq-bk-conflicts');
      _conflictDocs = [];
      if (!eqId || !date || !endDate || !start || !end) { conflictsEl.innerHTML = ''; return; }
      // Query bookings that could overlap the date range
      const snap = await db().collection('equipmentBookings')
        .where('equipmentId', '==', eqId)
        .where('date', '<=', endDate)
        .get();
      _conflictDocs = snap.docs
        .filter(d => {
          if (isEdit && d.id === editBooking.id) return false;
          const b = d.data();
          if (b.status !== 'confirmed' && b.status !== 'needs-rebooking') return false;
          const bEndDate = b.endDate || b.date;
          // Check if date ranges overlap
          if (bEndDate < date || b.date > endDate) return false;
          // If bookings share only the start date boundary, check times
          if (bEndDate === date && b.date === date && endDate === date) {
            return b.startTime < end && b.endTime > start;
          }
          // If existing booking ends on our start date, check time overlap
          if (bEndDate === date && b.date < date) {
            return b.endTime > start;
          }
          // If existing booking starts on our end date, check time overlap
          if (b.date === endDate && bEndDate > endDate) {
            return b.startTime < end;
          }
          // Same single day for both bookings
          if (b.date === bEndDate && b.date === date && date === endDate) {
            return b.startTime < end && b.endTime > start;
          }
          return true; // date ranges overlap across full days
        })
        .map(d => ({ id: d.id, ...d.data() }));
      if (_conflictDocs.length > 0) {
        const names = _conflictDocs.map(b => {
          const bEndDate = b.endDate || b.date;
          const dateLabel = bEndDate !== b.date ? `${fmtDate(b.date)}–${fmtDate(bEndDate)}` : fmtDate(b.date);
          return `<span class="eq-conflict-name">${esc(b.userName || 'Unknown')} (${dateLabel} ${fmtTime(b.startTime)}–${fmtTime(b.endTime)})</span>`;
        }).join(', ');
        conflictsEl.innerHTML = `
          <div class="eq-conflict-warning">
            <strong>Overlaps with:</strong> ${names}
            <label class="eq-checkbox-label" style="margin-top:.4rem">
              <input type="checkbox" id="eq-bk-displace-confirm" />
              I have asked the above and they agreed to rebook
            </label>
          </div>`;
      } else {
        conflictsEl.innerHTML = '';
      }
    }

    // Wire events
    overlay.querySelector('#eq-bk-equip').addEventListener('change', () => { updatePermissionUI(); checkConflicts(); });
    overlay.querySelector('#eq-bk-date').addEventListener('change', () => {
      // Auto-advance end date if it's before start date
      const endDateEl = overlay.querySelector('#eq-bk-end-date');
      if (endDateEl.value < overlay.querySelector('#eq-bk-date').value) {
        endDateEl.value = overlay.querySelector('#eq-bk-date').value;
      }
      checkConflicts();
    });
    overlay.querySelector('#eq-bk-end-date').addEventListener('change', checkConflicts);
    overlay.querySelector('#eq-bk-start').addEventListener('change', checkConflicts);
    overlay.querySelector('#eq-bk-end').addEventListener('change', checkConflicts);
    overlay.querySelector('#eq-bk-priority').addEventListener('change', updatePriorityDot);
    overlay.querySelector('.eq-modal-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.eq-modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#eq-bk-submit').addEventListener('click', async () => {
      // Re-check conflicts before submitting to avoid race conditions
      await checkConflicts();

      const eqId = overlay.querySelector('#eq-bk-equip').value;
      const date = overlay.querySelector('#eq-bk-date').value;
      const endDate = overlay.querySelector('#eq-bk-end-date').value;
      const start = overlay.querySelector('#eq-bk-start').value;
      const end = overlay.querySelector('#eq-bk-end').value;
      const priority = overlay.querySelector('#eq-bk-priority').value;
      const notes = overlay.querySelector('#eq-bk-notes').value.trim();
      const coopUid = overlay.querySelector('#eq-bk-coop') ? overlay.querySelector('#eq-bk-coop').value : '';
      const errorEl = overlay.querySelector('#eq-bk-error');
      const isMultiDay = endDate > date;

      // Validation
      if (!eqId || !date || !endDate || !start || !end) {
        errorEl.textContent = 'Please fill in all required fields.';
        return;
      }
      if (endDate < date) {
        errorEl.textContent = 'End date cannot be before start date.';
        return;
      }
      if (!isMultiDay && end <= start) {
        errorEl.textContent = 'End time must be after start time.';
        return;
      }
      const eq = _equipment.find(e => e.id === eqId);
      const perm = canUserBook(eq);
      if (!perm.allowed) {
        errorEl.textContent = perm.reason;
        return;
      }
      if (perm.needsCoOp && !coopUid) {
        errorEl.textContent = 'A co-operator is required for this equipment.';
        return;
      }

      // Displacement check — if there are conflicts, user must confirm
      if (_conflictDocs.length > 0) {
        const confirmCb = overlay.querySelector('#eq-bk-displace-confirm');
        if (!confirmCb || !confirmCb.checked) {
          errorEl.textContent = 'You must confirm that displaced users have agreed to rebook.';
          return;
        }
      }

      // Duration check
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      const dayDiffMs = new Date(endDate + 'T00:00:00') - new Date(date + 'T00:00:00');
      const dayDiffDays = Math.round(dayDiffMs / 86400000);
      const durMin = (dayDiffDays * 24 * 60) + (eh * 60 + em) - (sh * 60 + sm);
      if (eq.minDurationMin && durMin < eq.minDurationMin) {
        errorEl.textContent = `Minimum booking duration is ${eq.minDurationMin} minutes.`;
        return;
      }

      let needsApproval = false;
      if (eq.maxDurationMin && durMin > eq.maxDurationMin) {
        if (canBookExtended(eq)) {
          // Whitelisted user — allow but confirm
          const extConfirm = overlay.querySelector('#eq-bk-extended-confirm');
          if (!extConfirm || !extConfirm.checked) {
            errorEl.textContent = '';
            const extDiv = overlay.querySelector('#eq-bk-extended-msg');
            if (extDiv) extDiv.innerHTML = `
              <div class="eq-extended-warning">
                This exceeds the standard max of ${eq.maxDurationMin} min. You have extended-time permission.
                <label class="eq-checkbox-label" style="margin-top:.35rem">
                  <input type="checkbox" id="eq-bk-extended-confirm" /> I confirm I need the extended time
                </label>
              </div>`;
            return;
          }
        } else {
          // Not whitelisted — booking goes to pending-approval
          const extConfirm = overlay.querySelector('#eq-bk-approval-confirm');
          if (!extConfirm || !extConfirm.checked) {
            errorEl.textContent = '';
            const managers = (eq.managers || []).map(uid => {
              const u = _allUsers.find(x => x.uid === uid);
              return u ? (u.name || u.email) : uid;
            });
            const mgrNames = managers.length ? managers.join(', ') : 'an admin';
            const extDiv = overlay.querySelector('#eq-bk-extended-msg');
            if (extDiv) extDiv.innerHTML = `
              <div class="eq-extended-warning">
                This exceeds the standard max of ${eq.maxDurationMin} min. Your booking will need approval from ${esc(mgrNames)}.
                <label class="eq-checkbox-label" style="margin-top:.35rem">
                  <input type="checkbox" id="eq-bk-approval-confirm" /> I understand — submit for approval
                </label>
              </div>`;
            return;
          }
          needsApproval = true;
        }
      }

      // Back-to-back detection — prevent circumventing max duration
      if (eq.maxDurationMin && !isEdit && !canBookExtended(eq)) {
        const snap = await db().collection('equipmentBookings')
          .where('equipmentId', '==', eqId)
          .where('uid', '==', _user.uid)
          .where('date', '==', date)
          .get();
        const myDayBookings = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(b => b.status === 'confirmed' || b.status === 'needs-rebooking');

        // Check if new booking is adjacent to any existing booking by same user
        const newStartMin = sh * 60 + sm;
        const newEndMin = eh * 60 + em;
        for (const ob of myDayBookings) {
          const [os, om2] = ob.startTime.split(':').map(Number);
          const [oe, oem] = ob.endTime.split(':').map(Number);
          const obStart = os * 60 + om2;
          const obEnd = oe * 60 + oem;
          // Adjacent if one ends exactly where the other starts
          const isAdjacent = newEndMin === obStart || newStartMin === obEnd;
          if (isAdjacent) {
            const combinedMin = (ob.durationMin || (obEnd - obStart)) + durMin;
            if (combinedMin > eq.maxDurationMin) {
              errorEl.textContent = `Nice try — booking back-to-back sessions to exceed the ${eq.maxDurationMin}-minute limit isn't allowed. These constraints exist for a reason.`;
              return;
            }
          }
        }
      }

      // Max advance days check (use the furthest date)
      if (eq.maxAdvanceDays) {
        const bookEnd = new Date(endDate + 'T00:00:00');
        const maxDate = new Date();
        maxDate.setDate(maxDate.getDate() + eq.maxAdvanceDays);
        if (bookEnd > maxDate) {
          errorEl.textContent = `Cannot book more than ${eq.maxAdvanceDays} days in advance.`;
          return;
        }
      }

      const coopUser = coopUid ? _allUsers.find(u => u.uid === coopUid) : null;

      try {
        const submitBtn = overlay.querySelector('#eq-bk-submit');
        submitBtn.disabled = true;
        submitBtn.textContent = isEdit ? 'Saving...' : 'Booking...';

        if (isEdit) {
          await EDB.updateBooking(editBooking.id, {
            equipmentId: eqId,
            equipmentName: eq.shortName || eq.name,
            date, endDate, startTime: start, endTime: end,
            durationMin: durMin,
            priority, notes,
            coOperatorUid: coopUid || null,
            coOperatorName: coopUser ? (coopUser.name || coopUser.email) : null,
          });
          await syncBookingToGCal({ ...editBooking, equipmentId: eqId, equipmentName: eq.shortName || eq.name, date, endDate, startTime: start, endTime: end, priority, notes, userName: editBooking.userName }, 'update');
          showToast('Booking updated');
        } else {
          const bookingData = {
            equipmentId: eqId,
            equipmentName: eq.shortName || eq.name,
            uid: _user.uid,
            userName: _profile.name || _user.displayName || _user.email,
            userCategory: _profile.category || '',
            coOperatorUid: coopUid || null,
            coOperatorName: coopUser ? (coopUser.name || coopUser.email) : null,
            date, endDate, startTime: start, endTime: end,
            durationMin: durMin,
            priority,
            status: needsApproval ? 'pending-approval' : 'confirmed',
            notes,
            gcalEventId: null,
          };
          const newId = await EDB.createBooking(bookingData);
          // Mark displaced bookings as needs-rebooking (only for confirmed bookings)
          if (!needsApproval) {
            for (const cb of _conflictDocs) {
              await EDB.updateBooking(cb.id, { status: 'needs-rebooking', displacedBy: _user.uid, displacedByName: _profile.name || _user.displayName || _user.email });
            }
          }
          if (!needsApproval) await syncBookingToGCal({ id: newId, ...bookingData }, 'create');
          showToast(needsApproval ? 'Booking submitted for manager approval' : (_conflictDocs.length ? 'Booking confirmed — displaced bookings marked for rebooking' : 'Booking confirmed'));
        }
        overlay.remove();
        // Ensure calendar refreshes with latest data
        subscribeBookings();
        renderCalendar();
      } catch (err) {
        errorEl.textContent = 'Error: ' + err.message;
        const submitBtn = overlay.querySelector('#eq-bk-submit');
        submitBtn.disabled = false;
        submitBtn.textContent = isEdit ? 'Save Changes' : 'Book';
      }
    });

    updatePermissionUI();
    updatePriorityDot();
    checkConflicts();
  }

  /* ─── Booking Detail Popup ──────────────────────────────── */
  function showBookingDetail(bookingId) {
    const b = _bookings.find(x => x.id === bookingId);
    if (!b) return;
    showBookingDetailDirect(b);
  }

  function showBookingDetailDirect(b) {
    const eq = _equipment.find(e => e.id === b.equipmentId);
    const pc = getPriorityColors();
    const color = pc[b.priority] || pc.normal;
    const canEdit = b.uid === _user.uid || isAdmin();
    const canManage = isAdmin() || isEquipmentManager(eq);

    const statusLabel = b.status === 'needs-rebooking' ? 'Needs Rebooking'
      : b.status === 'pending-approval' ? 'Pending Approval' : b.status;

    const showFooter = (canEdit && (b.status === 'confirmed' || b.status === 'needs-rebooking'))
      || (canManage && b.status === 'pending-approval');

    const overlay = document.createElement('div');
    overlay.className = 'eq-modal-overlay';
    overlay.innerHTML = `
      <div class="eq-modal eq-modal--detail">
        <div class="eq-modal-header">
          <h3 style="border-left:3px solid ${color};padding-left:8px">${esc(eq ? eq.name : b.equipmentName)}</h3>
          <button class="eq-modal-close">&times;</button>
        </div>
        <div class="eq-modal-body">
          <div class="eq-detail-row"><strong>Start:</strong> ${fmtDateFull(b.date)} at ${fmtTime(b.startTime)}</div>
          <div class="eq-detail-row"><strong>End:</strong> ${fmtDateFull(b.endDate || b.date)} at ${fmtTime(b.endTime)}${(b.endDate && b.endDate !== b.date) ? ` <span class="eq-multiday-badge">multi-day</span>` : ''}</div>
          <div class="eq-detail-row"><strong>Duration:</strong> ${b.durationMin ? (b.durationMin >= 1440 ? Math.floor(b.durationMin / 1440) + 'd ' + (b.durationMin % 1440 >= 60 ? Math.floor((b.durationMin % 1440) / 60) + 'h' : '') : (b.durationMin >= 60 ? Math.floor(b.durationMin / 60) + 'h ' + (b.durationMin % 60 ? b.durationMin % 60 + 'min' : '') : b.durationMin + ' min')) : '?'}</div>
          <div class="eq-detail-row"><strong>Booked by:</strong> ${esc(b.userName)}</div>
          ${b.coOperatorName ? `<div class="eq-detail-row"><strong>Co-operator:</strong> ${esc(b.coOperatorName)}</div>` : ''}
          <div class="eq-detail-row"><strong>Priority:</strong> <span class="eq-priority-badge" style="background:${color}33;color:${color}">${b.priority}</span></div>
          ${b.notes ? `<div class="eq-detail-row"><strong>Notes:</strong> ${esc(b.notes)}</div>` : ''}
          <div class="eq-detail-row"><strong>Status:</strong> <span class="eq-status-inline eq-status-inline--${b.status}">${statusLabel}</span></div>
          ${b.displacedByName && b.status === 'needs-rebooking' ? `<div class="eq-detail-row eq-displaced-info">Displaced by ${esc(b.displacedByName)} — please rebook a new time or re-confirm this slot.</div>` : ''}
          ${b.status === 'pending-approval' ? `<div class="eq-detail-row eq-displaced-info" style="border-color:rgba(91,174,209,.25);color:var(--accent)">This extended booking is waiting for manager approval.</div>` : ''}
          ${eq && eq.location ? `<div class="eq-detail-row"><strong>Location:</strong> ${esc(eq.location)}</div>` : ''}
        </div>
        ${showFooter ? `
        <div class="eq-modal-footer">
          <button class="app-btn app-btn--danger" id="eq-detail-cancel">Cancel Booking</button>
          ${b.status === 'needs-rebooking' ? `<button class="app-btn app-btn--primary" id="eq-detail-reconfirm">Re-confirm</button>` : ''}
          ${b.status === 'pending-approval' && canManage ? `<button class="app-btn app-btn--primary" id="eq-detail-approve">Approve</button><button class="app-btn app-btn--danger" id="eq-detail-deny">Deny</button>` : ''}
          ${b.status === 'confirmed' || b.status === 'needs-rebooking' ? `<button class="app-btn app-btn--secondary" id="eq-detail-edit">Edit</button>` : ''}
        </div>` : ''}
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('.eq-modal-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    async function detailAction(fn, successMsg) {
      try {
        await fn();
        overlay.remove();
        showToast(successMsg);
      } catch (err) {
        console.error('Booking action failed:', err);
        showToast('Error: ' + (err.message || 'action failed'));
      }
    }

    const cancelBtn = overlay.querySelector('#eq-detail-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        if (!confirm('Cancel this booking?')) return;
        detailAction(async () => {
          await EDB.cancelBooking(b.id);
          await syncBookingToGCal(b, 'cancel');
        }, 'Booking cancelled');
      });
    }
    const reconfirmBtn = overlay.querySelector('#eq-detail-reconfirm');
    if (reconfirmBtn) {
      reconfirmBtn.addEventListener('click', () => {
        detailAction(async () => {
          await EDB.updateBooking(b.id, { status: 'confirmed', displacedBy: null, displacedByName: null });
        }, 'Booking re-confirmed');
      });
    }
    const approveBtn = overlay.querySelector('#eq-detail-approve');
    if (approveBtn) {
      approveBtn.addEventListener('click', () => {
        detailAction(async () => {
          await EDB.updateBooking(b.id, { status: 'confirmed' });
          await syncBookingToGCal({ ...b, status: 'confirmed' }, 'create');
        }, 'Booking approved');
      });
    }
    const denyBtn = overlay.querySelector('#eq-detail-deny');
    if (denyBtn) {
      denyBtn.addEventListener('click', () => {
        detailAction(async () => {
          await EDB.cancelBooking(b.id);
        }, 'Booking denied');
      });
    }
    const editBtn = overlay.querySelector('#eq-detail-edit');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        overlay.remove();
        openBookingModal(null, b);
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════
     MY BOOKINGS TAB
     ═══════════════════════════════════════════════════════════ */
  function renderMyBookings() {
    const content = document.getElementById('eq-content');
    if (!content) return;
    const today = todayStr();

    // Fetch all user's bookings (no orderBy to avoid composite index requirement)
    content.innerHTML = '<div class="eq-loading">Loading your bookings...</div>';
    db().collection('equipmentBookings')
      .where('uid', '==', _user.uid)
      .get()
      .then(snap => {
        const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // Sort client-side: newest first
        all.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.startTime || '').localeCompare(a.startTime || ''));

        const activeStatuses = ['confirmed', 'needs-rebooking', 'pending-approval'];
        const upcoming = all.filter(b => (b.endDate || b.date) >= today && activeStatuses.includes(b.status));
        const past = all.filter(b => (b.endDate || b.date) < today || !activeStatuses.includes(b.status));
        const pc = getPriorityColors();

        function bookingRow(b) {
          const color = pc[b.priority] || pc.normal;
          const isMultiDay = b.endDate && b.endDate !== b.date;
          const dateLabel = isMultiDay
            ? `${fmtDate(b.date)} ${fmtTime(b.startTime)} – ${fmtDate(b.endDate)} ${fmtTime(b.endTime)}`
            : `${fmtDate(b.date)} &middot; ${fmtTime(b.startTime)}–${fmtTime(b.endTime)}`;
          return `<div class="eq-my-row" data-booking-id="${b.id}">
            <span class="eq-my-dot" style="background:${color}"></span>
            <div class="eq-my-info">
              <strong>${esc(b.equipmentName || '')}</strong>
              <span>${dateLabel}</span>
            </div>
            <span class="eq-my-status eq-my-status--${b.status}">${b.status === 'needs-rebooking' ? 'needs rebooking' : b.status === 'pending-approval' ? 'pending approval' : b.status}</span>
          </div>`;
        }

        content.innerHTML = `
          <div class="eq-my-section">
            <h3>Upcoming</h3>
            ${upcoming.length ? upcoming.map(bookingRow).join('') : '<p class="eq-empty">No upcoming bookings.</p>'}
          </div>
          <div class="eq-my-section">
            <h3>Past / Cancelled</h3>
            ${past.length ? past.map(bookingRow).join('') : '<p class="eq-empty">No past bookings.</p>'}
          </div>`;

        content.querySelectorAll('.eq-my-row').forEach(row => {
          row.addEventListener('click', () => {
            const b = all.find(x => x.id === row.dataset.bookingId);
            if (b) showBookingDetailDirect(b);
          });
        });
        notifyResize();
      })
      .catch(err => {
        console.error('Failed to load bookings:', err);
        content.innerHTML = `<div class="eq-empty" style="padding:2rem;text-align:center">
          <p>Could not load your bookings.</p>
          <p class="eq-muted">${esc(err.message || 'Unknown error')}</p>
        </div>`;
      });
  }

  /* ═══════════════════════════════════════════════════════════
     ADMIN TAB
     ═══════════════════════════════════════════════════════════ */
  function renderAdmin() {
    const content = document.getElementById('eq-content');
    if (!content || !isAdmin()) return;
    content.innerHTML = `
      <div class="eq-admin-nav">
        <button class="eq-admin-btn ${_adminSection === 'devices' ? 'eq-admin-btn--active' : ''}" data-sec="devices">Manage Equipment</button>
        <button class="eq-admin-btn ${_adminSection === 'training' ? 'eq-admin-btn--active' : ''}" data-sec="training">Training</button>
        <button class="eq-admin-btn ${_adminSection === 'settings' ? 'eq-admin-btn--active' : ''}" data-sec="settings">Settings</button>
      </div>
      <div id="eq-admin-content"></div>`;
    content.querySelectorAll('.eq-admin-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _adminSection = btn.dataset.sec;
        renderAdmin();
      });
    });
    if (_adminSection === 'devices') renderAdminDevices();
    else if (_adminSection === 'training') renderAdminTraining();
    else if (_adminSection === 'settings') renderAdminSettings();
  }

  /* ─── Admin: Manage Equipment ───────────────────────────── */
  function renderAdminDevices() {
    const panel = document.getElementById('eq-admin-content');
    if (!panel) return;

    const rows = _equipment.map(e => {
      const statusClass = e.status === 'available' ? 'eq-status--ok' : e.status === 'maintenance' ? 'eq-status--warn' : 'eq-status--off';
      return `<div class="eq-dev-row" data-id="${e.id}">
        <div class="eq-dev-info">
          <strong>${esc(e.name)}</strong>
          <span class="eq-dev-loc">${esc(e.location || '')}</span>
        </div>
        <span class="eq-status-badge ${statusClass}">${e.status}</span>
        <button class="app-btn app-btn--secondary eq-dev-edit" data-id="${e.id}">Edit</button>
        <button class="app-btn app-btn--danger eq-dev-del" data-id="${e.id}">Delete</button>
      </div>`;
    }).join('');

    panel.innerHTML = `
      <div class="eq-admin-panel">
        <div class="eq-admin-panel-head">
          <h3>Equipment (${_equipment.length})</h3>
          <button class="app-btn app-btn--primary" id="eq-add-device">+ Add Equipment</button>
        </div>
        ${rows || '<p class="eq-empty">No equipment configured yet.</p>'}
      </div>`;

    panel.querySelector('#eq-add-device')?.addEventListener('click', () => openDeviceModal());
    panel.querySelectorAll('.eq-dev-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const e = _equipment.find(x => x.id === btn.dataset.id);
        if (e) openDeviceModal(e);
      });
    });
    panel.querySelectorAll('.eq-dev-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this equipment? This cannot be undone.')) return;
        await EDB.deleteEquipment(btn.dataset.id);
        showToast('Equipment deleted');
      });
    });
    notifyResize();
  }

  function openDeviceModal(existing) {
    const isEdit = !!existing;
    const e = existing || {};
    const t = e.training || {};
    const certDefs = getCertDefs();

    const overlay = document.createElement('div');
    overlay.className = 'eq-modal-overlay';
    overlay.innerHTML = `
      <div class="eq-modal eq-modal--wide">
        <div class="eq-modal-header">
          <h3>${isEdit ? 'Edit' : 'Add'} Equipment</h3>
          <button class="eq-modal-close">&times;</button>
        </div>
        <div class="eq-modal-body">
          <div class="eq-form-row">
            <div class="eq-form-group" style="flex:2">
              <label>Name</label>
              <input type="text" id="eq-dev-name" class="eq-input" value="${esc(e.name || '')}" placeholder="Confocal Microscope" />
            </div>
            <div class="eq-form-group" style="flex:1">
              <label>Short Name</label>
              <input type="text" id="eq-dev-short" class="eq-input" value="${esc(e.shortName || '')}" placeholder="Confocal" />
            </div>
          </div>
          <div class="eq-form-row">
            <div class="eq-form-group" style="flex:2">
              <label>Location</label>
              <input type="text" id="eq-dev-loc" class="eq-input" value="${esc(e.location || '')}" placeholder="BSL 211A" />
            </div>
            <div class="eq-form-group" style="flex:1">
              <label>Category</label>
              <select id="eq-dev-cat" class="eq-input">
                ${['microscope','bioprinter','fabrication','imaging','other'].map(c =>
                  `<option value="${c}" ${(e.category || 'other') === c ? 'selected' : ''}>${c}</option>`
                ).join('')}
              </select>
            </div>
          </div>
          <div class="eq-form-group">
            <label>Description</label>
            <textarea id="eq-dev-desc" class="eq-input" rows="2">${esc(e.description || '')}</textarea>
          </div>
          <div class="eq-form-group">
            <label>Status</label>
            <select id="eq-dev-status" class="eq-input">
              ${['available','maintenance','retired'].map(s =>
                `<option value="${s}" ${(e.status || 'available') === s ? 'selected' : ''}>${s}</option>`
              ).join('')}
            </select>
          </div>
          <h4 class="eq-form-section-title">Booking Constraints</h4>
          <div class="eq-form-row">
            <div class="eq-form-group">
              <label>Min Duration (min)</label>
              <input type="number" id="eq-dev-minDur" class="eq-input" value="${e.minDurationMin || 30}" min="15" step="15" />
            </div>
            <div class="eq-form-group">
              <label>Max Duration (min)</label>
              <input type="number" id="eq-dev-maxDur" class="eq-input" value="${e.maxDurationMin || 480}" min="30" step="30" />
            </div>
            <div class="eq-form-group">
              <label>Max Advance (days)</label>
              <input type="number" id="eq-dev-maxAdv" class="eq-input" value="${e.maxAdvanceDays || 30}" min="1" />
            </div>
          </div>
          <div class="eq-form-row">
            <div class="eq-form-group">
              <label>Available From</label>
              <select id="eq-dev-hourStart" class="eq-input">
                ${Array.from({length:24}, (_, i) => i).map(h =>
                  `<option value="${h}" ${(e.availableHours?.start ?? 0) === h ? 'selected' : ''}>${fmtTime(String(h).padStart(2, '0') + ':00')}</option>`
                ).join('')}
              </select>
            </div>
            <div class="eq-form-group">
              <label>Available Until</label>
              <select id="eq-dev-hourEnd" class="eq-input">
                ${Array.from({length:24}, (_, i) => i).map(h =>
                  `<option value="${h}" ${(e.availableHours?.end ?? 24) === h ? 'selected' : ''}>${h === 24 ? '11:59 PM' : fmtTime(String(h).padStart(2, '0') + ':00')}</option>`
                ).join('')}
                <option value="24" ${(e.availableHours?.end ?? 24) === 24 ? 'selected' : ''}>11:59 PM</option>
              </select>
            </div>
          </div>
          <h4 class="eq-form-section-title">Training & Access</h4>
          <div class="eq-form-group">
            <label class="eq-checkbox-label">
              <input type="checkbox" id="eq-dev-trainReq" ${t.required ? 'checked' : ''} />
              Require training / certifications
            </label>
          </div>
          <div id="eq-dev-cert-section" style="display:${t.required ? 'block' : 'none'}">
            <div class="eq-form-group">
              <label>Required Certifications</label>
              <div class="eq-cert-checks">
                ${certDefs.map(c =>
                  `<label class="eq-checkbox-label"><input type="checkbox" value="${c.id}" ${(t.certifications || []).includes(c.id) ? 'checked' : ''} /> ${esc(c.label)}</label>`
                ).join('')}
                ${certDefs.length === 0 ? '<span class="eq-muted">No certifications defined. Add them in Settings.</span>' : ''}
              </div>
            </div>
          </div>
          <div class="eq-form-group">
            <label class="eq-checkbox-label">
              <input type="checkbox" id="eq-dev-coopReq" ${t.requiresCoOperator ? 'checked' : ''} />
              Require co-operator for lower-level users
            </label>
          </div>
          <div id="eq-dev-coop-section" style="display:${t.requiresCoOperator ? 'block' : 'none'}">
            <div class="eq-form-group">
              <label>Minimum co-operator category</label>
              <select id="eq-dev-coopMin" class="eq-input">
                ${CATEGORY_ORDER.slice(0, 4).map(c =>
                  `<option value="${c}" ${(t.coOperatorMinCategory || 'grad') === c ? 'selected' : ''}>${c}</option>`
                ).join('')}
              </select>
            </div>
          </div>
          <div class="eq-form-group">
            <label>Restrict to categories (leave empty for no restriction)</label>
            <div class="eq-cert-checks">
              ${CATEGORY_ORDER.slice(0, 5).map(c =>
                `<label class="eq-checkbox-label"><input type="checkbox" class="eq-dev-catRestrict" value="${c}" ${(t.restrictToCategories || []).includes(c) ? 'checked' : ''} /> ${c}</label>`
              ).join('')}
            </div>
          </div>
          <h4 class="eq-form-section-title">Equipment Managers</h4>
          <div class="eq-form-group">
            <label>Equipment managers (can approve extended bookings)</label>
            <div class="eq-cert-checks" id="eq-dev-managers-list">
              ${_allUsers.filter(u => u.category && u.category !== 'guest').map(u =>
                `<label class="eq-checkbox-label"><input type="checkbox" class="eq-dev-manager" value="${u.uid}" ${(e.managers || []).includes(u.uid) ? 'checked' : ''} /> ${esc(u.name || u.email || u.uid)} (${u.category || ''})</label>`
              ).join('')}
            </div>
          </div>
          <div class="eq-form-group">
            <label>Extended-time users (can exceed max duration without approval)</label>
            <div class="eq-cert-checks" id="eq-dev-extended-list">
              ${_allUsers.filter(u => u.category && u.category !== 'guest').map(u =>
                `<label class="eq-checkbox-label"><input type="checkbox" class="eq-dev-extended" value="${u.uid}" ${(e.extendedTimeUsers || []).includes(u.uid) ? 'checked' : ''} /> ${esc(u.name || u.email || u.uid)} (${u.category || ''})</label>`
              ).join('')}
            </div>
          </div>
          <h4 class="eq-form-section-title">Google Calendar</h4>
          <div class="eq-form-group">
            <label>Google Calendar ID (optional)</label>
            <input type="text" id="eq-dev-gcal" class="eq-input" value="${esc(e.gcalCalendarId || '')}" placeholder="primary or calendar ID" />
          </div>
          <div id="eq-dev-error" class="eq-error"></div>
        </div>
        <div class="eq-modal-footer">
          <button class="app-btn app-btn--secondary eq-modal-cancel">Cancel</button>
          <button class="app-btn app-btn--primary" id="eq-dev-save">${isEdit ? 'Save' : 'Add Equipment'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Toggle training section visibility
    overlay.querySelector('#eq-dev-trainReq').addEventListener('change', (ev) => {
      overlay.querySelector('#eq-dev-cert-section').style.display = ev.target.checked ? 'block' : 'none';
    });
    overlay.querySelector('#eq-dev-coopReq').addEventListener('change', (ev) => {
      overlay.querySelector('#eq-dev-coop-section').style.display = ev.target.checked ? 'block' : 'none';
    });

    overlay.querySelector('.eq-modal-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.eq-modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });

    overlay.querySelector('#eq-dev-save').addEventListener('click', async () => {
      const name = overlay.querySelector('#eq-dev-name').value.trim();
      if (!name) {
        overlay.querySelector('#eq-dev-error').textContent = 'Name is required.';
        return;
      }
      const trainReq = overlay.querySelector('#eq-dev-trainReq').checked;
      const certChecks = overlay.querySelectorAll('#eq-dev-cert-section input[type=checkbox]:checked');
      const certs = Array.from(certChecks).map(c => c.value);
      const catRestricts = Array.from(overlay.querySelectorAll('.eq-dev-catRestrict:checked')).map(c => c.value);

      const data = {
        name,
        shortName: overlay.querySelector('#eq-dev-short').value.trim() || name.split(' ')[0],
        location: overlay.querySelector('#eq-dev-loc').value.trim(),
        category: overlay.querySelector('#eq-dev-cat').value,
        description: overlay.querySelector('#eq-dev-desc').value.trim(),
        status: overlay.querySelector('#eq-dev-status').value,
        minDurationMin: parseInt(overlay.querySelector('#eq-dev-minDur').value) || 30,
        maxDurationMin: parseInt(overlay.querySelector('#eq-dev-maxDur').value) || 480,
        maxAdvanceDays: parseInt(overlay.querySelector('#eq-dev-maxAdv').value) || 30,
        availableHours: {
          start: parseInt(overlay.querySelector('#eq-dev-hourStart').value) || 0,
          end: parseInt(overlay.querySelector('#eq-dev-hourEnd').value) || 24,
        },
        availableDays: [1, 2, 3, 4, 5],
        training: {
          required: trainReq,
          certifications: trainReq ? certs : [],
          requiresCoOperator: overlay.querySelector('#eq-dev-coopReq').checked,
          coOperatorMinCategory: overlay.querySelector('#eq-dev-coopMin').value,
          restrictToCategories: catRestricts,
        },
        managers: Array.from(overlay.querySelectorAll('.eq-dev-manager:checked')).map(c => c.value),
        extendedTimeUsers: Array.from(overlay.querySelectorAll('.eq-dev-extended:checked')).map(c => c.value),
        gcalCalendarId: overlay.querySelector('#eq-dev-gcal').value.trim() || null,
        createdBy: _user.uid,
      };
      if (isEdit) data.id = e.id;

      try {
        await EDB.saveEquipment(data);
        overlay.remove();
        showToast(isEdit ? 'Equipment updated' : 'Equipment added');
      } catch (err) {
        overlay.querySelector('#eq-dev-error').textContent = 'Error: ' + err.message;
      }
    });
  }

  /* ─── Admin: Training Management ────────────────────────── */
  function renderAdminTraining() {
    const panel = document.getElementById('eq-admin-content');
    if (!panel) return;
    panel.innerHTML = '<div class="eq-loading">Loading training data...</div>';

    EDB.getAllTraining().then(allTraining => {
      const certDefs = getCertDefs();
      const users = _allUsers.filter(u => u.category && u.category !== 'guest');

      if (certDefs.length === 0) {
        panel.innerHTML = `<div class="eq-admin-panel">
          <p class="eq-empty">No certifications defined. Add them in the <strong>Settings</strong> tab first.</p>
        </div>`;
        return;
      }

      const headerCols = certDefs.map(c => `<th class="eq-train-th">${esc(c.label)}</th>`).join('');
      const rows = users.map(u => {
        const training = allTraining.find(t => t.id === u.uid);
        const userCerts = new Set((training && training.certifications) || []);
        const cols = certDefs.map(c => {
          const checked = userCerts.has(c.id) ? 'checked' : '';
          return `<td><input type="checkbox" class="eq-train-check" data-uid="${u.uid}" data-cert="${c.id}" ${checked} /></td>`;
        }).join('');
        return `<tr>
          <td class="eq-train-name">${esc(u.name || u.email || u.uid)}<span class="eq-muted"> (${u.category || ''})</span></td>
          ${cols}
        </tr>`;
      }).join('');

      panel.innerHTML = `
        <div class="eq-admin-panel">
          <h3>Training Certifications</h3>
          <div class="eq-table-wrap">
            <table class="eq-train-table">
              <thead><tr><th>Member</th>${headerCols}</tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;

      panel.querySelectorAll('.eq-train-check').forEach(cb => {
        cb.addEventListener('change', async () => {
          const uid = cb.dataset.uid;
          const certId = cb.dataset.cert;
          const existing = allTraining.find(t => t.id === uid);
          const certs = new Set((existing && existing.certifications) || []);
          if (cb.checked) certs.add(certId);
          else certs.delete(certId);
          const user = _allUsers.find(u => u.uid === uid);
          await EDB.setTraining(uid, {
            uid,
            userName: user ? (user.name || user.email) : uid,
            certifications: Array.from(certs),
            grantedBy: _user.uid,
            grantedAt: TS(),
          });
          // Update local cache
          const idx = allTraining.findIndex(t => t.id === uid);
          const updated = { id: uid, uid, certifications: Array.from(certs) };
          if (idx >= 0) allTraining[idx] = updated;
          else allTraining.push(updated);
          showToast('Training updated');
        });
      });
      notifyResize();
    });
  }

  /* ─── Admin: Settings ───────────────────────────────────── */
  function renderAdminSettings() {
    const panel = document.getElementById('eq-admin-content');
    if (!panel) return;
    const s = _settings || {};
    const certDefs = getCertDefs();
    const pc = getPriorityColors();

    panel.innerHTML = `
      <div class="eq-admin-panel">
        <h3>Google Calendar</h3>
        <div class="eq-form-group">
          <label>OAuth Client ID</label>
          <input type="text" id="eq-set-gcalId" class="eq-input" value="${esc(s.gcalClientId || '')}" placeholder="your-client-id.apps.googleusercontent.com" />
        </div>
        <div class="eq-form-row">
          <button class="app-btn app-btn--secondary" id="eq-gcal-connect">${_gcalToken ? 'Connected ✓' : 'Connect Google Calendar'}</button>
          <button class="app-btn app-btn--secondary" id="eq-gcal-sync-all">Sync All Bookings</button>
        </div>
        <div id="eq-gcal-status" class="eq-muted" style="margin-top:.5rem"></div>
      </div>
      <div class="eq-admin-panel">
        <h3>Certification Definitions</h3>
        <div id="eq-cert-list">
          ${certDefs.map((c, i) => `
            <div class="eq-cert-def-row">
              <input type="text" class="eq-input eq-cert-id" value="${esc(c.id)}" placeholder="cert-id" />
              <input type="text" class="eq-input eq-cert-label" value="${esc(c.label)}" placeholder="Certification Label" />
              <button class="app-btn app-btn--danger eq-cert-del" data-idx="${i}">&times;</button>
            </div>`).join('')}
        </div>
        <button class="app-btn app-btn--secondary" id="eq-cert-add" style="margin-top:.5rem">+ Add Certification</button>
      </div>
      <div class="eq-admin-panel">
        <h3>Priority Colors</h3>
        <div class="eq-form-row">
          ${['normal','high','urgent','maintenance'].map(p => `
            <div class="eq-form-group">
              <label>${p}</label>
              <input type="color" class="eq-color-input" data-priority="${p}" value="${pc[p]}" />
            </div>`).join('')}
        </div>
      </div>
      <button class="app-btn app-btn--primary" id="eq-save-settings" style="margin-top:1rem">Save Settings</button>
      <div id="eq-set-error" class="eq-error"></div>`;

    wireAdminSettings(panel);
    notifyResize();
  }

  function wireAdminSettings(panel) {
    // Add certification
    panel.querySelector('#eq-cert-add')?.addEventListener('click', () => {
      const list = panel.querySelector('#eq-cert-list');
      const div = document.createElement('div');
      div.className = 'eq-cert-def-row';
      div.innerHTML = `
        <input type="text" class="eq-input eq-cert-id" placeholder="cert-id" />
        <input type="text" class="eq-input eq-cert-label" placeholder="Certification Label" />
        <button class="app-btn app-btn--danger eq-cert-del">&times;</button>`;
      div.querySelector('.eq-cert-del').addEventListener('click', () => div.remove());
      list.appendChild(div);
    });

    // Delete certification
    panel.querySelectorAll('.eq-cert-del').forEach(btn => {
      btn.addEventListener('click', () => btn.closest('.eq-cert-def-row').remove());
    });

    // Connect Google Calendar
    panel.querySelector('#eq-gcal-connect')?.addEventListener('click', () => {
      connectGoogleCalendar(panel);
    });

    // Sync all bookings
    panel.querySelector('#eq-gcal-sync-all')?.addEventListener('click', async () => {
      await syncAllBookings(panel);
    });

    // Save settings
    panel.querySelector('#eq-save-settings')?.addEventListener('click', async () => {
      const certRows = panel.querySelectorAll('.eq-cert-def-row');
      const certs = Array.from(certRows).map(row => ({
        id: row.querySelector('.eq-cert-id').value.trim(),
        label: row.querySelector('.eq-cert-label').value.trim(),
      })).filter(c => c.id && c.label);

      const colors = {};
      panel.querySelectorAll('.eq-color-input').forEach(inp => {
        colors[inp.dataset.priority] = inp.value;
      });

      const data = {
        gcalClientId: panel.querySelector('#eq-set-gcalId').value.trim(),
        certificationDefs: certs,
        priorityColors: colors,
      };

      try {
        await EDB.saveSettings(data);
        _settings = { ..._settings, ...data };
        showToast('Settings saved');
      } catch (err) {
        panel.querySelector('#eq-set-error').textContent = 'Error: ' + err.message;
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     GOOGLE CALENDAR SYNC
     ═══════════════════════════════════════════════════════════ */
  function connectGoogleCalendar(panel) {
    const clientId = (panel || document).querySelector('#eq-set-gcalId')?.value?.trim()
      || (_settings && _settings.gcalClientId);
    if (!clientId) {
      showToast('Enter an OAuth Client ID first');
      return;
    }
    if (typeof google === 'undefined' || !google.accounts) {
      showToast('Google Identity Services not loaded');
      return;
    }
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: 'https://www.googleapis.com/auth/calendar.events',
      callback: (resp) => {
        if (resp.error) {
          showToast('Google auth failed: ' + resp.error);
          return;
        }
        _gcalToken = resp.access_token;
        sessionStorage.setItem('equip_gcal_token', _gcalToken);
        showToast('Google Calendar connected');
        const btn = document.getElementById('eq-gcal-connect');
        if (btn) btn.textContent = 'Connected ✓';
      },
    });
    tokenClient.requestAccessToken();
  }

  async function syncBookingToGCal(booking, action) {
    const token = _gcalToken || sessionStorage.getItem('equip_gcal_token');
    if (!token) return;
    const equip = _equipment.find(e => e.id === booking.equipmentId);
    const calendarId = (equip && equip.gcalCalendarId) || 'primary';

    try {
      if (action === 'create') {
        const gcalEndDate = booking.endDate || booking.date;
        const event = {
          summary: `${booking.equipmentName}: ${booking.userName}`,
          description: `Priority: ${booking.priority}\n${booking.notes || ''}`.trim(),
          start: { dateTime: `${booking.date}T${booking.startTime}:00`, timeZone: 'America/Phoenix' },
          end: { dateTime: `${gcalEndDate}T${booking.endTime}:00`, timeZone: 'America/Phoenix' },
        };
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
          { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(event) }
        );
        if (res.ok) {
          const data = await res.json();
          await EDB.updateBooking(booking.id, { gcalEventId: data.id });
        }
      } else if (action === 'update' && booking.gcalEventId) {
        const gcalEndDate = booking.endDate || booking.date;
        const event = {
          summary: `${booking.equipmentName}: ${booking.userName}`,
          description: `Priority: ${booking.priority}\n${booking.notes || ''}`.trim(),
          start: { dateTime: `${booking.date}T${booking.startTime}:00`, timeZone: 'America/Phoenix' },
          end: { dateTime: `${gcalEndDate}T${booking.endTime}:00`, timeZone: 'America/Phoenix' },
        };
        await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${booking.gcalEventId}`,
          { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(event) }
        );
      } else if (action === 'cancel' && booking.gcalEventId) {
        await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${booking.gcalEventId}`,
          { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }
        );
      }
    } catch (err) {
      console.warn('GCal sync error:', err);
    }
  }

  async function syncAllBookings(panel) {
    const token = _gcalToken || sessionStorage.getItem('equip_gcal_token');
    if (!token) { showToast('Connect Google Calendar first'); return; }
    const statusEl = panel.querySelector('#eq-gcal-status');
    statusEl.textContent = 'Syncing...';

    const today = todayStr();
    const snap = await db().collection('equipmentBookings')
      .where('date', '>=', today)
      .where('status', '==', 'confirmed')
      .get();
    const bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    let synced = 0;
    for (const b of bookings) {
      if (!b.gcalEventId) {
        await syncBookingToGCal(b, 'create');
        synced++;
      }
    }
    statusEl.textContent = `Done. Synced ${synced} new booking(s) to Google Calendar.`;
    showToast(`Synced ${synced} bookings`);
  }

  /* ═══════════════════════════════════════════════════════════
     TOAST / RESIZE / UTILITIES
     ═══════════════════════════════════════════════════════════ */
  function showToast(msg) {
    let toast = document.getElementById('eq-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'eq-toast';
      toast.className = 'eq-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('eq-toast--show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove('eq-toast--show'), 2500);
  }

  function notifyResize() {
    if (!McgheeLab.AppBridge.isEmbedded()) return;
    requestAnimationFrame(() => {
      const h = document.documentElement.scrollHeight;
      window.parent.postMessage({ type: 'mcgheelab-app-resize', height: h }, window.location.origin);
    });
  }
})();
