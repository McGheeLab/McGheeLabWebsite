/* ================================================================
   Equipment Scheduler — RM-native port (V3.51)
   ================================================================
   Booking system for shared lab instruments (microscopes, printers,
   3D printers, etc). Tab layout: Equipment / Calendar / My Bookings
   / Admin. Weekly CSS-grid calendar (7am-9pm, 30-min slots, 7 days)
   + monthly dot-grid view with per-device filtering. Training
   permission system, co-operator requirement for lower-category
   users, conflict detection in the booking modal, advance-day
   booking limits.

   Admin Google Calendar push-sync: bookings can be mirrored to a
   shared lab calendar via Google Identity Services OAuth (token
   stored in sessionStorage under `equip_gcal_token`). This is
   intentionally LEFT IN sessionStorage for V3.51 — the
   token-storage-to-Firestore refactor is a separate enhancement
   that doesn't block the equipment port. Admins re-OAuth on first
   use per browser session, same as in the standalone lab app.

   Lifted from /apps/equipment/app.js (2,244 LOC) with the same
   lift-and-patch playbook used for V3.41 meetings, V3.49 activity-
   tracker, V3.50 huddle, V3.52 chat:
     1. window.McgheeLab guard at top.
     2. Container id #app → #equipment-root.
     3. db() prefers firebridge.db().
     4. Bootstrap rewrite (lines 145-195 of the lab app) — replaces
        dual AppBridge / direct-Firebase path with the RM contract.
     5. notifyResize() AppBridge.isEmbedded() guard — no-ops cleanly
        without AppBridge.

   firestore.rules: equipment (line 347), equipmentBookings
   (line 354), equipmentTraining (line 362), equipmentSettings
   (line 368) — all in place; no rule changes.
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

(() => {
  'use strict';

  const appEl = document.getElementById('equipment-root');
  if (!appEl) {
    console.warn('[Equipment] #equipment-root container missing');
    return;
  }
  function db() {
    if (typeof firebridge !== 'undefined' && firebridge.db) return firebridge.db();
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
  let _dayIdx = null;             // V3.339: 0-6 (Mon-Sun) day shown on narrow screens; null = not yet picked
  let _monthDate = null;          // { year, month }
  let _selectedEquipId = '';      // '' = all equipment
  let _adminSection = 'devices';  // 'devices' | 'training' | 'settings'

  let _unsubBookings = null;
  let _unsubEquipment = null;
  let _toastTimer = null;
  let _gcalToken = null;

  // V3.597 — notify-me watches. `_watchMode` turns the calendar's
  // drag-select from "book this" into "watch this", so the same gesture
  // serves both without a second interaction to learn.
  let _myWatches = [];
  let _watchMode = false;
  let _watchRange = null;   // 'from..to' of the loaded week; guards re-render loops

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

  /* ─── Criticality (V3.588) ──────────────────────────────────
     The stored `priority` enum is unchanged (normal|high|urgent|
     maintenance) so old bookings keep working and firestore.rules
     needs no edit — only the labels students see change. The
     adjacency notification engine in functions/ weights on the same
     enum: Soft bookings neither exert handoff pressure nor receive
     nudges, Hard bookings radiate the most signal. */
  const PRIORITY_LABELS = {
    normal:      'Soft',
    high:        'Firm',
    urgent:      'Hard',
    maintenance: 'Maintenance'
  };
  const PRIORITY_HINTS = {
    normal:      'Flexible — running late has no downstream effect',
    high:        'Must start on time; duration flexible; high importance',
    urgent:      'Zero flexibility — mission critical',
    maintenance: 'Device blocked for maintenance'
  };
  function priorityLabel(p) { return PRIORITY_LABELS[p] || PRIORITY_LABELS.normal; }
  function priorityHint(p)  { return PRIORITY_HINTS[p]  || PRIORITY_HINTS.normal; }
  function getCertDefs() {
    return (_settings && _settings.certificationDefs) || [];
  }

  /* ─── Category hierarchy ────────────────────────────────── */
  const CATEGORY_ORDER = ['pi', 'postdoc', 'grad', 'undergrad', 'highschool', 'alumni', 'collaborator', 'guest'];
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
      _todayCache.date = null; // V3.340: refresh the equipment-card glance
      return ref.id;
    },
    async updateBooking(id, data) {
      data.updatedAt = TS();
      await db().collection('equipmentBookings').doc(id).update(data);
      _todayCache.date = null;
    },
    async cancelBooking(id) {
      await db().collection('equipmentBookings').doc(id).update({
        status: 'cancelled',
        updatedAt: TS()
      });
      _todayCache.date = null;
    },

    /* Notify-me watches (V3.597).
       Rules allow create + delete + own-read only — `lastNotifiedAt` and
       `status: 'fulfilled'` are Admin-SDK-only, so there is deliberately
       no updateWatch(). Changing a window = delete + create. */
    async createWatch(data) {
      const ref = await db().collection('equipmentWatches').add(
        Object.assign({ status: 'active' }, data, { createdAt: TS() }));
      return ref.id;
    },
    async deleteWatch(id) {
      await db().collection('equipmentWatches').doc(id).delete();
    },
    async listMyWatches(fromDate, toDate) {
      if (!_user) return [];
      let q = db().collection('equipmentWatches').where('uid', '==', _user.uid);
      if (fromDate) q = q.where('date', '>=', fromDate);
      if (toDate) q = q.where('date', '<=', toDate);
      const snap = await q.get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(w => w.status === 'active');
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
  /* ═══════════════════════════════════════════════════════════
     RM bootstrap — replaces the dual AppBridge / direct-Firebase
     path. firebridge.gateSignedIn handles the pending-access
     overlay; whenAuthResolved promises a populated _user/_profile
     before any data load.
     ═══════════════════════════════════════════════════════════ */
  (async function () {
    if (typeof firebridge === 'undefined') {
      console.warn('[Equipment] firebridge not available');
      return;
    }
    if (firebridge.requireSignIn) await firebridge.requireSignIn();

    _user = firebridge.getUser ? firebridge.getUser() : null;
    _profile = firebridge.getProfile ? firebridge.getProfile() : null;
    if (!_user) return; // pending-access overlay handles the guest case

    const now = new Date();
    _monthDate = { year: now.getFullYear(), month: now.getMonth() };
    await Promise.all([loadSettings(), loadTraining(), loadUsers()]);
    render();
    subscribeEquipment();
    subscribeUsers();

    if (McgheeLab.MobileShell && McgheeLab.MobileShell.enableTabSwipe) {
      const tabs = [{ id: 'equipment' }, { id: 'calendar' }, { id: 'mybookings' }];
      if (_profile && _profile.role === 'admin') tabs.push({ id: 'admin' });
      McgheeLab.MobileShell.enableTabSwipe(tabs, () => _currentTab, (id) => { _currentTab = id; render(); });
    }

    // V3.339 — re-render the calendar when crossing the narrow-screen
    // breakpoint (week grid ⇄ single-day view)
    const mq = window.matchMedia('(max-width: 640px)');
    const onBreakpointFlip = () => { if (_currentTab === 'calendar') renderCalendar(); };
    if (mq.addEventListener) mq.addEventListener('change', onBreakpointFlip);
    else if (mq.addListener) mq.addListener(onBreakpointFlip);

    // Re-render on profile-role flips so the Admin tab unlocks
    // immediately after promotion without a manual reload.
    if (firebridge.onAuth) {
      firebridge.onAuth(function () {
        const prevRole = _profile && _profile.role;
        _user = firebridge.getUser ? firebridge.getUser() : _user;
        _profile = firebridge.getProfile ? firebridge.getProfile() : _profile;
        if ((_profile && _profile.role) !== prevRole) render();
      });
    }
  })();

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

  // V3.339 — matches the canonical RM mobile breakpoint (640px). Note:
  // these date helpers deliberately stay local instead of adopting
  // McgheeLab.ScheduleUtils — that module isn't loaded by equipment.html,
  // its getWeekDays returns label objects (not Dates), and its getMonday
  // jumps to NEXT week's Monday when today is Sunday; this file's version
  // handles Sunday correctly.
  function isNarrowScreen() {
    return window.matchMedia('(max-width: 640px)').matches;
  }

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

  /* ─── Availability window (V3.336) ──────────────────────── */
  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Normalized restriction view of a device's posted window, or null when
  // the device is effectively unrestricted (no days saved, all 7 days, or
  // hours spanning the full 0-24 range).
  function availabilityRestrictions(equip) {
    if (!equip) return null;
    const days = Array.isArray(equip.availableDays) ? equip.availableDays : null;
    const hours = equip.availableHours || null;
    const daysRestricted = days && days.length > 0 && days.length < 7;
    const hoursRestricted = hours && (((hours.start ?? 0) > 0) || ((hours.end ?? 24) < 24));
    if (!daysRestricted && !hoursRestricted) return null;
    return {
      days: daysRestricted ? days : null,
      startMin: hoursRestricted ? (hours.start ?? 0) * 60 : 0,
      endMin: hoursRestricted ? (hours.end ?? 24) * 60 : 24 * 60,
    };
  }

  function minToTimeLabel(min) {
    if (min >= 1440) return '11:59 PM';
    const h = Math.floor(min / 60), m = min % 60;
    return fmtTime(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }

  // "Mon–Fri, 8 AM–6 PM" style label; '' when unrestricted.
  function fmtDayList(days) {
    const sorted = [...new Set(days)].sort((a, b) => a - b);
    const runs = [];
    let start = sorted[0], prev = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      const d = sorted[i];
      if (d === prev + 1) { prev = d; continue; }
      runs.push(start === prev ? DAY_LABELS[start] : `${DAY_LABELS[start]}–${DAY_LABELS[prev]}`);
      start = prev = d;
    }
    return runs.join(', ');
  }
  function availabilityLabel(equip) {
    const r = availabilityRestrictions(equip);
    if (!r) return '';
    const dayPart = r.days ? fmtDayList(r.days) : 'every day';
    return `${dayPart}, ${minToTimeLabel(r.startMin)}–${minToTimeLabel(r.endMin)}`;
  }

  // Enforce the device's posted availability window on a proposed booking.
  // Admins and equipment managers bypass (maintenance blocks, supervised
  // after-hours sessions).
  function checkAvailability(equip, date, endDate, start, end) {
    const r = availabilityRestrictions(equip);
    if (!r) return { ok: true };
    if (isAdmin() || isEquipmentManager(equip)) return { ok: true, bypassed: true };
    const label = availabilityLabel(equip);
    const name = equip.shortName || equip.name;
    if (r.days) {
      for (let d = new Date(date + 'T00:00:00'); localDateStr(d) <= endDate; d.setDate(d.getDate() + 1)) {
        if (!r.days.includes(d.getDay())) {
          return { ok: false, reason: `${name} is bookable ${label} — ${DAY_LABELS[d.getDay()]} is outside its available days.` };
        }
      }
    }
    if (r.startMin > 0 || r.endMin < 1440) {
      // An overnight/multi-day booking is by definition outside posted hours
      if (endDate > date) {
        return { ok: false, reason: `${name} is bookable ${label} — overnight bookings need a manager or admin.` };
      }
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      if (sh * 60 + sm < r.startMin || eh * 60 + em > r.endMin) {
        return { ok: false, reason: `${name} is bookable ${label}.` };
      }
    }
    return { ok: true };
  }

  function timeToMin(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }

  /* V3.606 — place a booking on one absolute timeline so overlap is a
   * single comparison regardless of how many days it spans.
   *
   * Comparing bare 'HH:MM' strings only works when both bookings sit on
   * the same day; the moment one spans midnight, "20:00" is EARLIER than
   * "09:00" by string order but LATER in real time. Date.UTC gives a
   * DST-immune day index (Arizona has no DST today, but this must not
   * quietly depend on that). */
  function dayIndex(dateStr) {
    const p = String(dateStr).split('-');
    return Math.floor(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
  }
  function absMin(dateStr, timeStr) {
    return dayIndex(dateStr) * 1440 + timeToMin(timeStr);
  }

  /** Do [aStart,aEnd) and [bStart,bEnd) overlap on the absolute timeline? */
  function rangesOverlap(aStartDate, aStartTime, aEndDate, aEndTime,
                         bStartDate, bStartTime, bEndDate, bEndTime) {
    const aS = absMin(aStartDate, aStartTime), aE = absMin(aEndDate, aEndTime);
    const bS = absMin(bStartDate, bStartTime), bE = absMin(bEndDate, bEndTime);
    if (!(aE > aS) || !(bE > bS)) return false;   // malformed → never conflict
    return bS < aE && bE > aS;
  }

  /* ─── Day glance (V3.340) ───────────────────────────────── */
  // One-shot cache of today's confirmed bookings across ALL devices —
  // the calendar subscription (_bookings) only covers the viewed range,
  // which may not include today.
  let _todayCache = { date: null, pending: false, bookings: [] };
  function ensureTodayBookings() {
    const today = todayStr();
    if (_todayCache.date === today || _todayCache.pending) return;
    _todayCache.pending = true;
    const wideStart = new Date(today + 'T00:00:00');
    wideStart.setDate(wideStart.getDate() - 30); // catch multi-day bookings still running
    db().collection('equipmentBookings')
      .where('date', '>=', localDateStr(wideStart))
      .where('date', '<=', today)
      .get()
      .then(snap => {
        _todayCache = {
          date: today,
          pending: false,
          bookings: snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(b => b.status === 'confirmed' && (b.endDate || b.date) >= today),
        };
        if (_currentTab === 'equipment') renderEquipmentTab();
      })
      .catch(err => {
        console.warn('[Equipment] today-glance fetch failed:', err);
        _todayCache.pending = false;
      });
  }

  // "Free until 2 PM" / "In use until 11:30 AM" / "Closed today" chip
  // for an equipment card. Returns { label, cls } or null.
  function computeDayGlance(e, todaysBookings, now) {
    if (e.status !== 'available') return null;
    const today = localDateStr(now);
    const r = availabilityRestrictions(e);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (r && r.days && !r.days.includes(now.getDay())) return { label: 'Closed today', cls: 'off' };
    const openMin = r ? r.startMin : 0;
    const closeMin = r ? r.endMin : 1440;
    if (nowMin >= closeMin) return { label: 'Closed for today', cls: 'off' };
    // Today's confirmed intervals for this device, as minutes-of-day
    const iv = todaysBookings
      .filter(b => b.equipmentId === e.id)
      .map(b => [
        b.date < today ? 0 : timeToMin(b.startTime),
        (b.endDate || b.date) > today ? 1440 : timeToMin(b.endTime),
      ])
      .sort((a, b) => a[0] - b[0]);
    // If now is inside a booking, walk chained bookings to the real free point
    let busyUntil = null;
    for (const [s, en] of iv) {
      if (busyUntil === null) {
        if (nowMin >= s && nowMin < en) busyUntil = en;
      } else if (s <= busyUntil) {
        busyUntil = Math.max(busyUntil, en);
      }
    }
    if (busyUntil !== null) {
      if (busyUntil >= closeMin) {
        return { label: closeMin < 1440 ? 'Booked until close' : 'Booked all day', cls: 'busy' };
      }
      return { label: `In use until ${minToTimeLabel(busyUntil)}`, cls: 'busy' };
    }
    if (nowMin < openMin) return { label: `Opens at ${minToTimeLabel(openMin)}`, cls: 'off' };
    const next = iv.find(([s]) => s > nowMin);
    if (next) return { label: `Free until ${minToTimeLabel(next[0])}`, cls: 'free' };
    return (r && closeMin < 1440)
      ? { label: `Free until close (${minToTimeLabel(closeMin)})`, cls: 'free' }
      : { label: 'Free rest of day', cls: 'free' };
  }

  // True when a 30-min grid slot falls outside the device's posted window.
  function isSlotClosed(equip, jsDay, slotTime) {
    const r = availabilityRestrictions(equip);
    if (!r) return false;
    if (r.days && !r.days.includes(jsDay)) return true;
    const [h, m] = slotTime.split(':').map(Number);
    const slotMin = h * 60 + m;
    return slotMin < r.startMin || slotMin + 30 > r.endMin;
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

    // Today's confirmed bookings across all devices (V3.340: one-shot
    // fetch — _bookings only covers the calendar's viewed range). Falls
    // back to _bookings until the fetch lands, then re-renders.
    ensureTodayBookings();
    const today = todayStr();
    const glanceReady = _todayCache.date === today;
    const todayBookings = glanceReady
      ? _todayCache.bookings
      : _bookings.filter(b => b.status === 'confirmed' && b.date <= today && (b.endDate || b.date) >= today);
    const now = new Date();

    function equipCard(e) {
      const icon = CATEGORY_ICONS[e.category] || CATEGORY_ICONS.other;
      const statusClass = e.status === 'available' ? 'eq-ecard-status--ok' : e.status === 'maintenance' ? 'eq-ecard-status--warn' : 'eq-ecard-status--off';
      const todayCount = todayBookings.filter(b => b.equipmentId === e.id).length;
      const glance = glanceReady ? computeDayGlance(e, todayBookings, now) : null;
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
            ${glance ? `<span class="eq-ecard-glance eq-ecard-glance--${glance.cls}">${esc(glance.label)}</span>` : ''}
            ${e.location ? `<span class="eq-ecard-tag">${ICON.svg('map-pin')} ${esc(e.location)}</span>` : ''}
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
      `<span class="eq-legend-item" title="${esc(priorityHint(k))}"><span class="eq-legend-dot" style="background:${c}"></span>${priorityLabel(k)}</span>`
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
            ${_calView === 'week' ? `<button class="app-btn ${_watchMode ? 'app-btn--primary' : 'app-btn--secondary'}" id="eq-watch-mode"
              title="Drag across the calendar to be notified if that time frees up">${ICON.svg('bell')} ${_watchMode ? 'Watching — drag a window' : 'Notify me'}</button>` : ''}
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
        ${_watchMode ? `<div class="eq-watch-banner">Drag across a busy stretch to be
          notified if it frees up. Your watches show as hatched bands.</div>` : ''}
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
    // V3.597 — flip the drag gesture between booking and watching.
    const watchBtn = document.getElementById('eq-watch-mode');
    if (watchBtn) watchBtn.addEventListener('click', () => {
      _watchMode = !_watchMode;
      renderCalendar();
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
    if (_calView === 'week') {
      // V3.597 — watch bands need the visible week's watches. Paint now
      // with whatever we have (usually correct, since the range only
      // changes on navigation) and repaint once if a fetch was needed.
      // `_watchRange` guards against a render → load → render loop.
      const wd = getWeekDays(_weekOffset);
      const from = localDateStr(wd[0]), to = localDateStr(wd[6]);
      const rangeKey = from + '..' + to;
      if (_watchRange !== rangeKey) {
        _watchRange = rangeKey;
        loadMyWatches(from, to).then(() => {
          // Only repaint if we're still on the same week + view.
          if (_calView === 'week' && _watchRange === rangeKey) renderCalendarBody();
        });
      }
      renderWeekView(body);
    } else {
      renderMonthView(body);
    }
    notifyResize();
  }

  /* ─── Week View ─────────────────────────────────────────── */
  function renderWeekView(container) {
    const weekDays = getWeekDays(_weekOffset);
    const today = todayStr();
    // V3.339 — on narrow screens show a single day with a day-chip pager
    // instead of cramming 7 columns onto a phone
    const narrow = isNarrowScreen();
    if (narrow && _dayIdx === null) {
      const ti = weekDays.findIndex(d => localDateStr(d) === today);
      _dayIdx = ti >= 0 ? ti : 0;
    }
    if (_dayIdx !== null) _dayIdx = Math.max(0, Math.min(6, _dayIdx));
    const days = narrow ? [weekDays[_dayIdx]] : weekDays;
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

    // Grid cells (clickable). With a device filter active, slots outside the
    // device's posted availability window render greyed (V3.336).
    const selEquip = _selectedEquipId ? _equipment.find(e => e.id === _selectedEquipId) : null;
    let cells = '';
    days.forEach((d, col) => {
      const ds = localDateStr(d);
      const jsDay = d.getDay();
      slots.forEach((t, row) => {
        const closed = selEquip && isSlotClosed(selEquip, jsDay, t);
        cells += `<div class="eq-wk-cell${closed ? ' eq-wk-cell--closed' : ''}"${closed ? ' data-closed="1"' : ''} data-date="${ds}" data-time="${t}" style="grid-column:${col + 2};grid-row:${row + 2}"></div>`;
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

    // V3.597 — the user's own notify-me watch windows, drawn as hatched
    // bands ABOVE the cells but BELOW the sticky headers (z-index 2 vs 1
    // and 3). pointer-events stay off the band itself so drag-to-book
    // still works through it; only the 🔔✕ pill is clickable.
    let watchBands = '';
    _myWatches.forEach(w => {
      const dayIdx = days.findIndex(d => localDateStr(d) === w.date);
      if (dayIdx < 0) return;
      if (_selectedEquipId && w.equipmentId !== _selectedEquipId) return;
      const startRow = timeToRow(w.startTime);
      const endRow = timeToRow(w.endTime);
      const span = endRow - startRow;
      if (span <= 0) return;
      const eqObj = _equipment.find(e => e.id === w.equipmentId);
      const eqLabel = eqObj ? (eqObj.shortName || eqObj.name) : (w.equipmentName || '');
      watchBands += `<div class="eq-wk-watch" data-watch-id="${w.id}"
        style="grid-column:${dayIdx + 2};grid-row:${startRow + 1}/span ${span};"
        title="Watching ${esc(eqLabel)} ${fmtTime(w.startTime)}–${fmtTime(w.endTime)} — you'll be notified if it frees up">
        <button type="button" class="eq-wk-watch-x" data-watch-del="${w.id}" aria-label="Stop watching">${ICON.svg('bell')}✕</button>
      </div>`;
    });

    const slotH = ZOOM_LEVELS[_zoomIdx];

    // Preserve scroll position across re-renders (zoom, booking updates)
    const oldWrap = container.querySelector('.eq-week-wrap');
    const prevScrollTop = oldWrap ? oldWrap.scrollTop : null;
    const prevSlotH = oldWrap ? parseFloat(oldWrap.dataset.slotH || '0') : 0;

    // V3.339 — day-chip pager for the narrow-screen single-day view
    const dayChips = !narrow ? '' : `<div class="eq-day-pager">${weekDays.map((d, i) => {
      const ds = localDateStr(d);
      return `<button class="eq-day-chip ${i === _dayIdx ? 'eq-day-chip--active' : ''} ${ds === today ? 'eq-day-chip--today' : ''}" data-day-idx="${i}">
        ${d.toLocaleDateString('en-US', { weekday: 'short' })}<span class="eq-day-chip-num">${d.getDate()}</span>
      </button>`;
    }).join('')}</div>`;

    container.innerHTML = `
      ${dayChips}
      <div class="eq-cal-scroll-area">
        <div class="eq-week-wrap" data-slot-h="${slotH}">
          <div class="eq-week-grid ${narrow ? 'eq-week-grid--day' : ''}" style="grid-template-rows:auto repeat(${slots.length},${slotH}px);">
            <div class="eq-wk-corner eq-wk-sticky-head"></div>
            ${dayHeaders}
            ${timeLabels}
            ${cells}
            ${blocks}
            ${watchBands}
          </div>
        </div>
        <div class="eq-time-slider" id="eq-time-slider">
          <div class="eq-time-slider-track"></div>
          <div class="eq-time-slider-thumb" id="eq-time-slider-thumb"></div>
        </div>
      </div>`;

    wireWeekGrid(container);
    container.querySelectorAll('.eq-day-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        _dayIdx = parseInt(chip.dataset.dayIdx);
        renderCalendarBody();
      });
    });
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
    // V3.336 — drag-to-book can't start in or extend into closed slots;
    // admins/managers keep the bypass (they can still book via the modal).
    const selEquip = _selectedEquipId ? _equipment.find(e => e.id === _selectedEquipId) : null;
    const canBypassClosed = selEquip ? (isAdmin() || isEquipmentManager(selEquip)) : false;
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
        if (cell.dataset.closed && !canBypassClosed) return;
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
      if (el.dataset.closed && !canBypassClosed) return;
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
      // V3.597 — same gesture, two meanings. Watch mode short-circuits
      // before the booking modal.
      if (_watchMode) { openWatchConfirm(startDate, startTime, endTime); return; }
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

    // V3.597 — 🔔✕ on a watch band stops the watch.
    container.querySelectorAll('[data-watch-del]').forEach(btn => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.watchDel;
        try {
          await EDB.deleteWatch(id);
          _myWatches = _myWatches.filter(w => w.id !== id);
          showToast('Watch removed');
          renderCalendarBody();
        } catch (err) {
          showToast('Could not remove watch: ' + err.message);
        }
      });
    });
  }

  /* ─── Notify-me watches (V3.597) ──────────────────────────── */

  /**
   * Is any live booking sitting in this window? Reads the already-
   * subscribed `_bookings`, so it costs no query. Single-day only, which
   * matches what a watch can express.
   *
   * (openBookingModal has its own async checkConflicts() for the booking
   * flow — that one is nested in the modal closure and reports WHO
   * clashes for the displacement UI. This only needs a yes/no.)
   */
  function hasBookingOverlap(equipmentId, date, startTime, endTime) {
    return _bookings.some(b => {
      if (b.equipmentId !== equipmentId) return false;
      if (b.status === 'cancelled' || b.status === 'needs-rebooking') return false;
      // V3.606 — was `(b.endDate || b.date) !== date → skip`, which made an
      // overnight booking invisible here, so a window it fully covered was
      // offered as "already free".
      return rangesOverlap(date, startTime, date, endTime,
                           b.date, b.startTime, b.endDate || b.date, b.endTime);
    });
  }

  /**
   * Confirm a dragged watch window. Two things this deliberately does:
   *
   *  - Requires a device. A watch has to name one instrument; "notify me
   *    if ANY scope frees up" is a different feature.
   *  - Checks whether the window is ALREADY free, and offers to book it
   *    instead. Watching time you could just take is the most obvious way
   *    to waste a student's afternoon.
   */
  async function openWatchConfirm(date, startTime, endTime) {
    const eqId = _selectedEquipId;
    if (!eqId) {
      showToast('Pick one device in the filter first — a watch needs a specific instrument.');
      return;
    }
    const eq = _equipment.find(e => e.id === eqId);
    if (!eq) { showToast('Unknown device'); return; }

    // Note the arg order: (equip, date, endDate, start, end).
    const avail = checkAvailability(eq, date, date, startTime, endTime);
    const alreadyFree = avail.ok && !hasBookingOverlap(eqId, date, startTime, endTime);

    const overlay = document.createElement('div');
    overlay.className = 'eq-modal-overlay';
    overlay.innerHTML = `
      <div class="eq-modal eq-modal--narrow">
        <div class="eq-modal-header">
          <h3>${ICON.svg('bell')} Notify me if it frees up</h3>
          <button class="eq-modal-close">&times;</button>
        </div>
        <div class="eq-modal-body">
          <p class="eq-watch-target"><strong>${esc(eq.shortName || eq.name)}</strong><br>
            ${esc(date)} · ${fmtTime(startTime)}–${fmtTime(endTime)}</p>
          ${alreadyFree
            ? `<div class="eq-watch-free">This window is <strong>already free</strong> — you can
                 book it right now instead of waiting.</div>`
            : `<p class="eq-watch-note">You'll get one notification if a usable gap
                 (30 min or more) opens up in this window. The watch stays active until the
                 day passes or you book the device — it won't spam you.</p>`}
        </div>
        <div class="eq-modal-footer">
          <button class="app-btn app-btn--secondary" id="eq-watch-cancel">Cancel</button>
          ${alreadyFree ? '<button class="app-btn app-btn--primary" id="eq-watch-book">Book it now</button>' : ''}
          <button class="app-btn ${alreadyFree ? 'app-btn--secondary' : 'app-btn--primary'}" id="eq-watch-save">
            ${alreadyFree ? 'Watch anyway' : 'Notify me'}</button>
        </div>
      </div>`;

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.eq-modal-close').addEventListener('click', close);
    overlay.querySelector('#eq-watch-cancel').addEventListener('click', close);

    overlay.querySelector('#eq-watch-book')?.addEventListener('click', () => {
      close();
      openBookingModal({ date, endDate: date, startTime, endTime });
    });

    overlay.querySelector('#eq-watch-save').addEventListener('click', async () => {
      try {
        const id = await EDB.createWatch({
          uid: _user.uid,
          userName: _profile?.name || _user.displayName || _user.email || '',
          equipmentId: eqId,
          equipmentName: eq.shortName || eq.name,
          date, startTime, endTime,
        });
        _myWatches.push({
          id, uid: _user.uid, equipmentId: eqId,
          equipmentName: eq.shortName || eq.name,
          date, startTime, endTime, status: 'active',
        });
        close();
        showToast(`Watching ${eq.shortName || eq.name} — we'll tell you if it frees up.`);
        renderCalendarBody();
      } catch (err) {
        showToast('Could not save watch: ' + err.message);
      }
    });

    document.body.appendChild(overlay);
  }

  /** Own active watches for the visible week; failure is non-fatal. */
  async function loadMyWatches(fromDate, toDate) {
    try {
      _myWatches = await EDB.listMyWatches(fromDate, toDate);
    } catch (err) {
      console.warn('[equipment] watch load failed:', err && err.message);
      _myWatches = [];
    }
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
    // V3.336 — with a device filter active, tint days outside its window
    const selEquip = _selectedEquipId ? _equipment.find(eq => eq.id === _selectedEquipId) : null;
    const selRestrict = selEquip ? availabilityRestrictions(selEquip) : null;

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
        const closedDay = selRestrict && selRestrict.days && !selRestrict.days.includes(date.getDay());
        html += `<div class="eq-month-cell ${isToday ? 'eq-month-cell--today' : ''} ${!inMonth ? 'eq-month-cell--out' : ''} ${closedDay ? 'eq-month-cell--closed' : ''}" data-date="${ds}">
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
        _dayIdx = (d.getDay() + 6) % 7; // land on the clicked day in the narrow single-day view
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
    const preEquipId = editBooking ? editBooking.equipmentId
      : ((prefill && prefill.equipId) || _selectedEquipId || (equip[0] ? equip[0].id : ''));
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
      `<option value="${p}" ${p === prePriority ? 'selected' : ''}>${priorityLabel(p)}</option>`
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
          <div id="eq-bk-avail-msg"></div>
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
          <div class="eq-dur-chips">
            ${[30, 60, 120, 240].map(m =>
              `<button type="button" class="eq-dur-chip" data-min="${m}">${m < 60 ? m + ' min' : (m / 60) + ' hr'}</button>`
            ).join('')}
            <button type="button" class="eq-dur-chip" data-min="max">Max</button>
          </div>
          <div class="eq-form-group">
            <label>How critical is this booking?</label>
            <div class="eq-priority-row">
              <select id="eq-bk-priority" class="eq-input">${priorityOpts}${isAdmin() ? '<option value="maintenance">Maintenance</option>' : ''}</select>
              <span class="eq-priority-preview" id="eq-bk-priority-dot"></span>
            </div>
            <div class="eq-priority-hint" id="eq-bk-priority-hint"></div>
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
      const hint = overlay.querySelector('#eq-bk-priority-hint');
      if (hint) hint.textContent = priorityHint(p);
    }

    // V3.336 — show the device's posted window and flag violations live
    function updateAvailabilityUI() {
      const eqId = overlay.querySelector('#eq-bk-equip').value;
      const eq = _equipment.find(x => x.id === eqId);
      const el = overlay.querySelector('#eq-bk-avail-msg');
      if (!availabilityRestrictions(eq)) { el.innerHTML = ''; return; }
      const name = eq.shortName || eq.name;
      const label = availabilityLabel(eq);
      const date = overlay.querySelector('#eq-bk-date').value;
      const endDate = overlay.querySelector('#eq-bk-end-date').value;
      const start = overlay.querySelector('#eq-bk-start').value;
      const end = overlay.querySelector('#eq-bk-end').value;
      const check = (date && endDate && start && end)
        ? checkAvailability(eq, date, endDate, start, end)
        : { ok: true };
      if (!check.ok) {
        el.innerHTML = `<div class="eq-avail-line eq-avail-line--violation">${ICON.svg('clock')} ${esc(check.reason)}</div>`;
      } else {
        const suffix = check.bypassed ? ' — manager/admin override active' : '';
        el.innerHTML = `<div class="eq-avail-line">${ICON.svg('clock')} ${esc(name)} is bookable ${esc(label)}${esc(suffix)}</div>`;
      }
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
          // V3.606 — ONE comparison on the absolute timeline. This used to
          // be a five-branch ladder over date boundaries that ended in an
          // unconditional `return true`, so whenever the NEW booking was
          // multi-day every branch missed and the time check never ran:
          // an overnight booking was reported as displacing every other
          // booking on the days it touched, however far apart the hours.
          return rangesOverlap(date, start, endDate, end,
                               b.date, b.startTime, bEndDate, b.endTime);
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
            <strong>${ICON.svg('exclamation-triangle')} This will displace existing booking${_conflictDocs.length > 1 ? 's' : ''}:</strong> ${names}
            <div style="margin-top:.3rem;font-size:.75rem">Their booking${_conflictDocs.length > 1 ? 's' : ''} will be moved to <strong>"needs rebooking"</strong> status and they will need to find a new time.</div>
            <label class="eq-checkbox-label" style="margin-top:.4rem">
              <input type="checkbox" id="eq-bk-displace-confirm" />
              I have permission from the above user${_conflictDocs.length > 1 ? 's' : ''} to move their booking${_conflictDocs.length > 1 ? 's' : ''}
            </label>
          </div>`;
      } else {
        conflictsEl.innerHTML = '';
      }
    }

    // Wire events
    overlay.querySelector('#eq-bk-equip').addEventListener('change', () => { updatePermissionUI(); updateAvailabilityUI(); checkConflicts(); });
    overlay.querySelector('#eq-bk-date').addEventListener('change', () => {
      // Auto-advance end date if it's before start date
      const endDateEl = overlay.querySelector('#eq-bk-end-date');
      if (endDateEl.value < overlay.querySelector('#eq-bk-date').value) {
        endDateEl.value = overlay.querySelector('#eq-bk-date').value;
      }
      updateAvailabilityUI();
      checkConflicts();
    });
    overlay.querySelector('#eq-bk-end-date').addEventListener('change', () => { updateAvailabilityUI(); checkConflicts(); });
    overlay.querySelector('#eq-bk-start').addEventListener('change', () => { updateAvailabilityUI(); checkConflicts(); });
    overlay.querySelector('#eq-bk-end').addEventListener('change', () => { updateAvailabilityUI(); checkConflicts(); });
    overlay.querySelector('#eq-bk-priority').addEventListener('change', updatePriorityDot);
    // V3.340 — duration quick-picks: set end date/time from start + duration
    overlay.querySelectorAll('.eq-dur-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const eqSel = _equipment.find(x => x.id === overlay.querySelector('#eq-bk-equip').value);
        const mins = chip.dataset.min === 'max'
          ? ((eqSel && eqSel.maxDurationMin) || 480)
          : parseInt(chip.dataset.min);
        const date = overlay.querySelector('#eq-bk-date').value;
        const start = overlay.querySelector('#eq-bk-start').value;
        if (!date || !start) return;
        // Snap to the 30-min slot grid the end-time select offers
        let endMin = Math.round((timeToMin(start) + mins) / 30) * 30;
        const endDateEl = overlay.querySelector('#eq-bk-end-date');
        if (endMin >= 1440) {
          const d = new Date(date + 'T00:00:00');
          d.setDate(d.getDate() + Math.floor(endMin / 1440));
          endDateEl.value = localDateStr(d);
          endMin = endMin % 1440;
        } else {
          endDateEl.value = date;
        }
        overlay.querySelector('#eq-bk-end').value =
          `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
        updateAvailabilityUI();
        checkConflicts();
      });
    });
    overlay.querySelector('.eq-modal-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.eq-modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#eq-bk-submit').addEventListener('click', async () => {
      const errorEl = overlay.querySelector('#eq-bk-error');
      // Re-check conflicts before submitting to avoid race conditions
      // Save checkbox state so a re-check with the same conflicts doesn't reset it
      const prevConfirmCb = overlay.querySelector('#eq-bk-displace-confirm');
      const prevChecked = prevConfirmCb ? prevConfirmCb.checked : false;
      const prevConflictIds = new Set(_conflictDocs.map(c => c.id));
      try {
        await checkConflicts();
      } catch (err) {
        errorEl.textContent = 'Error checking conflicts: ' + err.message;
        return;
      }
      // Restore checkbox if the set of conflicting bookings hasn't changed
      const newConflictIds = new Set(_conflictDocs.map(c => c.id));
      if (prevChecked && newConflictIds.size === prevConflictIds.size && [...newConflictIds].every(id => prevConflictIds.has(id))) {
        const cb = overlay.querySelector('#eq-bk-displace-confirm');
        if (cb) cb.checked = true;
      }

      const eqId = overlay.querySelector('#eq-bk-equip').value;
      const date = overlay.querySelector('#eq-bk-date').value;
      const endDate = overlay.querySelector('#eq-bk-end-date').value;
      const start = overlay.querySelector('#eq-bk-start').value;
      const end = overlay.querySelector('#eq-bk-end').value;
      const priority = overlay.querySelector('#eq-bk-priority').value;
      const notes = overlay.querySelector('#eq-bk-notes').value.trim();
      const coopUid = overlay.querySelector('#eq-bk-coop') ? overlay.querySelector('#eq-bk-coop').value : '';
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

      // Availability window check (V3.336) — posted hours/days are enforced
      const avail = checkAvailability(eq, date, endDate, start, end);
      if (!avail.ok) {
        errorEl.textContent = avail.reason;
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
          // V3.844 — recorded for the person: "Booked the confocal · Thu 23 Oct 10:00–12:00" (reads "Used" once the slot has passed)
          try { if (window.USER_ACTIONS) USER_ACTIONS.record(USER_ACTIONS.fromBooking(newId, bookingData)).catch(() => {}); } catch (e) {}
          // Mark displaced bookings as needs-rebooking (only for confirmed bookings)
          if (!needsApproval) {
            for (const cb of _conflictDocs) {
              await EDB.updateBooking(cb.id, { status: 'needs-rebooking', displacedBy: _user.uid, displacedByName: _profile.name || _user.displayName || _user.email });
            }
          }
          if (!needsApproval) await syncBookingToGCal({ id: newId, ...bookingData }, 'create');
          showToast(needsApproval ? 'Booking submitted for manager approval' : (_conflictDocs.length ? 'Booking confirmed — displaced bookings marked for rebooking' : 'Booking confirmed'));
          // V3.530 — double-dip: offer to fan the booking out (huddle
          // plan, notebook stub, tracker event) via My Week.
          if (window.DAY_DISTRIBUTE) DAY_DISTRIBUTE.renderChipsFloating({
            source: 'equipment', type: 'equipment',
            nativeDocPath: 'equipmentBookings/' + newId,
            draft: {
              title: notes || ('Session on ' + bookingData.equipmentName),
              date, startTime: start, endTime: end,
              details: { equipmentId: eqId, equipmentName: bookingData.equipmentName },
            },
          });
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
    updateAvailabilityUI();
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
          <div class="eq-detail-row"><strong>Criticality:</strong> <span class="eq-priority-badge" style="background:${color}33;color:${color}">${priorityLabel(b.priority)}</span> <span class="eq-detail-hint">${esc(priorityHint(b.priority))}</span></div>
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

        function bookingRow(b, isPast) {
          const color = pc[b.priority] || pc.normal;
          const isMultiDay = b.endDate && b.endDate !== b.date;
          const dateLabel = isMultiDay
            ? `${fmtDate(b.date)} ${fmtTime(b.startTime)} – ${fmtDate(b.endDate)} ${fmtTime(b.endTime)}`
            : `${fmtDate(b.date)} &middot; ${fmtTime(b.startTime)}–${fmtTime(b.endTime)}`;
          // V3.340 — one-tap rebook of a past/cancelled slot (only for
          // devices still in the catalog and bookable)
          const canRebook = isPast && _equipment.some(e => e.id === b.equipmentId && e.status === 'available');
          return `<div class="eq-my-row" data-booking-id="${b.id}">
            <span class="eq-my-dot" style="background:${color}"></span>
            <div class="eq-my-info">
              <strong>${esc(b.equipmentName || '')}</strong>
              <span>${dateLabel}</span>
            </div>
            ${canRebook ? `<button class="app-btn app-btn--secondary eq-my-rebook" data-booking-id="${b.id}">Rebook</button>` : ''}
            <span class="eq-my-status eq-my-status--${b.status}">${b.status === 'needs-rebooking' ? 'needs rebooking' : b.status === 'pending-approval' ? 'pending approval' : b.status}</span>
          </div>`;
        }

        content.innerHTML = `
          <div class="eq-my-section">
            <h3>Upcoming</h3>
            ${upcoming.length ? upcoming.map(b => bookingRow(b, false)).join('') : '<p class="eq-empty">No upcoming bookings.</p>'}
          </div>
          <div class="eq-my-section">
            <h3>Past / Cancelled</h3>
            ${past.length ? past.map(b => bookingRow(b, true)).join('') : '<p class="eq-empty">No past bookings.</p>'}
          </div>`;

        content.querySelectorAll('.eq-my-row').forEach(row => {
          row.addEventListener('click', () => {
            const b = all.find(x => x.id === row.dataset.bookingId);
            if (b) showBookingDetailDirect(b);
          });
        });
        content.querySelectorAll('.eq-my-rebook').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const b = all.find(x => x.id === btn.dataset.bookingId);
            if (!b) return;
            const today = todayStr();
            openBookingModal({
              equipId: b.equipmentId,
              date: today,
              endDate: today,
              startTime: b.startTime,
              endTime: b.endTime,
            });
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
          <div class="eq-form-group">
            <label>Available days (bookings outside these days are blocked)</label>
            <div class="eq-cert-checks eq-day-checks">
              ${[1, 2, 3, 4, 5, 6, 0].map(d =>
                `<label class="eq-checkbox-label"><input type="checkbox" class="eq-dev-day" value="${d}" ${(e.availableDays || [1, 2, 3, 4, 5]).includes(d) ? 'checked' : ''} /> ${DAY_LABELS[d]}</label>`
              ).join('')}
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
      // No days checked = open all week (avoids accidentally bricking a device)
      const dayChecks = Array.from(overlay.querySelectorAll('.eq-dev-day:checked')).map(c => parseInt(c.value));
      const availableDays = dayChecks.length ? dayChecks : [0, 1, 2, 3, 4, 5, 6];

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
        availableDays,
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
        <h3>Criticality Colors</h3>
        <div class="eq-form-row">
          ${['normal','high','urgent','maintenance'].map(p => `
            <div class="eq-form-group">
              <label>${priorityLabel(p)} <span class="eq-label-sub">(${p})</span></label>
              <input type="color" class="eq-color-input" data-priority="${p}" value="${pc[p]}" />
            </div>`).join('')}
        </div>
      </div>
      <div class="eq-admin-panel">
        <h3>Shift-change Notifications</h3>
        <p class="eq-panel-note">When two bookings on one device sit this close
          together, the lab treats it as a handoff: the person finishing gets
          told to be on time, and both sides hear when the other one moves or
          cancels. Soft bookings never trigger these.</p>
        <div class="eq-form-row">
          <div class="eq-form-group">
            <label>Handoff gap threshold (minutes)</label>
            <input type="number" min="0" max="240" step="5" class="eq-input"
                   id="eq-set-adjgap" value="${Number(_settings?.adjacencyGapMin ?? 30)}" />
          </div>
          <div class="eq-form-group">
            <label>Repeat-notice cooldown (minutes)</label>
            <input type="number" min="0" max="60" step="1" class="eq-input"
                   id="eq-set-adjsuppress" value="${Number(_settings?.adjacencySuppressMin ?? 3)}" />
          </div>
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

      // V3.594 — clamp the shift-change thresholds client-side; the Cloud
      // Function also falls back to defaults on a non-finite read, so a
      // blanked field can never disable notifications by accident.
      const gapRaw = Number(panel.querySelector('#eq-set-adjgap')?.value);
      const supRaw = Number(panel.querySelector('#eq-set-adjsuppress')?.value);

      const data = {
        gcalClientId: panel.querySelector('#eq-set-gcalId').value.trim(),
        certificationDefs: certs,
        priorityColors: colors,
        adjacencyGapMin: Number.isFinite(gapRaw) ? Math.max(0, Math.min(240, gapRaw)) : 30,
        adjacencySuppressMin: Number.isFinite(supRaw) ? Math.max(0, Math.min(60, supRaw)) : 3,
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
          description: `Criticality: ${priorityLabel(booking.priority)}\n${booking.notes || ''}`.trim(),
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
          description: `Criticality: ${priorityLabel(booking.priority)}\n${booking.notes || ''}`.trim(),
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
    // V3.336 — delegate to the shared RM toast (rm/js/toast.js, already
    // loaded by equipment.html); keep the local fallback just in case.
    if (window.TOAST && window.TOAST.success) { window.TOAST.success(msg); return; }
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
    // V3.51: RM is the parent window — no iframe-resize postMessage to fire.
    // Guard the AppBridge lookup so the no-op is safe even if
    // McgheeLab.AppBridge is undefined (which it is in RM).
    if (!McgheeLab.AppBridge || !McgheeLab.AppBridge.isEmbedded || !McgheeLab.AppBridge.isEmbedded()) return;
    requestAnimationFrame(() => {
      const h = document.documentElement.scrollHeight;
      window.parent.postMessage({ type: 'mcgheelab-app-resize', height: h }, window.location.origin);
    });
  }
})();
