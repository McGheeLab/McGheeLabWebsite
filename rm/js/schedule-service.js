/* ================================================================
   schedule-service.js — Shared schedule data layer
   ================================================================
   Manages schedule templates, overrides, custom events, and
   resolution logic. Used by both the Scheduler app (read/write)
   and the Huddle app (read-only for team availability & overlap).

   Loaded via <script defer> in each app's index.html.
   Exposes McgheeLab.ScheduleService on the global namespace.

   Depends on: McgheeLab.ScheduleUtils (schedule-utils.js)
   Optional:   McgheeLab.CalendarService (calendar-service.js)
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

McgheeLab.ScheduleService = (() => {
  'use strict';

  const U = () => McgheeLab.ScheduleUtils;

  /* ─── State ──────────────────────────────────────────────── */
  let _user = null;
  let _profile = null;
  let _initialized = false;

  // Schedule data
  let _allTemplates = [];
  let _allOverrides = [];
  let _scheduleTemplate = null;  // current user's template
  let _customEvents = [];        // current user's custom events

  // Firestore listeners
  let _unsubTemplates = null;
  let _unsubOverrides = null;
  let _unsubCustomEvents = null;

  // Week offset for override scoping
  let _weekOffset = 0;

  // Listeners
  let _listeners = [];

  // Layer config (persisted in userSettings)
  let _layerConfig = { recurring: true, overrides: true, calendar: true, custom: true };

  /* ─── Constants ──────────────────────────────────────────── */
  const UNAVAIL_REASONS = [
    'Class', 'Study', 'Analysis', 'Writing', 'Meeting',
    'Office Hours', 'Personal', 'Other'
  ];

  const REASON_COLORS = {
    'Class': '#ef4444', 'Study': '#f59e0b', 'Analysis': '#8b5cf6',
    'Writing': '#3b82f6', 'Meeting': '#ec4899', 'Office Hours': '#14b8a6',
    'Personal': '#6b7280', 'Other': '#78716c'
  };

  const MODE_COLORS = { recurring: '#22c55e', special: '#3b82f6', blackout: '#ef4444' };
  const MODE_LABELS = { recurring: 'General Availability', special: 'Special Availability', blackout: 'Special Unavailability' };

  /* ─── Helpers ────────────────────────────────────────────── */
  function db() {
    return McgheeLab.db || firebase.firestore();
  }

  function genBlockId() {
    return 'b_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function _notify() {
    _listeners.forEach(fn => {
      try { fn(); } catch (e) { console.warn('[ScheduleService] listener error:', e); }
    });
  }

  function _currentWeekId() {
    return U().getWeekId(_weekOffset);
  }

  /* ─── Initialization ─────────────────────────────────────── */
  async function init(user, profile) {
    if (_initialized && _user?.uid === user?.uid) return;
    _user = user;
    _profile = profile;

    // Load layer config from userSettings
    try {
      const doc = await db().collection('userSettings').doc(_user.uid).get();
      if (doc.exists && doc.data().scheduleLayer) {
        _layerConfig = { ..._layerConfig, ...doc.data().scheduleLayer };
      }
    } catch { /* use defaults */ }

    subscribeTemplates();
    subscribeOverrides();
    subscribeCustomEvents();
    _initialized = true;
  }

  function destroy() {
    if (_unsubTemplates) { _unsubTemplates(); _unsubTemplates = null; }
    if (_unsubOverrides) { _unsubOverrides(); _unsubOverrides = null; }
    if (_unsubCustomEvents) { _unsubCustomEvents(); _unsubCustomEvents = null; }
    _initialized = false;
  }

  /* ─── Firestore Subscriptions ────────────────────────────── */
  function subscribeTemplates() {
    if (_unsubTemplates) _unsubTemplates();
    _unsubTemplates = db().collection('huddleScheduleTemplates')
      .onSnapshot(snap => {
        _allTemplates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _scheduleTemplate = _allTemplates.find(t => t.id === _user.uid) || null;
        _notify();
      }, err => { console.warn('[ScheduleService] Templates listener error:', err); });
  }

  function subscribeOverrides() {
    if (_unsubOverrides) _unsubOverrides();
    const weekId = _currentWeekId();
    _unsubOverrides = db().collection('huddleScheduleOverrides')
      .where('weekId', '==', weekId)
      .onSnapshot(snap => {
        _allOverrides = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _notify();
      }, err => { console.warn('[ScheduleService] Overrides listener error:', err); });
  }

  function subscribeCustomEvents() {
    if (_unsubCustomEvents) _unsubCustomEvents();
    if (!_user) return;
    _unsubCustomEvents = db().collection('scheduleCustomEvents')
      .where('ownerUid', '==', _user.uid)
      .onSnapshot(snap => {
        _customEvents = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _notify();
      }, err => { console.warn('[ScheduleService] Custom events listener error:', err); });
  }

  /* ─── Week Offset ────────────────────────────────────────── */
  function setWeekOffset(offset) {
    if (_weekOffset === offset) return;
    _weekOffset = offset;
    subscribeOverrides();
  }

  function getWeekOffset() { return _weekOffset; }

  /* ─── Read API ───────────────────────────────────────────── */
  function getAllTemplates() { return _allTemplates; }
  function getUserTemplate(uid) { return _allTemplates.find(t => t.id === uid) || null; }
  function getAllOverrides() { return _allOverrides; }
  function getUserOverrides(uid) { return _allOverrides.filter(o => o.ownerUid === uid); }
  function getMyTemplate() { return _scheduleTemplate; }

  /** Resolve a user's effective schedule for a specific date */
  function resolveScheduleForUser(uid, dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const dow = d.getDay(); // 0=Sun
    const tmpl = _allTemplates.find(t => t.id === uid);
    const templateBlocks = tmpl ? (tmpl.blocks || []).filter(b => b.dayOfWeek === dow) : [];
    const overrides = _allOverrides.filter(o => o.ownerUid === uid && o.date === dateStr);

    let effective = templateBlocks.map(b => ({ ...b, source: 'template' }));

    for (const ov of overrides) {
      if (ov.action === 'remove' && ov.blockId) {
        effective = effective.filter(b => b.id !== ov.blockId);
      } else if (ov.action === 'replace' && ov.blockId && ov.block) {
        effective = effective.map(b => b.id === ov.blockId
          ? { ...b, ...ov.block, source: 'override' } : b);
      } else if (ov.action === 'add' && ov.block) {
        effective.push({ id: ov.id, ...ov.block, source: 'override' });
      }
    }

    // Tag mode on each block (backward compat for blocks without mode)
    effective.forEach(b => {
      if (!b.mode) {
        b.mode = b.source === 'template' ? 'recurring'
          : b.type === 'available' ? 'special' : 'blackout';
      }
    });

    // Inject custom events for this user and date
    if (uid === _user?.uid) {
      const customForDate = _customEvents.filter(ce =>
        (ce.isRecurring && ce.dayOfWeek === dow) ||
        (!ce.isRecurring && ce.date === dateStr)
      );
      for (const ce of customForDate) {
        effective.push({
          id: 'custom_' + ce.id,
          startTime: ce.startTime,
          endTime: ce.endTime,
          type: 'unavailable',
          reason: ce.title || 'Custom',
          rigidity: 'flexible',
          mode: 'custom',
          source: 'custom',
          color: ce.color,
          title: ce.title
        });
      }
    }

    // Inject calendar events (current user only)
    // Always subtract from availability when calendars are connected.
    // Events marked 'busy-available' count as available (darker shade); default is unavailable
    if (uid === _user?.uid && McgheeLab.CalendarService) {
      try {
        const calConn = McgheeLab.CalendarService.isConnected();
        const hasAnyCalendar = calConn.google || calConn.outlook || calConn.ics || calConn.outlookIcs;
        if (hasAnyCalendar) {
          const cal = McgheeLab.CalendarService;
          const parseT = U().parseCalTimeToHHMM;
          const calEvents = cal.getEventsForDate(dateStr) || [];
          for (const ev of calEvents) {
            const st = parseT(ev.startTime);
            const et = parseT(ev.endTime);
            if (st && et && st < et) {
              const status = cal.getEventStatus(ev.id); // 'unavailable' or 'busy-available'
              const isBusyAvailable = status === 'busy-available';
              effective.push({
                id: 'cal_' + ev.id,
                startTime: st,
                endTime: et,
                type: isBusyAvailable ? 'available' : 'unavailable',
                reason: ev.title || 'Calendar',
                rigidity: isBusyAvailable ? 'flexible' : 'rigid',
                mode: isBusyAvailable ? 'special' : 'blackout',
                source: 'calendar',
                calStatus: status,
                title: ev.title,
                provider: ev.provider
              });
            }
          }
        }
      } catch (e) { /* CalendarService not ready */ }
    }

    return effective;
  }

  /** Find overlapping free windows between two users on a given date */
  function resolveAvailabilityOverlap(uid1, uid2, dateStr) {
    const sched1 = resolveScheduleForUser(uid1, dateStr);
    const sched2 = resolveScheduleForUser(uid2, dateStr);

    function getAvailableMinutes(sched) {
      const avail = sched.filter(b => b.type === 'available');
      const intervals = [];
      for (const b of avail) {
        const [sh, sm] = b.startTime.split(':').map(Number);
        const [eh, em] = b.endTime.split(':').map(Number);
        intervals.push({ start: sh * 60 + sm, end: eh * 60 + em });
      }
      return intervals;
    }

    const avail1 = getAvailableMinutes(sched1);
    const avail2 = getAvailableMinutes(sched2);

    if (avail1.length === 0 || avail2.length === 0) return [];

    const overlaps = [];
    for (const a of avail1) {
      for (const b of avail2) {
        const start = Math.max(a.start, b.start);
        const end = Math.min(a.end, b.end);
        if (start < end) {
          overlaps.push({
            startTime: String(Math.floor(start / 60)).padStart(2, '0') + ':' + String(start % 60).padStart(2, '0'),
            endTime: String(Math.floor(end / 60)).padStart(2, '0') + ':' + String(end % 60).padStart(2, '0')
          });
        }
      }
    }
    return overlaps;
  }

  /** Get calendar events for a date (convenience, delegates to CalendarService) */
  function getCalendarEventsForDate(dateStr) {
    if (!McgheeLab.CalendarService) return [];
    return McgheeLab.CalendarService.getEventsForDate(dateStr) || [];
  }

  /** Get custom events for a specific date */
  function getCustomEventsForDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const dow = d.getDay();
    return _customEvents.filter(ce =>
      (ce.isRecurring && ce.dayOfWeek === dow) ||
      (!ce.isRecurring && ce.date === dateStr)
    );
  }

  /* ─── Write API ──────────────────────────────────────────── */
  async function saveScheduleTemplate(blocks) {
    const name = _profile?.name || _user?.displayName || _user?.email;
    await db().collection('huddleScheduleTemplates').doc(_user.uid).set({
      ownerUid: _user.uid, ownerName: name,
      blocks: blocks,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function addScheduleOverride(data) {
    const name = _profile?.name || _user?.displayName || _user?.email;
    return db().collection('huddleScheduleOverrides').add({
      ownerUid: _user.uid, ownerName: name,
      weekId: _currentWeekId(),
      date: data.date,
      action: data.action,
      blockId: data.blockId || null,
      block: data.block || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function deleteScheduleOverride(id) {
    return db().collection('huddleScheduleOverrides').doc(id).delete();
  }

  async function saveCustomEvent(eventData) {
    const data = {
      ...eventData,
      ownerUid: _user.uid,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (!data.createdAt) {
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    }
    if (eventData.id) {
      // Update existing
      const id = eventData.id;
      delete data.id;
      await db().collection('scheduleCustomEvents').doc(id).set(data, { merge: true });
      return id;
    } else {
      // Create new
      const ref = await db().collection('scheduleCustomEvents').add(data);
      return ref.id;
    }
  }

  async function deleteCustomEvent(id) {
    return db().collection('scheduleCustomEvents').doc(id).delete();
  }

  /* ─── Layer Config ───────────────────────────────────────── */
  function getLayerConfig() { return { ..._layerConfig }; }

  async function saveLayerConfig(cfg) {
    _layerConfig = { ..._layerConfig, ...cfg };
    try {
      await db().collection('userSettings').doc(_user.uid).set(
        { scheduleLayer: _layerConfig },
        { merge: true }
      );
    } catch (err) {
      console.warn('[ScheduleService] saveLayerConfig error:', err);
    }
    _notify();
  }

  /* ─── Listeners ──────────────────────────────────────────── */
  function onChange(callback) {
    _listeners.push(callback);
    return () => { _listeners = _listeners.filter(fn => fn !== callback); };
  }

  /* ─── Public API ─────────────────────────────────────────── */
  return {
    // Lifecycle
    init,
    destroy,

    // Read
    getAllTemplates,
    getUserTemplate,
    getMyTemplate,
    getAllOverrides,
    getUserOverrides,
    resolveScheduleForUser,
    resolveAvailabilityOverlap,
    getCalendarEventsForDate,
    getCustomEventsForDate,

    // Write
    saveScheduleTemplate,
    addScheduleOverride,
    deleteScheduleOverride,
    saveCustomEvent,
    deleteCustomEvent,

    // Layer config
    getLayerConfig,
    saveLayerConfig,

    // Week offset
    setWeekOffset,
    getWeekOffset,

    // Observability
    onChange,

    // Constants
    UNAVAIL_REASONS,
    REASON_COLORS,
    MODE_COLORS,
    MODE_LABELS,
    genBlockId
  };
})();
