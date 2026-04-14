/* ================================================================
   The Huddle — McGheeLab Lab App
   Community-driven weekly planning board. Lab members post what
   protocols/methods they plan to do, others watch or join.
   ================================================================ */

(() => {
  'use strict';

  const appEl = document.getElementById('app');
  function db() {
    if (typeof firebase === 'undefined') throw new Error('Firebase SDK not loaded');
    return firebase.firestore();
  }

  /* ─── State ──────────────────────────────────────────────── */
  let _user = null;
  let _profile = null;
  let _plans = [];
  let _helpRequests = [];
  let _currentWeekOffset = 0;
  let _currentDayOffset = 0;      // for daily view
  let _currentMonth = null;        // {year, month} for monthly view
  let _currentSection = 'planfeed';
  let _huddleSettings = null;      // user's huddle defaults (Firestore)
  let _myPlansView = 'weekly';     // 'daily' | 'weekly' | 'monthly'
  let _unsubscribe = null;
  let _unsubHelp = null;
  let _toastTimer = null;
  let _editingPlanId = null;
  let _signupPlanId = null;
  let _popupPlanId = null;         // plan popup on time grid
  let _prefill = null;             // { plannedDay, startTime, endTime } for drag-to-create
  let _gridDrag = null;            // pointer drag state for creating plans on time grid

  // Filters
  let _filterMembers = new Set();
  let _filterStatus = new Set();

  // Rundown state
  let _rundownTasks = [];
  let _rundownConfig = null;       // { rundownCategories: [...] }
  let _projects = [];              // cached projectPackages for dropdown
  let _unsubRundown = null;
  let _unsubRundownConfig = null;
  let _editingTaskId = null;
  let _filterRundownCategory = '';

  // Schedule / Availability state
  let _teamViewDay = null;               // selected day index for team view (0=Mon)

  const DEFAULT_RUNDOWN_CATEGORIES = [
    { id: 'cell_culture', label: 'Cell Culture', color: '#5baed1' },
    { id: 'device_design', label: 'Device Design', color: '#86efac' },
    { id: 'microfluidics', label: 'Microfluidics', color: '#c4b5fd' },
    { id: 'western_blot', label: 'Western Blot', color: '#fbbf24' },
    { id: 'pcr', label: 'PCR', color: '#f472b6' },
    { id: 'imaging', label: 'Imaging', color: '#38bdf8' },
    { id: 'data_analysis', label: 'Data Analysis', color: '#a78bfa' },
    { id: 'literature', label: 'Literature Review', color: '#fb923c' },
    { id: 'writing', label: 'Writing', color: '#34d399' },
    { id: 'other', label: 'Other', color: '#94a3b8' }
  ];

  // Zoom state for time grid
  const ZOOM_LEVELS = [4, 6, 9, 14, 20, 28, 40, 56, 76]; // px per half-hour slot
  let _zoomIdx = 4; // default 20px (matches equipment scheduler)
  let _lastScrollTop = null; // scroll preservation across re-renders

  // Per-user colors
  const USER_COLORS = [
    '#5baed1', '#86efac', '#c4b5fd', '#fbbf24', '#f472b6',
    '#38bdf8', '#a78bfa', '#fb923c', '#34d399', '#f87171',
    '#818cf8', '#facc15', '#2dd4bf', '#e879f9', '#94a3b8'
  ];
  const _userColorMap = new Map();
  function getUserColor(uid) {
    if (!_userColorMap.has(uid)) _userColorMap.set(uid, USER_COLORS[_userColorMap.size % USER_COLORS.length]);
    return _userColorMap.get(uid);
  }

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
      _currentMonth = { year: now.getFullYear(), month: now.getMonth() };
      await loadSettings();
      render();
      subscribePlans();
      subscribeHelp();
      subscribeRundown();
      subscribeRundownConfig();
      // Init shared services
      if (McgheeLab.CalendarService) {
        await McgheeLab.CalendarService.init(_user, {});
      }
      if (McgheeLab.ScheduleService) {
        await McgheeLab.ScheduleService.init(_user, _profile);
        McgheeLab.ScheduleService.onChange(() => {
          if (_currentSection === 'teamavail') renderMain();
        });
      }
      if (McgheeLab.CalendarService) {
        McgheeLab.CalendarService.onChange(() => {
          if (_currentSection === 'teamavail') renderMain();
        });
      }
      loadProjects();

      if (McgheeLab.MobileShell?.enableTabSwipe) {
        McgheeLab.MobileShell.enableTabSwipe(
          [{ id: 'planfeed' }, { id: 'helpfeed' }, { id: 'rundown' }, { id: 'teamavail' }, { id: 'addplan' }, { id: 'requesthelp' }, { id: 'addrundown' }, { id: 'myplans' }, { id: 'myhelp' }, { id: 'mytasks' }, { id: 'settings' }],
          () => _currentSection,
          (id) => { _currentSection = id; render(); }
        );
      }
    }

    McgheeLab.AppBridge.init();
    if (McgheeLab.MobileShell) McgheeLab.MobileShell.configure({ appId: 'huddle', title: 'The Huddle' });
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
            const doc = await firebase.firestore().collection('users').doc(fbUser.uid).get();
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

  /* ═══════════════════════════════════════════════════════════
     DATE / WEEK HELPERS
     ═══════════════════════════════════════════════════════════ */
  function localDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function todayStr() { return localDateStr(new Date()); }

  function getMonday(offset) {
    const d = new Date();
    const day = d.getDay();
    d.setDate(d.getDate() - day + 1 + (offset * 7));
    return d;
  }

  function getWeekId(offset) {
    const mon = getMonday(offset);
    const tmp = new Date(mon.getTime());
    tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
    const jan4 = new Date(tmp.getFullYear(), 0, 4);
    const weekNum = 1 + Math.round(((tmp - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
    return tmp.getFullYear() + '-W' + String(weekNum).padStart(2, '0');
  }

  function getWeekDays(offset) {
    const mon = getMonday(offset);
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      days.push({
        date: localDateStr(d),
        dayName: d.toLocaleDateString('en-US', { weekday: 'long' }),
        dayShort: d.toLocaleDateString('en-US', { weekday: 'short' }),
        monthDay: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      });
    }
    return days;
  }

  function getWeekLabel(offset) {
    const days = getWeekDays(offset);
    const s = days[0], e = days[6];
    if (offset === 0) return 'This Week: ' + s.monthDay + ' \u2013 ' + e.monthDay;
    if (offset === -1) return 'Last Week: ' + s.monthDay + ' \u2013 ' + e.monthDay;
    if (offset === 1) return 'Next Week: ' + s.monthDay + ' \u2013 ' + e.monthDay;
    return s.monthDay + ' \u2013 ' + e.monthDay;
  }

  function currentWeekId() { return getWeekId(_currentWeekOffset); }

  function getDayDate(offset) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d;
  }

  function getDayLabel(offset) {
    const d = getDayDate(offset);
    const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    if (offset === 0) return 'Today: ' + label;
    return label;
  }

  function fmtTime(t) {
    if (!t) return '';
    const [h, m] = t.split(':');
    const hr = parseInt(h);
    const suffix = hr >= 12 ? 'PM' : 'AM';
    return ((hr % 12) || 12) + ':' + m + ' ' + suffix;
  }

  function genUUID() {
    return 'xxxx-xxxx-xxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));
  }

  /* ═══════════════════════════════════════════════════════════
     TIME GRID HELPERS
     ═══════════════════════════════════════════════════════════ */
  function getGridBounds(plans) {
    // Full 24-hour range to match equipment scheduler
    return { startHour: 0, endHour: 24 };
  }

  function timeToSlot(timeStr, startHour) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return (h - startHour) * 2 + (m >= 30 ? 1 : 0);
  }

  function slotToTime(slot, startHour) {
    const h = startHour + Math.floor(slot / 2);
    const m = (slot % 2) * 30;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  function timeLabels(startHour, endHour) {
    const labels = [];
    for (let h = startHour; h < endHour; h++) {
      labels.push({ time: String(h).padStart(2, '0') + ':00', label: fmtTime(String(h).padStart(2, '0') + ':00') });
      labels.push({ time: String(h).padStart(2, '0') + ':30', label: '' });
    }
    return labels;
  }

  /* ═══════════════════════════════════════════════════════════
     FIRESTORE — Real-time listener + CRUD
     ═══════════════════════════════════════════════════════════ */
  function subscribePlans() {
    if (_unsubscribe) _unsubscribe();
    const weekId = currentWeekId();
    _unsubscribe = db().collection('huddlePlans')
      .where('weekId', '==', weekId)
      .onSnapshot(snap => {
        _plans = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _plans.sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
        generateRecurringInstances();
        renderMain();
      }, err => { console.warn('[Huddle] Listener error:', err); });
  }

  function subscribeHelp() {
    if (_unsubHelp) _unsubHelp();
    const weekId = currentWeekId();
    _unsubHelp = db().collection('huddleHelpRequests')
      .where('weekId', '==', weekId)
      .onSnapshot(snap => {
        _helpRequests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _helpRequests.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
        if (_currentSection === 'helpfeed' || _currentSection === 'myhelp' || _currentSection === 'planfeed') renderMain();
      }, err => { console.warn('[Huddle] Help listener error:', err); });
  }

  async function createPlan(data) {
    const name = _profile.name || _user.displayName || _user.email;
    return db().collection('huddlePlans').add({
      ownerUid: _user.uid, ownerName: name, ownerCategory: _profile.category || '',
      weekId: data.weekId || currentWeekId(),
      plannedDay: data.plannedDay || null,
      startTime: data.startTime || null, endTime: data.endTime || null,
      text: data.text, notes: data.notes || '',
      protocol: data.protocol || null,
      projectId: null, projectName: null,
      watchers: [], joiners: [],
      status: 'planned', statusReason: null, delayedToWeek: null,
      seriesId: data.seriesId || null,
      recurrence: data.recurrence || null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function updatePlan(planId, data) {
    return db().collection('huddlePlans').doc(planId).update({
      ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function deletePlan(planId) {
    return db().collection('huddlePlans').doc(planId).delete();
  }

  async function deleteSeriesPlans(seriesId) {
    const snap = await db().collection('huddlePlans').where('seriesId', '==', seriesId).get();
    const batch = db().batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    return batch.commit();
  }

  async function signUpForPlan(planId, signupData) {
    const plan = _plans.find(p => p.id === planId);
    if (!plan) return;
    const me = {
      uid: _user.uid, name: _profile.name || _user.displayName || '',
      skillLevel: signupData.skillLevel || '', helpNote: signupData.helpNote || '',
      type: signupData.type || 'join'
    };
    const watchers = (plan.watchers || []).filter(w => w.uid !== _user.uid);
    const joiners = (plan.joiners || []).filter(j => j.uid !== _user.uid);
    if (me.type === 'watch') watchers.push(me); else joiners.push(me);
    await db().collection('huddlePlans').doc(planId).update({
      watchers, joiners, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function unsignFromPlan(planId) {
    const plan = _plans.find(p => p.id === planId);
    if (!plan) return;
    await db().collection('huddlePlans').doc(planId).update({
      watchers: (plan.watchers || []).filter(w => w.uid !== _user.uid),
      joiners: (plan.joiners || []).filter(j => j.uid !== _user.uid),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  // Help CRUD
  async function createHelpRequest(data) {
    const name = _profile.name || _user.displayName || _user.email;
    return db().collection('huddleHelpRequests').add({
      ownerUid: _user.uid, ownerName: name, ownerCategory: _profile.category || '',
      weekId: currentWeekId(), title: data.title, description: data.description,
      whatFailed: data.whatFailed || '', whatTried: data.whatTried || '',
      status: 'open', responses: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function addHelpResponse(requestId, response) {
    const req = _helpRequests.find(r => r.id === requestId);
    if (!req) return;
    const responses = [...(req.responses || []), {
      uid: _user.uid, name: _profile.name || _user.displayName || '',
      type: response.type, message: response.message, createdAt: new Date().toISOString()
    }];
    await db().collection('huddleHelpRequests').doc(requestId).update({
      responses, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function resolveHelpRequest(id) {
    await db().collection('huddleHelpRequests').doc(id).update({ status: 'resolved', updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  }

  async function deleteHelpRequest(id) {
    await db().collection('huddleHelpRequests').doc(id).delete();
  }

  // ── Rundown CRUD & subscriptions ─────────────────────────

  function subscribeRundown() {
    if (_unsubRundown) _unsubRundown();
    const weekId = currentWeekId();
    _unsubRundown = db().collection('huddleRundown')
      .where('weekId', '==', weekId)
      .onSnapshot(snap => {
        _rundownTasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _rundownTasks.sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
        if (_currentSection === 'rundown' || _currentSection === 'mytasks') renderMain();
      }, err => { console.warn('[Huddle] Rundown listener error:', err); });
  }

  function subscribeRundownConfig() {
    if (_unsubRundownConfig) _unsubRundownConfig();
    _unsubRundownConfig = db().collection('huddleConfig').doc('settings')
      .onSnapshot(snap => {
        if (snap.exists) {
          _rundownConfig = snap.data();
        } else {
          _rundownConfig = { rundownCategories: DEFAULT_RUNDOWN_CATEGORIES };
        }
      }, err => { console.warn('[Huddle] Config listener error:', err); });
  }

  async function loadProjects() {
    try {
      const snap = await db().collection('projectPackages')
        .where('status', '==', 'published').get();
      _projects = snap.docs.map(d => ({ id: d.id, title: d.data().title }));
    } catch (err) { _projects = []; }
  }

  function getRundownCategories() {
    return (_rundownConfig && _rundownConfig.rundownCategories) || DEFAULT_RUNDOWN_CATEGORIES;
  }

  function getCategoryColor(catId) {
    const cats = getRundownCategories();
    const cat = cats.find(c => c.id === catId);
    return cat ? cat.color : '#94a3b8';
  }

  async function createRundownTask(data) {
    const name = _profile.name || _user.displayName || _user.email;
    return db().collection('huddleRundown').add({
      ownerUid: _user.uid, ownerName: name, ownerCategory: _profile.category || '',
      weekId: currentWeekId(),
      text: data.text,
      categoryId: data.categoryId || 'other',
      categoryLabel: data.categoryLabel || 'Other',
      projectId: data.projectId || null,
      projectName: data.projectName || null,
      status: 'open',
      joinRequests: [],
      scheduledPlanId: null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function updateRundownTask(taskId, data) {
    return db().collection('huddleRundown').doc(taskId).update({
      ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function deleteRundownTask(taskId) {
    return db().collection('huddleRundown').doc(taskId).delete();
  }

  async function requestJoinTask(taskId, joinData) {
    const task = _rundownTasks.find(t => t.id === taskId);
    if (!task) return;
    const joinRequests = [...(task.joinRequests || []).filter(j => j.uid !== _user.uid), {
      uid: _user.uid, name: _profile.name || _user.displayName || '',
      skillLevel: joinData.skillLevel || 'learning',
      note: joinData.note || '',
      status: 'pending',
      requestedAt: new Date().toISOString()
    }];
    await db().collection('huddleRundown').doc(taskId).update({
      joinRequests, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function respondToJoinRequest(taskId, requesterUid, response) {
    const task = _rundownTasks.find(t => t.id === taskId);
    if (!task) return;
    const joinRequests = (task.joinRequests || []).map(j =>
      j.uid === requesterUid ? { ...j, status: response } : j
    );
    await db().collection('huddleRundown').doc(taskId).update({
      joinRequests, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function saveRundownConfig(categories) {
    await db().collection('huddleConfig').doc('settings').set({
      rundownCategories: categories,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  /* ═══════════════════════════════════════════════════════════
     RECURRING TASK GENERATION
     ═══════════════════════════════════════════════════════════ */
  let _generatingRecurrence = false;
  async function generateRecurringInstances() {
    if (_generatingRecurrence) return;
    const recurringPlans = _plans.filter(p => p.recurrence && p.seriesId && p.ownerUid === _user.uid);
    if (!recurringPlans.length) return;

    // Group by seriesId, find the "template" (earliest)
    const seriesMap = new Map();
    recurringPlans.forEach(p => {
      if (!seriesMap.has(p.seriesId)) seriesMap.set(p.seriesId, p);
    });

    const days = getWeekDays(_currentWeekOffset);
    const weekDates = new Set(days.map(d => d.date));
    const existingDates = new Set(_plans.filter(p => p.seriesId).map(p => p.plannedDay));

    for (const [seriesId, template] of seriesMap) {
      const rec = template.recurrence;
      if (!rec || !template.plannedDay) continue;

      // Determine which days this week need instances
      const needed = [];
      for (const day of days) {
        if (existingDates.has(day.date)) continue;
        if (shouldRecurOnDate(day.date, template.plannedDay, rec)) {
          needed.push(day.date);
        }
      }

      if (needed.length) {
        _generatingRecurrence = true;
        for (const date of needed) {
          // Compute weekId for target date
          const d = new Date(date + 'T12:00:00');
          const tmpD = new Date(d.getTime());
          tmpD.setDate(tmpD.getDate() + 3 - ((tmpD.getDay() + 6) % 7));
          const jan4 = new Date(tmpD.getFullYear(), 0, 4);
          const wn = 1 + Math.round(((tmpD - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
          const wId = tmpD.getFullYear() + '-W' + String(wn).padStart(2, '0');

          await createPlan({
            text: template.text, notes: template.notes, plannedDay: date,
            startTime: template.startTime, endTime: template.endTime,
            protocol: template.protocol, seriesId, recurrence: rec, weekId: wId
          });
        }
        _generatingRecurrence = false;
      }
    }
  }

  function shouldRecurOnDate(targetDate, originDate, rec) {
    const target = new Date(targetDate + 'T12:00:00');
    const origin = new Date(originDate + 'T12:00:00');
    if (target <= origin) return false;

    // Check end conditions
    if (rec.endType === 'date' && rec.endDate && targetDate > rec.endDate) return false;

    const diffDays = Math.round((target - origin) / 86400000);
    const targetDow = target.getDay(); // 0=Sun

    switch (rec.freq) {
      case 'daily':
        return true;

      case 'weekly':
        // If specific days are selected, check if target's day-of-week is in the list
        if (rec.days && rec.days.length) return rec.days.includes(targetDow) && diffDays % 7 >= 0;
        return targetDow === origin.getDay() && diffDays % 7 === 0;

      case 'biweekly':
        if (rec.days && rec.days.length) {
          // Check target is on a selected day AND in an even-week offset from origin
          const weekDiff = Math.floor(diffDays / 7);
          return rec.days.includes(targetDow) && weekDiff % 2 === 0;
        }
        return targetDow === origin.getDay() && diffDays % 14 === 0;

      case 'monthly':
        // Ordinal-based: e.g., "2nd Tuesday" or "Last Friday"
        if (rec.monthOrdinal != null && rec.monthDayOfWeek != null) {
          if (targetDow !== rec.monthDayOfWeek) return false;
          if (rec.monthOrdinal === -1) {
            // Last X of the month: check no more of this weekday exist this month
            const nextWeek = new Date(target);
            nextWeek.setDate(nextWeek.getDate() + 7);
            return nextWeek.getMonth() !== target.getMonth();
          }
          // Nth X: day must fall in the right week range (1st=1-7, 2nd=8-14, etc.)
          const dayOfMonth = target.getDate();
          const ord = rec.monthOrdinal;
          return dayOfMonth > (ord - 1) * 7 && dayOfMonth <= ord * 7;
        }
        // Fallback: same day-of-month
        return target.getDate() === origin.getDate();

      default: return false;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     FILTERS
     ═══════════════════════════════════════════════════════════ */
  function getUniqueMembers() {
    const map = new Map();
    _plans.forEach(p => { if (!map.has(p.ownerUid)) map.set(p.ownerUid, p.ownerName || 'Unknown'); });
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }

  function applyFilters(plans) {
    let f = plans;
    if (_filterMembers.size > 0) f = f.filter(p => _filterMembers.has(p.ownerUid));
    if (_filterStatus.size > 0) f = f.filter(p => _filterStatus.has(p.status || 'planned'));
    return f;
  }

  /* ═══════════════════════════════════════════════════════════
     RENDER — Main dispatcher
     ═══════════════════════════════════════════════════════════ */
  function render() {
    if (McgheeLab.MobileShell?.saveTabScroll) McgheeLab.MobileShell.saveTabScroll('hud-tabs');
    appEl.innerHTML = `
      <div class="hud-layout">
        <nav class="hud-sidebar" id="hud-tabs">${sidebarHTML()}</nav>
        <div class="hud-main" id="hud-main">${renderSection()}</div>
      </div>`;
    wireSidebar();
    wireSection();
    notifyResize();
    if (McgheeLab.MobileShell?.centerActiveTab) {
      McgheeLab.MobileShell.centerActiveTab(document.getElementById('hud-tabs'), '.active');
    }
  }

  function renderMain() {
    const m = document.getElementById('hud-main');
    if (!m) return render();
    m.innerHTML = renderSection();
    wireSection();
    notifyResize();
  }

  /* ─── Sidebar ─────────────────────────────────────────── */
  function sidebarHTML() {
    const helpCount = _helpRequests.filter(r => r.status === 'open' && r.ownerUid !== _user.uid).length;

    const pendingJoinCount = _rundownTasks.filter(t => t.ownerUid === _user.uid && (t.joinRequests || []).some(j => j.status === 'pending')).length;

    const sections = [
      { heading: 'Feeds', items: [
        { id: 'planfeed', label: 'Plan Feed', icon: calendarIcon() },
        { id: 'helpfeed', label: 'Help Feed' + (helpCount ? ` (${helpCount})` : ''), icon: helpIcon() },
        { id: 'rundown', label: 'Rundown', icon: rundownIcon() },
        { id: 'teamavail', label: 'Team Availability', icon: teamAvailIcon() },
      ]},
      { heading: 'Create', items: [
        { id: 'addplan', label: 'Add Plan', icon: plusIcon() },
        { id: 'requesthelp', label: 'Request Help', icon: requestHelpIcon() },
        { id: 'addrundown', label: 'Add Task', icon: addTaskIcon() },
      ]},
      { heading: 'My Stuff', items: [
        { id: 'myplans', label: 'My Plans', icon: myPlansIcon() },
        { id: 'myhelp', label: 'My Help', icon: myHelpIcon() },
        { id: 'mytasks', label: 'My Tasks' + (pendingJoinCount ? ` (${pendingJoinCount})` : ''), icon: myTasksIcon() },
      ]},
      { heading: '', items: [
        { id: 'settings', label: 'Settings', icon: settingsIcon() },
      ]}
    ];

    return sections.map(sec => `
      ${sec.heading ? `<div class="hud-sidebar-heading">${sec.heading}</div>` : '<div class="hud-sidebar-divider"></div>'}
      ${sec.items.map(it => `
        <button class="hud-sidebar-btn ${_currentSection === it.id ? 'active' : ''}" data-section="${it.id}">
          ${it.icon} ${it.label}
        </button>
      `).join('')}
    `).join('');
  }

  function wireSidebar() {
    appEl.querySelectorAll('.hud-sidebar-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const section = btn.dataset.section;
        if (section === _currentSection) return;
        _currentSection = section;
        _editingPlanId = null;
        _popupPlanId = null;
        _signupPlanId = null;
        render();
      });
    });
  }

  function renderSection() {
    switch (_currentSection) {
      case 'planfeed':    return renderPlanFeed();
      case 'myplans':     return renderMyPlans();
      case 'addplan':     return renderAddPlan();
      case 'helpfeed':    return renderHelpFeed();
      case 'myhelp':      return renderMyHelp();
      case 'requesthelp': return renderRequestHelp();
      case 'rundown':     return renderRundownFeed();
      case 'addrundown':  return renderAddRundown();
      case 'mytasks':     return renderMyTasks();
      case 'teamavail':   return renderTeamAvailability();
      case 'settings':    return renderSettings();
      default:            return renderPlanFeed();
    }
  }

  function wireSection() {
    switch (_currentSection) {
      case 'planfeed':    wirePlanFeed(); break;
      case 'myplans':     wireMyPlans(); break;
      case 'addplan':     wireAddPlan(); break;
      case 'helpfeed':    wireHelpFeed(); break;
      case 'myhelp':      wireMyHelp(); break;
      case 'requesthelp': wireRequestHelp(); break;
      case 'rundown':     wireRundownFeed(); break;
      case 'addrundown':  wireAddRundown(); break;
      case 'mytasks':     wireMyTasks(); break;
      case 'teamavail':   wireTeamAvailability(); break;
      case 'settings':    wireSettings(); break;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     1. PLAN FEED — Weekly Time Grid
     ═══════════════════════════════════════════════════════════ */
  function renderPlanFeed() {
    const days = getWeekDays(_currentWeekOffset);
    const today = todayStr();
    const filtered = applyFilters(_plans);
    const bounds = getGridBounds(filtered);
    const slots = timeLabels(bounds.startHour, bounds.endHour);

    // Filter UI
    const members = getUniqueMembers();
    let filterHTML = '';
    if (_plans.length) {
      filterHTML = `
        <div class="hud-filters">
          <div class="hud-filter-toggle" id="hud-filter-toggle">
            ${filterIcon()} Filters ${(_filterMembers.size + _filterStatus.size) ? `<span class="hud-filter-count">${_filterMembers.size + _filterStatus.size}</span>` : ''}
          </div>
          <div class="hud-filter-panel" id="hud-filter-panel" style="display:none;">
            <div class="hud-filter-group">
              <div class="hud-filter-label">Members</div>
              ${members.map(([uid, name]) => `<label class="hud-filter-check"><input type="checkbox" data-filter="member" data-uid="${uid}" ${_filterMembers.has(uid) ? 'checked' : ''} /> ${escHTML(name)}</label>`).join('')}
            </div>
            ${(_filterMembers.size + _filterStatus.size) ? '<button class="hud-filter-clear" id="hud-filter-clear">Clear all</button>' : ''}
          </div>
        </div>`;
    }

    // Time grid
    const gridHTML = buildTimeGrid(days, filtered, bounds, slots, today, false);

    // Popup
    let popupHTML = '';
    if (_popupPlanId) {
      const plan = _plans.find(p => p.id === _popupPlanId);
      if (plan) popupHTML = planPopupHTML(plan);
    }

    const zoomHTML = `<div class="hud-zoom-controls">
      <button class="hud-zoom-btn" id="hud-zoom-out" title="Zoom out">−</button>
      <button class="hud-zoom-btn" id="hud-zoom-in" title="Zoom in">+</button>
    </div>`;

    return `<div class="hud-cal-layout">
      <div class="hud-cal-header">
        ${weekNavHTML()}
        <div class="hud-legend-row">${filterHTML}${zoomHTML}</div>
      </div>
      ${popupHTML}
      <div class="hud-cal-body">
        <div class="hud-cal-scroll-area">
          <div class="hud-grid-wrap" data-slot-h="${ZOOM_LEVELS[_zoomIdx]}">${gridHTML}</div>
          <div class="hud-time-slider" id="hud-time-slider">
            <div class="hud-time-slider-track"></div>
            <div class="hud-time-slider-thumb" id="hud-time-slider-thumb"></div>
          </div>
        </div>
      </div>
    </div>`;
  }

  function wirePlanFeed() {
    wireWeekNav();
    wireFilters();
    wireGridClicks();
    wirePopup();
    wireCalFeatures();
  }

  /* ═══════════════════════════════════════════════════════════
     TIME GRID BUILDER (shared between Plan Feed + My Plans)
     ═══════════════════════════════════════════════════════════ */
  function buildTimeGrid(days, plans, bounds, slots, today, draggable) {
    const totalSlots = slots.length;

    // Group plans by day
    const byDay = {};
    const allDay = {};
    days.forEach(d => { byDay[d.date] = []; allDay[d.date] = []; });

    plans.forEach(p => {
      const key = p.plannedDay;
      if (!key || !byDay[key]) {
        // Unscheduled → put in first day as all-day
        if (days[0]) allDay[days[0].date].push(p);
        return;
      }
      if (!p.startTime) { allDay[key].push(p); return; }
      byDay[key].push(p);
    });

    // Day headers — row 1 (sticky, matches equipment scheduler style)
    let headerCells = `<div class="hud-grid-corner hud-sticky-head" style="grid-column:1; grid-row:1;"></div>`;
    days.forEach((d, ci) => {
      const isToday = d.date === today;
      const dayNum = d.date ? parseInt(d.date.split('-')[2], 10) : d.monthDay;
      headerCells += `<div class="hud-grid-day-header hud-sticky-head ${isToday ? 'hud-today' : ''}" style="grid-column:${ci + 2}; grid-row:1;">${d.dayShort}<span class="hud-grid-daynum">${dayNum}</span></div>`;
    });

    // All-day row — row 2
    let allDayCells = `<div class="hud-grid-time-label" style="grid-column:1; grid-row:2; font-size:.65rem;">All Day</div>`;
    days.forEach((d, ci) => {
      const items = allDay[d.date] || [];
      allDayCells += `<div class="hud-grid-allday-cell" style="grid-column:${ci + 2}; grid-row:2;" data-drop-date="${d.date}" data-drop-time="">
        ${items.map(p => planBlockHTML(p, 0, draggable)).join('')}
      </div>`;
    });

    // Time rows — rows 3+ (half-hour distinction matches equipment scheduler)
    let rows = '';
    for (let i = 0; i < totalSlots; i++) {
      const sl = slots[i];
      const gridRow = i + 3;
      const isHalf = sl.time.endsWith(':30');
      if (isHalf) {
        rows += `<div class="hud-grid-time-label--half" style="grid-column:1; grid-row:${gridRow};"></div>`;
      } else {
        rows += `<div class="hud-grid-time-label" style="grid-column:1; grid-row:${gridRow};">${sl.label}</div>`;
      }
      days.forEach((d, ci) => {
        const isToday = d.date === today;
        rows += `<div class="hud-grid-cell ${isToday ? 'hud-today-col' : ''}" style="grid-column:${ci + 2}; grid-row:${gridRow};" data-drop-date="${d.date}" data-drop-time="${sl.time}" data-slot="${i}"></div>`;
      });
    }

    // Overlay plan blocks on the grid
    let overlayBlocks = '';
    days.forEach((d, colIdx) => {
      const dayPlans = byDay[d.date] || [];
      dayPlans.forEach(p => {
        if (!p.startTime) return;
        const startSlot = timeToSlot(p.startTime, bounds.startHour);
        const endSlot = p.endTime ? timeToSlot(p.endTime, bounds.startHour) : startSlot + 2;
        const spanSlots = Math.max(endSlot - startSlot, 1);
        // CSS grid positioning (1-indexed; col 1 is time labels)
        const gridCol = colIdx + 2;
        const gridRow = startSlot + 3; // +1 for header, +1 for all-day, +1 for 1-index
        const timeLabel = `${fmtTime(p.startTime)}${p.endTime ? '\u2013' + fmtTime(p.endTime) : ''}`;
        overlayBlocks += `<div class="hud-grid-block" style="grid-column:${gridCol}; grid-row:${gridRow}/span ${spanSlots}; border-left-color:${getUserColor(p.ownerUid)}; background:${getUserColor(p.ownerUid)}22;"
          data-plan-id="${p.id}" ${draggable ? 'draggable="true"' : ''}>
          <span class="hud-block-text">${escHTML(p.text)}</span>
          <span class="hud-block-owner">${escHTML(p.ownerName || '')}</span>
          <span class="hud-block-time">${timeLabel}</span>
        </div>`;
      });
    });

    const slotH = ZOOM_LEVELS[_zoomIdx];
    // All cells get explicit grid positions to prevent overlay blocks from disrupting flow
    return `<div class="hud-time-grid" style="grid-template-columns:60px repeat(${days.length}, 1fr); grid-template-rows:auto auto repeat(${totalSlots}, ${slotH}px);">
      ${headerCells}
      ${allDayCells}
      ${rows}
      ${overlayBlocks}
    </div>`;
  }

  function planBlockHTML(p, slot, draggable) {
    const color = getUserColor(p.ownerUid);
    return `<div class="hud-allday-block" style="background:${color}22; border-left:2px solid ${color};" data-plan-id="${p.id}" ${draggable ? 'draggable="true"' : ''}>
      ${escHTML(p.text.slice(0, 30))}${p.text.length > 30 ? '...' : ''}
    </div>`;
  }

  function wireGridClicks() {
    appEl.querySelectorAll('.hud-grid-block, .hud-allday-block').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        _popupPlanId = el.dataset.planId;
        renderMain();
      });
    });
  }

  /* ─── Calendar Features (zoom, slider, pinch, scroll) ── */
  function wireCalFeatures() {
    wireZoom();
    const wrap = appEl.querySelector('.hud-grid-wrap');
    if (!wrap) return;
    wireTimeSlider(wrap);
    wirePinchZoom(wrap);

    // Disable mobile-shell's built-in time scroll
    if (McgheeLab.MobileShell?.disableTimeScroll) McgheeLab.MobileShell.disableTimeScroll();

    // Scroll preservation across re-renders (matches equipment scheduler)
    const slotH = ZOOM_LEVELS[_zoomIdx];
    const prevSlotH = parseFloat(wrap.dataset.slotH || '0');
    if (prevSlotH > 0 && _lastScrollTop !== null) {
      // Scale scroll position proportionally when zoom changes
      wrap.scrollTop = _lastScrollTop * (slotH / prevSlotH);
    } else {
      // First render: auto-scroll to ~8 AM (row 16 = 08:00 in 48-slot grid)
      wrap.scrollTop = slotH * 16;
    }
    wrap.dataset.slotH = slotH;
    wrap.addEventListener('scroll', () => { _lastScrollTop = wrap.scrollTop; }, { passive: true });
  }

  function wireZoom() {
    const zIn = document.getElementById('hud-zoom-in');
    const zOut = document.getElementById('hud-zoom-out');
    if (zIn) zIn.addEventListener('click', () => {
      if (_zoomIdx < ZOOM_LEVELS.length - 1) { _zoomIdx++; renderMain(); }
    });
    if (zOut) zOut.addEventListener('click', () => {
      if (_zoomIdx > 0) { _zoomIdx--; renderMain(); }
    });
  }

  function wireTimeSlider(wrapEl) {
    if (!wrapEl) return;
    const slider = document.getElementById('hud-time-slider');
    const thumb = document.getElementById('hud-time-slider-thumb');
    if (!slider || !thumb) return;

    function syncThumb() {
      const scrollH = wrapEl.scrollHeight;
      const clientH = wrapEl.clientHeight;
      const max = scrollH - clientH;
      if (max <= 0) { slider.style.display = 'none'; return; }
      slider.style.display = '';
      const trackH = slider.clientHeight;
      const ratio = clientH / scrollH;
      const thumbH = Math.max(24, Math.round(ratio * trackH));
      thumb.style.height = thumbH + 'px';
      const scrollRatio = wrapEl.scrollTop / max;
      thumb.style.top = Math.round(scrollRatio * (trackH - thumbH)) + 'px';
    }

    wrapEl.addEventListener('scroll', syncThumb, { passive: true });
    requestAnimationFrame(syncThumb);

    function moveToY(clientY) {
      const rect = slider.getBoundingClientRect();
      const thumbH = thumb.offsetHeight;
      const trackH = slider.clientHeight;
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top - thumbH / 2) / (trackH - thumbH)));
      wrapEl.scrollTop = ratio * (wrapEl.scrollHeight - wrapEl.clientHeight);
    }

    let dragging = false;
    slider.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); dragging = true; moveToY(e.touches[0].clientY); }, { passive: false });
    slider.addEventListener('touchmove', (e) => { if (!dragging) return; e.preventDefault(); e.stopPropagation(); moveToY(e.touches[0].clientY); }, { passive: false });
    slider.addEventListener('touchend', () => { dragging = false; });
    slider.addEventListener('touchcancel', () => { dragging = false; });
    slider.addEventListener('mousedown', (e) => {
      e.preventDefault(); dragging = true; moveToY(e.clientY);
      const onMove = (ev) => { if (dragging) moveToY(ev.clientY); };
      const onUp = () => { dragging = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function wirePinchZoom(wrapEl) {
    if (!wrapEl) return;
    let startDist = 0, startZoom = _zoomIdx;
    wrapEl.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        startDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        startZoom = _zoomIdx;
      }
    }, { passive: true });
    wrapEl.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2) return;
      const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const ratio = dist / startDist;
      let newIdx = startZoom;
      if (ratio > 1.3) newIdx = Math.min(startZoom + 1, ZOOM_LEVELS.length - 1);
      else if (ratio < 0.7) newIdx = Math.max(startZoom - 1, 0);
      if (newIdx !== _zoomIdx) { _zoomIdx = newIdx; renderMain(); }
    }, { passive: true });
  }

  /* ─── Plan Popup ──────────────────────────────────────── */
  function planPopupHTML(plan) {
    const isOwner = plan.ownerUid === _user.uid;
    const isWatching = (plan.watchers || []).some(w => w.uid === _user.uid);
    const isJoining = (plan.joiners || []).some(j => j.uid === _user.uid);
    const isSignedUp = isWatching || isJoining;
    const wc = (plan.watchers || []).length, jc = (plan.joiners || []).length;

    let protocolChip = '';
    if (plan.protocol && plan.protocol.url) {
      protocolChip = `<a href="${escHTML(plan.protocol.url)}" target="_blank" rel="noopener" class="hud-protocol-chip">${protocolIcon()} ${escHTML(plan.protocol.title || 'Protocol')}</a>`;
    } else if (plan.protocol && plan.protocol.title) {
      protocolChip = `<span class="hud-protocol-chip">${protocolIcon()} ${escHTML(plan.protocol.title)}</span>`;
    }

    const participants = [...(plan.watchers || []).map(w => ({...w, role: 'watching'})), ...(plan.joiners || []).map(j => ({...j, role: 'joining'}))];
    let partHTML = participants.length ? `<div class="hud-popup-participants">${participants.map(p => `<span class="hud-participant-pill ${p.role === 'watching' ? 'watcher' : 'joiner'}">${escHTML(p.name)} <span class="hud-skill-tag">${p.skillLevel === 'canTeach' ? 'Expert' : p.skillLevel || ''}</span></span>`).join('')}</div>` : '';

    return `<div class="hud-popup" id="hud-popup">
      <div class="hud-popup-header">
        <div class="hud-plan-avatar" style="background:${getUserColor(plan.ownerUid)}">${getInitials(plan.ownerName)}</div>
        <div>
          <div class="hud-plan-name">${escHTML(plan.ownerName)}</div>
          <div style="font-size:.72rem; color:var(--muted);">${plan.plannedDay || ''} ${plan.startTime ? fmtTime(plan.startTime) : ''}${plan.endTime ? ' \u2013 ' + fmtTime(plan.endTime) : ''}</div>
        </div>
        <button class="hud-popup-close" id="hud-popup-close">&times;</button>
      </div>
      <div class="hud-plan-text" style="margin:.5rem 0;">${escHTML(plan.text)}</div>
      ${plan.notes ? `<div class="hud-plan-notes">${escHTML(plan.notes)}</div>` : ''}
      <div style="margin:.5rem 0;">${protocolChip}</div>
      ${plan.seriesId ? '<div style="font-size:.7rem; color:var(--muted);">Recurring task</div>' : ''}
      ${wc || jc ? `<div style="font-size:.75rem; color:var(--muted); margin:.25rem 0;">${wc} watching, ${jc} joining</div>` : ''}
      ${partHTML}
      ${!isOwner && plan.status === 'planned' ? `
        <div class="hud-popup-actions">
          ${isSignedUp
            ? `<button class="app-btn app-btn--secondary" id="hud-popup-unsign">Signed Up \u2713</button>`
            : `<button class="app-btn app-btn--primary" id="hud-popup-signup">Sign Up</button>`}
        </div>
      ` : ''}
      ${isOwner ? `
        <div class="hud-popup-actions">
          <button class="app-btn app-btn--secondary" id="hud-popup-edit">Edit</button>
          <button class="app-btn app-btn--danger" id="hud-popup-delete">Delete</button>
        </div>
      ` : ''}
    </div>`;
  }

  function wirePopup() {
    const closeBtn = document.getElementById('hud-popup-close');
    if (closeBtn) closeBtn.addEventListener('click', () => { _popupPlanId = null; renderMain(); });

    const signupBtn = document.getElementById('hud-popup-signup');
    if (signupBtn) signupBtn.addEventListener('click', () => { showSignupModal(_popupPlanId); });

    const unsignBtn = document.getElementById('hud-popup-unsign');
    if (unsignBtn) unsignBtn.addEventListener('click', async () => {
      await unsignFromPlan(_popupPlanId);
      _popupPlanId = null;
      toast('Sign up removed');
    });

    const editBtn = document.getElementById('hud-popup-edit');
    if (editBtn) editBtn.addEventListener('click', () => {
      _editingPlanId = _popupPlanId; _popupPlanId = null; _currentSection = 'addplan'; render();
    });

    const deleteBtn = document.getElementById('hud-popup-delete');
    if (deleteBtn) deleteBtn.addEventListener('click', () => {
      const plan = _plans.find(p => p.id === _popupPlanId);
      if (plan && plan.seriesId) {
        showSeriesDeleteModal(_popupPlanId, plan.seriesId);
      } else {
        showDeleteConfirm(_popupPlanId);
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     2. MY PLANS — Calendar Views
     ═══════════════════════════════════════════════════════════ */
  function renderMyPlans() {
    const myPlans = _plans.filter(p => p.ownerUid === _user.uid);

    // View toggle — included in cal-header for day/week, standalone for month
    const viewToggleHTML = `<div class="hud-view-toggle">
      <button class="hud-view-btn ${_myPlansView === 'daily' ? 'active' : ''}" data-view="daily">Day</button>
      <button class="hud-view-btn ${_myPlansView === 'weekly' ? 'active' : ''}" data-view="weekly">Week</button>
      <button class="hud-view-btn ${_myPlansView === 'monthly' ? 'active' : ''}" data-view="monthly">Month</button>
    </div>`;

    let content = '';
    switch (_myPlansView) {
      case 'daily':  content = renderMyDaily(myPlans, viewToggleHTML); break;
      case 'weekly': content = renderMyWeekly(myPlans, viewToggleHTML); break;
      case 'monthly': content = renderMyMonthly(myPlans); break;
    }

    // Popup
    let popupHTML = '';
    if (_popupPlanId) {
      const plan = _plans.find(p => p.id === _popupPlanId);
      if (plan) popupHTML = planPopupHTML(plan);
    }

    // For month view, viewToggle is outside cal-layout; for day/week it's inside cal-header
    const prefix = _myPlansView === 'monthly' ? viewToggleHTML : '';
    return `${prefix}${popupHTML}${content}`;
  }

  function renderMyDaily(myPlans, viewToggle) {
    const d = getDayDate(_currentDayOffset);
    const dateStr = localDateStr(d);
    const dayPlans = myPlans.filter(p => p.plannedDay === dateStr);
    const bounds = getGridBounds(dayPlans);
    const slots = timeLabels(bounds.startHour, bounds.endHour);
    const dayData = [{ date: dateStr, dayShort: d.toLocaleDateString('en-US', { weekday: 'short' }), monthDay: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), dayName: '' }];

    const nav = `<div class="hud-week-nav">
      <button id="hud-day-prev">&larr;</button>
      <span class="hud-week-label">${getDayLabel(_currentDayOffset)}</span>
      <button id="hud-day-next">&rarr;</button>
      ${_currentDayOffset !== 0 ? '<button id="hud-day-today">Today</button>' : ''}
    </div>`;

    const gridHTML = buildTimeGrid(dayData, dayPlans, bounds, slots, todayStr(), true);
    const zoomHTML = `<div class="hud-zoom-controls">
      <button class="hud-zoom-btn" id="hud-zoom-out" title="Zoom out">−</button>
      <button class="hud-zoom-btn" id="hud-zoom-in" title="Zoom in">+</button>
    </div>`;
    return `<div class="hud-cal-layout">
      <div class="hud-cal-header">
        ${viewToggle || ''}
        ${nav}
        <div class="hud-legend-row">${zoomHTML}</div>
      </div>
      <div class="hud-cal-body">
        <div class="hud-cal-scroll-area">
          <div class="hud-grid-wrap" data-slot-h="${ZOOM_LEVELS[_zoomIdx]}">${gridHTML}</div>
          <div class="hud-time-slider" id="hud-time-slider">
            <div class="hud-time-slider-track"></div>
            <div class="hud-time-slider-thumb" id="hud-time-slider-thumb"></div>
          </div>
        </div>
      </div>
    </div>`;
  }

  function renderMyWeekly(myPlans, viewToggle) {
    const days = getWeekDays(_currentWeekOffset);
    const today = todayStr();
    const bounds = getGridBounds(myPlans);
    const slots = timeLabels(bounds.startHour, bounds.endHour);
    const gridHTML = buildTimeGrid(days, myPlans, bounds, slots, today, true);
    const zoomHTML = `<div class="hud-zoom-controls">
      <button class="hud-zoom-btn" id="hud-zoom-out" title="Zoom out">−</button>
      <button class="hud-zoom-btn" id="hud-zoom-in" title="Zoom in">+</button>
    </div>`;
    return `<div class="hud-cal-layout">
      <div class="hud-cal-header">
        ${viewToggle || ''}
        ${weekNavHTML()}
        <div class="hud-legend-row">${zoomHTML}</div>
      </div>
      <div class="hud-cal-body">
        <div class="hud-cal-scroll-area">
          <div class="hud-grid-wrap" data-slot-h="${ZOOM_LEVELS[_zoomIdx]}">${gridHTML}</div>
          <div class="hud-time-slider" id="hud-time-slider">
            <div class="hud-time-slider-track"></div>
            <div class="hud-time-slider-thumb" id="hud-time-slider-thumb"></div>
          </div>
        </div>
      </div>
    </div>`;
  }

  function renderMyMonthly(myPlans) {
    const { year, month } = _currentMonth;
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const monthLabel = firstDay.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    const nav = `<div class="hud-week-nav">
      <button id="hud-month-prev">&larr;</button>
      <span class="hud-week-label">${monthLabel}</span>
      <button id="hud-month-next">&rarr;</button>
    </div>`;

    // Build calendar grid (matches equipment scheduler — shows out-of-month days)
    const startDow = (firstDay.getDay() + 6) % 7; // Mon=0
    const gridStart = new Date(firstDay);
    gridStart.setDate(gridStart.getDate() - startDow);
    const totalDays = startDow + lastDay.getDate();
    const weeks = Math.ceil(totalDays / 7);

    let cells = '';
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(d => {
      cells += `<div class="hud-month-header">${d}</div>`;
    });

    const today = todayStr();
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const date = new Date(gridStart);
        date.setDate(gridStart.getDate() + w * 7 + d);
        const dateStr = localDateStr(date);
        const isToday = dateStr === today;
        const inMonth = date.getMonth() === month;
        const dayPlans = myPlans.filter(p => p.plannedDay === dateStr);
        const dots = dayPlans.slice(0, 4).map(p =>
          `<span class="hud-month-dot" style="background:${getUserColor(p.ownerUid)}" title="${escHTML(p.text)}"></span>`
        ).join('');
        const more = dayPlans.length > 4 ? `<span class="hud-month-more">+${dayPlans.length - 4}</span>` : '';
        cells += `<div class="hud-month-cell ${isToday ? 'hud-today' : ''} ${!inMonth ? 'hud-month-empty' : ''}" data-month-date="${dateStr}">
          <span class="hud-month-day-num">${date.getDate()}</span>
          <div class="hud-month-dots">${dots}${more}</div>
        </div>`;
      }
    }

    return `${nav}<div class="hud-month-grid">${cells}</div>`;
  }

  function wireMyPlans() {
    // View toggle
    appEl.querySelectorAll('.hud-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _myPlansView = btn.dataset.view;
        _popupPlanId = null;
        renderMain();
      });
    });

    wirePopup();

    switch (_myPlansView) {
      case 'daily':
        wireMyDaily();
        wireGridClicks();
        wireDragDrop();
        wireCalFeatures();
        break;
      case 'weekly':
        wireWeekNav();
        wireGridClicks();
        wireDragDrop();
        wireCalFeatures();
        break;
      case 'monthly':
        wireMyMonthly();
        break;
    }
  }

  function wireMyDaily() {
    const prev = document.getElementById('hud-day-prev');
    const next = document.getElementById('hud-day-next');
    const today = document.getElementById('hud-day-today');
    if (prev) prev.addEventListener('click', () => { _currentDayOffset--; renderMain(); });
    if (next) next.addEventListener('click', () => { _currentDayOffset++; renderMain(); });
    if (today) today.addEventListener('click', () => { _currentDayOffset = 0; renderMain(); });
  }

  function wireMyMonthly() {
    const prev = document.getElementById('hud-month-prev');
    const next = document.getElementById('hud-month-next');
    if (prev) prev.addEventListener('click', () => {
      _currentMonth.month--;
      if (_currentMonth.month < 0) { _currentMonth.month = 11; _currentMonth.year--; }
      renderMain();
    });
    if (next) next.addEventListener('click', () => {
      _currentMonth.month++;
      if (_currentMonth.month > 11) { _currentMonth.month = 0; _currentMonth.year++; }
      renderMain();
    });
    // Click day → switch to daily
    appEl.querySelectorAll('[data-month-date]').forEach(cell => {
      cell.addEventListener('click', () => {
        const dateStr = cell.dataset.monthDate;
        const target = new Date(dateStr + 'T12:00:00');
        const now = new Date(); now.setHours(12, 0, 0, 0);
        _currentDayOffset = Math.round((target - now) / 86400000);
        _myPlansView = 'daily';
        renderMain();
      });
    });
  }

  /* ─── Drag-and-Drop ───────────────────────────────────── */
  function wireDragDrop() {
    let dragPlanId = null;

    appEl.querySelectorAll('.hud-grid-block[draggable], .hud-allday-block[draggable]').forEach(el => {
      el.addEventListener('dragstart', (e) => {
        dragPlanId = el.dataset.planId;
        e.dataTransfer.effectAllowed = 'move';
        el.style.opacity = '.4';
      });
      el.addEventListener('dragend', () => {
        el.style.opacity = '';
        appEl.querySelectorAll('.hud-drop-over').forEach(c => c.classList.remove('hud-drop-over'));
      });
    });

    appEl.querySelectorAll('[data-drop-date]').forEach(cell => {
      cell.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; cell.classList.add('hud-drop-over'); });
      cell.addEventListener('dragleave', () => { cell.classList.remove('hud-drop-over'); });
      cell.addEventListener('drop', async (e) => {
        e.preventDefault();
        cell.classList.remove('hud-drop-over');
        if (!dragPlanId) return;
        const newDate = cell.dataset.dropDate;
        const newTime = cell.dataset.dropTime || null;
        const plan = _plans.find(p => p.id === dragPlanId);
        if (!plan) return;

        const updates = { plannedDay: newDate };
        if (newTime) {
          updates.startTime = newTime;
          // Keep duration if had endTime
          if (plan.startTime && plan.endTime) {
            const [sh, sm] = plan.startTime.split(':').map(Number);
            const [eh, em] = plan.endTime.split(':').map(Number);
            const durMin = (eh * 60 + em) - (sh * 60 + sm);
            const [nh, nm] = newTime.split(':').map(Number);
            const endMin = nh * 60 + nm + durMin;
            updates.endTime = String(Math.floor(endMin / 60)).padStart(2, '0') + ':' + String(endMin % 60).padStart(2, '0');
          } else {
            updates.startTime = newTime;
          }
        }

        await updatePlan(dragPlanId, updates);
        toast('Plan moved');
        dragPlanId = null;
      });
    });

    // Pointer-based drag-to-create on empty grid cells
    const grid = appEl.querySelector('.hud-time-grid');
    if (!grid) return;
    const timeCells = appEl.querySelectorAll('.hud-grid-cell[data-drop-time]');
    timeCells.forEach(cell => {
      cell.addEventListener('pointerdown', (e) => {
        // Only start drag on empty area (not on existing plan blocks)
        if (e.target.closest('.hud-grid-block')) return;
        e.preventDefault();
        const col = parseInt(cell.style.gridColumn);
        const row = parseInt(cell.style.gridRow);
        _gridDrag = { col, startRow: row, endRow: row, date: cell.dataset.dropDate, startTime: cell.dataset.dropTime };
        cell.classList.add('hud-grid-cell--selected');
        grid.setPointerCapture(e.pointerId);
      });
    });

    grid.addEventListener('pointermove', (e) => {
      if (!_gridDrag) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || !el.classList.contains('hud-grid-cell')) return;
      const col = parseInt(el.style.gridColumn);
      if (col !== _gridDrag.col) return; // same day only
      _gridDrag.endRow = parseInt(el.style.gridRow);
      // Highlight range
      timeCells.forEach(c => c.classList.remove('hud-grid-cell--selected'));
      const minR = Math.min(_gridDrag.startRow, _gridDrag.endRow);
      const maxR = Math.max(_gridDrag.startRow, _gridDrag.endRow);
      timeCells.forEach(c => {
        const cCol = parseInt(c.style.gridColumn);
        const cRow = parseInt(c.style.gridRow);
        if (cCol === _gridDrag.col && cRow >= minR && cRow <= maxR) c.classList.add('hud-grid-cell--selected');
      });
    });

    grid.addEventListener('pointerup', (e) => {
      if (!_gridDrag) return;
      timeCells.forEach(c => c.classList.remove('hud-grid-cell--selected'));
      const minRow = Math.min(_gridDrag.startRow, _gridDrag.endRow);
      const maxRow = Math.max(_gridDrag.startRow, _gridDrag.endRow);
      // Calculate times from grid rows (row 3 = first time slot)
      const bounds = getGridBounds(_plans);
      const startSlot = minRow - 3;
      const endSlot = maxRow - 3 + 1;
      const startTime = slotToTime(startSlot, bounds.startHour);
      const endTime = slotToTime(endSlot, bounds.startHour);
      _prefill = { plannedDay: _gridDrag.date, startTime, endTime };
      _gridDrag = null;
      _editingPlanId = null;
      _currentSection = 'addplan';
      render();
    });

    grid.addEventListener('pointercancel', () => {
      _gridDrag = null;
      timeCells.forEach(c => c.classList.remove('hud-grid-cell--selected'));
    });
  }

  /* ═══════════════════════════════════════════════════════════
     3. ADD PLAN — Dedicated Form Page
     ═══════════════════════════════════════════════════════════ */
  function renderAddPlan() {
    const isEditing = _editingPlanId != null;
    const plan = isEditing ? _plans.find(p => p.id === _editingPlanId) : null;
    const rec = plan?.recurrence;

    // Build date options for next 14 days
    const dateOptions = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      dateOptions.push({ value: localDateStr(d), label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) });
    }

    const html = `
      <div class="hud-add-form hud-add-page">
        <h2>${isEditing ? 'Edit Plan' : 'Add a New Plan'}</h2>
        <div class="hud-form-field">
          <label class="app-label">What are you working on?</label>
          <input id="hud-plan-text" class="app-input" type="text" placeholder="e.g., Cell culture passage, Western blot..." value="${isEditing && plan ? escHTML(plan.text) : ''}" />
        </div>
        <div class="hud-form-row">
          <div class="hud-form-field" style="flex:1;">
            <label class="app-label">Day</label>
            <input id="hud-plan-day" class="app-input" type="date" value="${isEditing && plan && plan.plannedDay ? plan.plannedDay : (_prefill?.plannedDay || '')}" />
          </div>
          <div class="hud-form-field">
            <label class="app-label">Start Time</label>
            <input id="hud-plan-start" class="app-input" type="time" value="${isEditing && plan && plan.startTime ? plan.startTime : (_prefill?.startTime || '')}" />
          </div>
          <div class="hud-form-field">
            <label class="app-label">End Time</label>
            <input id="hud-plan-end" class="app-input" type="time" value="${isEditing && plan && plan.endTime ? plan.endTime : (_prefill?.endTime || '')}" />
          </div>
        </div>
        <div class="hud-form-field">
          <label class="app-label">Notes (optional)</label>
          <input id="hud-plan-notes" class="app-input" type="text" placeholder="Additional details..." value="${isEditing && plan ? escHTML(plan.notes || '') : ''}" />
        </div>
        <div class="hud-form-row">
          <div class="hud-form-field" style="flex:1;">
            <label class="app-label">Protocol Name</label>
            <input id="hud-protocol-title" class="app-input" type="text" placeholder="Optional" value="${isEditing && plan && plan.protocol ? escHTML(plan.protocol.title) : ''}" />
          </div>
          <div class="hud-form-field" style="flex:1;">
            <label class="app-label">Protocol URL</label>
            <input id="hud-protocol-url" class="app-input" type="url" placeholder="Optional" value="${isEditing && plan && plan.protocol ? escHTML(plan.protocol.url) : ''}" />
          </div>
        </div>

        <div class="hud-recurrence-section">
          <label class="hud-filter-check" style="margin-bottom:.5rem;">
            <input type="checkbox" id="hud-recurring-toggle" ${rec ? 'checked' : ''} />
            <strong>Recurring task</strong>
          </label>
          <div id="hud-recurrence-fields" style="${rec ? '' : 'display:none;'}">
            <div class="hud-form-row">
              <div class="hud-form-field" style="flex:1;">
                <label class="app-label">Frequency</label>
                <select id="hud-rec-freq" class="app-input">
                  <option value="daily" ${rec?.freq === 'daily' ? 'selected' : ''}>Daily</option>
                  <option value="weekly" ${!rec || rec?.freq === 'weekly' ? 'selected' : ''}>Weekly</option>
                  <option value="biweekly" ${rec?.freq === 'biweekly' ? 'selected' : ''}>Biweekly</option>
                  <option value="monthly" ${rec?.freq === 'monthly' ? 'selected' : ''}>Monthly</option>
                </select>
              </div>
              <div class="hud-form-field" style="flex:1;">
                <label class="app-label">Ends</label>
                <select id="hud-rec-end-type" class="app-input">
                  <option value="never" ${!rec || rec?.endType === 'never' ? 'selected' : ''}>Never</option>
                  <option value="count" ${rec?.endType === 'count' ? 'selected' : ''}>After # occurrences</option>
                  <option value="date" ${rec?.endType === 'date' ? 'selected' : ''}>On a date</option>
                </select>
              </div>
            </div>

            <div id="hud-rec-days-wrap" class="hud-form-field" style="${rec?.freq === 'weekly' || rec?.freq === 'biweekly' || (!rec) ? '' : 'display:none;'}">
              <label class="app-label">Repeat on</label>
              <div class="hud-day-picker">
                ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) => `<label class="hud-day-check ${(rec?.days || []).includes(i) ? 'checked' : ''}">
                  <input type="checkbox" data-rec-day-pick="${i}" ${(rec?.days || []).includes(i) ? 'checked' : ''} /> ${d}
                </label>`).join('')}
              </div>
            </div>

            <div id="hud-rec-monthly-wrap" class="hud-form-field" style="${rec?.freq === 'monthly' ? '' : 'display:none;'}">
              <label class="app-label">Repeat on the</label>
              <div class="hud-form-row">
                <select id="hud-rec-ordinal" class="app-input" style="max-width:140px;">
                  <option value="1" ${rec?.monthOrdinal === 1 ? 'selected' : ''}>1st</option>
                  <option value="2" ${rec?.monthOrdinal === 2 ? 'selected' : ''}>2nd</option>
                  <option value="3" ${rec?.monthOrdinal === 3 ? 'selected' : ''}>3rd</option>
                  <option value="4" ${rec?.monthOrdinal === 4 ? 'selected' : ''}>4th</option>
                  <option value="-1" ${rec?.monthOrdinal === -1 ? 'selected' : ''}>Last</option>
                </select>
                <select id="hud-rec-month-day" class="app-input" style="max-width:160px;">
                  ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d, i) => `<option value="${i}" ${rec?.monthDayOfWeek === i ? 'selected' : ''}>${d}</option>`).join('')}
                </select>
                <span style="color:var(--muted); font-size:.82rem; align-self:center;">of the month</span>
              </div>
            </div>

            <div id="hud-rec-end-details" class="hud-form-row" style="${rec?.endType && rec.endType !== 'never' ? '' : 'display:none;'}">
              <div class="hud-form-field" id="hud-rec-count-wrap" style="${rec?.endType === 'count' ? '' : 'display:none;'}">
                <label class="app-label">Occurrences</label>
                <input id="hud-rec-count" class="app-input" type="number" min="2" max="52" value="${rec?.endCount || 10}" />
              </div>
              <div class="hud-form-field" id="hud-rec-date-wrap" style="${rec?.endType === 'date' ? '' : 'display:none;'}">
                <label class="app-label">End Date</label>
                <input id="hud-rec-end-date" class="app-input" type="date" value="${rec?.endDate || ''}" />
              </div>
            </div>
          </div>
        </div>

        <div class="hud-form-actions" style="margin-top:1rem;">
          <button id="hud-plan-submit" class="app-btn app-btn--primary">${isEditing ? 'Update Plan' : 'Create Plan'}</button>
          ${isEditing ? '<button id="hud-plan-cancel-edit" class="app-btn app-btn--secondary">Cancel</button>' : ''}
        </div>
      </div>`;
    _prefill = null; // Clear prefill after form is built
    return html;
  }

  function wireAddPlan() {
    const recurToggle = document.getElementById('hud-recurring-toggle');
    const recFields = document.getElementById('hud-recurrence-fields');
    if (recurToggle && recFields) {
      recurToggle.addEventListener('change', () => { recFields.style.display = recurToggle.checked ? '' : 'none'; });
    }

    const freqSelect = document.getElementById('hud-rec-freq');
    const daysWrap = document.getElementById('hud-rec-days-wrap');
    const monthlyWrap = document.getElementById('hud-rec-monthly-wrap');
    if (freqSelect) {
      const updateFreqFields = () => {
        const f = freqSelect.value;
        if (daysWrap) daysWrap.style.display = (f === 'weekly' || f === 'biweekly') ? '' : 'none';
        if (monthlyWrap) monthlyWrap.style.display = f === 'monthly' ? '' : 'none';
      };
      freqSelect.addEventListener('change', updateFreqFields);
      updateFreqFields();
    }

    const endType = document.getElementById('hud-rec-end-type');
    if (endType) {
      const showEndDetails = () => {
        const v = endType.value;
        const details = document.getElementById('hud-rec-end-details');
        const countWrap = document.getElementById('hud-rec-count-wrap');
        const dateWrap = document.getElementById('hud-rec-date-wrap');
        if (details) details.style.display = v !== 'never' ? '' : 'none';
        if (countWrap) countWrap.style.display = v === 'count' ? '' : 'none';
        if (dateWrap) dateWrap.style.display = v === 'date' ? '' : 'none';
      };
      endType.addEventListener('change', showEndDetails);
      showEndDetails();
    }

    // Day picker checkbox styling
    appEl.querySelectorAll('.hud-day-check input').forEach(cb => {
      cb.addEventListener('change', () => {
        cb.parentElement.classList.toggle('checked', cb.checked);
      });
    });

    const submitBtn = document.getElementById('hud-plan-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', async () => {
        const text = document.getElementById('hud-plan-text')?.value?.trim();
        if (!text) { toast('Please enter a task description'); return; }

        const plannedDay = document.getElementById('hud-plan-day')?.value || null;
        const startTime = document.getElementById('hud-plan-start')?.value || null;
        const endTime = document.getElementById('hud-plan-end')?.value || null;
        const notes = document.getElementById('hud-plan-notes')?.value?.trim() || '';
        const protoTitle = document.getElementById('hud-protocol-title')?.value?.trim() || '';
        const protoUrl = document.getElementById('hud-protocol-url')?.value?.trim() || '';
        const protocol = protoTitle || protoUrl ? { title: protoTitle || protoUrl, url: protoUrl, protocolId: null } : null;

        let recurrence = null;
        let seriesId = null;
        if (document.getElementById('hud-recurring-toggle')?.checked) {
          seriesId = _editingPlanId ? (_plans.find(p => p.id === _editingPlanId)?.seriesId || genUUID()) : genUUID();
          const freq = document.getElementById('hud-rec-freq')?.value || 'weekly';
          const endTypeVal = document.getElementById('hud-rec-end-type')?.value || 'never';

          // Collect selected days for weekly/biweekly
          const days = [];
          appEl.querySelectorAll('[data-rec-day-pick]').forEach(cb => {
            if (cb.checked) days.push(parseInt(cb.dataset.recDayPick));
          });

          // Monthly ordinal (1st Monday, Last Friday, etc.)
          const monthOrdinal = freq === 'monthly' ? parseInt(document.getElementById('hud-rec-ordinal')?.value || 1) : null;
          const monthDayOfWeek = freq === 'monthly' ? parseInt(document.getElementById('hud-rec-month-day')?.value || 0) : null;

          recurrence = {
            freq,
            endType: endTypeVal,
            endCount: endTypeVal === 'count' ? parseInt(document.getElementById('hud-rec-count')?.value || 10) : null,
            endDate: endTypeVal === 'date' ? (document.getElementById('hud-rec-end-date')?.value || null) : null,
            days: (freq === 'weekly' || freq === 'biweekly') ? days : null,
            monthOrdinal,
            monthDayOfWeek,
            dayOfWeek: plannedDay ? new Date(plannedDay + 'T12:00:00').getDay() : null
          };
        }

        submitBtn.disabled = true;
        try {
          if (_editingPlanId) {
            await updatePlan(_editingPlanId, { text, plannedDay, startTime, endTime, notes, protocol, seriesId, recurrence });
            toast('Plan updated!');
            _editingPlanId = null;
            _currentSection = 'myplans';
            render();
          } else {
            await createPlan({ text, plannedDay, startTime, endTime, notes, protocol, seriesId, recurrence });
            toast('Plan created!');
            _currentSection = 'planfeed';
            render();
          }
        } catch (err) {
          console.warn('[Huddle] Save error:', err);
          toast(err.code === 'permission-denied' ? 'Permission denied — try refreshing' : 'Error saving plan');
        }
        submitBtn.disabled = false;
      });
    }

    const cancelBtn = document.getElementById('hud-plan-cancel-edit');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { _editingPlanId = null; _currentSection = 'myplans'; render(); });
  }

  /* ═══════════════════════════════════════════════════════════
     4. HELP FEED — Others' help requests
     ═══════════════════════════════════════════════════════════ */
  function renderHelpFeed() {
    const otherOpen = _helpRequests.filter(r => r.ownerUid !== _user.uid && r.status === 'open');

    return `${weekNavHTML()}
      <h2 style="font-size:1rem; margin:0 0 .75rem; color:var(--text);">Help Feed</h2>
      <p style="font-size:.82rem; color:var(--muted); margin:0 0 1rem;">Lab members need help. Offer assistance, suggest solutions, or share advice.</p>
      ${otherOpen.length ? otherOpen.map(r => helpCardHTML(r, false)).join('') : '<div class="hud-empty"><p>No open help requests from others this week.</p></div>'}`;
  }

  function wireHelpFeed() {
    wireWeekNav();
    wireHelpResponses();
  }

  /* ═══════════════════════════════════════════════════════════
     5. MY HELP — Own help requests
     ═══════════════════════════════════════════════════════════ */
  function renderMyHelp() {
    const mine = _helpRequests.filter(r => r.ownerUid === _user.uid);
    const open = mine.filter(r => r.status === 'open');
    const resolved = mine.filter(r => r.status === 'resolved');

    let resolvedHTML = '';
    if (resolved.length) {
      resolvedHTML = `<details class="hud-resolved-section" style="margin-top:1rem;">
        <summary style="color:var(--muted); font-size:.82rem; cursor:pointer;">Resolved (${resolved.length})</summary>
        ${resolved.map(r => helpCardHTML(r, true)).join('')}
      </details>`;
    }

    return `${weekNavHTML()}
      <h2 style="font-size:1rem; margin:0 0 .75rem; color:var(--text);">My Help Requests</h2>
      ${open.length ? open.map(r => helpCardHTML(r, true)).join('') : '<div class="hud-empty"><p>You haven\'t posted any help requests this week.</p></div>'}
      ${resolvedHTML}`;
  }

  function wireMyHelp() {
    wireWeekNav();
    wireHelpResponses();
  }

  /* ═══════════════════════════════════════════════════════════
     6. REQUEST HELP — Dedicated Form Page
     ═══════════════════════════════════════════════════════════ */
  function renderRequestHelp() {
    return `
      <div class="hud-add-form hud-add-page">
        <h2>Request Help</h2>
        <p style="color:var(--muted); font-size:.82rem; margin:0 0 1rem;">
          Describe what's going wrong. Be specific so others can help effectively.
        </p>
        <div class="hud-form-field">
          <label class="app-label">Short Title</label>
          <input id="hud-help-title" class="app-input" type="text" placeholder="e.g., Western blot bands not showing" />
        </div>
        <div class="hud-form-field">
          <label class="app-label">What are you trying to do?</label>
          <textarea id="hud-help-desc" class="app-input" placeholder="Describe the experiment or protocol..." rows="3"></textarea>
        </div>
        <div class="hud-form-field">
          <label class="app-label">What's going wrong?</label>
          <textarea id="hud-help-failed" class="app-input" placeholder="Specific results vs. what you expected..." rows="3"></textarea>
        </div>
        <div class="hud-form-field">
          <label class="app-label">What have you already tried?</label>
          <textarea id="hud-help-tried" class="app-input" placeholder="Troubleshooting steps taken..." rows="3"></textarea>
        </div>
        <div class="hud-form-actions">
          <button id="hud-help-submit" class="app-btn app-btn--primary">Post Help Request</button>
        </div>
      </div>`;
  }

  function wireRequestHelp() {
    const btn = document.getElementById('hud-help-submit');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const title = document.getElementById('hud-help-title')?.value?.trim();
      if (!title) { toast('Please add a title'); return; }
      const description = document.getElementById('hud-help-desc')?.value?.trim() || '';
      const whatFailed = document.getElementById('hud-help-failed')?.value?.trim() || '';
      const whatTried = document.getElementById('hud-help-tried')?.value?.trim() || '';
      btn.disabled = true;
      try {
        await createHelpRequest({ title, description, whatFailed, whatTried });
        toast('Help request posted!');
        _currentSection = 'myhelp'; render();
      } catch (err) {
        console.warn('[Huddle] Help error:', err);
        toast(err.code === 'permission-denied' ? 'Permission denied — try refreshing' : 'Error posting request');
      }
      btn.disabled = false;
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SHARED HELP CARD + WIRE
     ═══════════════════════════════════════════════════════════ */
  function helpCardHTML(req, isOwnerView) {
    const initials = getInitials(req.ownerName);
    const isOwner = req.ownerUid === _user.uid;
    const responses = req.responses || [];
    const isResolved = req.status === 'resolved';

    const typeLabel = (t) => t === 'offer_help' ? 'Offering to help' : t === 'suggestion' ? 'Suggestion' : t === 'followup' ? 'Follow-up' : 'Advice';

    let responsesHTML = '';
    if (responses.length) {
      responsesHTML = `<div class="hud-help-responses">${responses.map((r, idx) => {
        const accepted = r.accepted;
        return `
        <div class="hud-help-response ${accepted ? 'hud-response-accepted' : ''}">
          <div class="hud-help-response-header">
            <strong>${escHTML(r.name)}</strong>
            <span class="hud-help-response-type">${typeLabel(r.type)}</span>
            ${accepted ? '<span class="hud-status-badge completed" style="font-size:.6rem;">Accepted</span>' : ''}
          </div>
          <div class="hud-help-response-msg">${escHTML(r.message)}</div>
          ${isOwnerView && isOwner && !isResolved && r.type !== 'followup' ? `
            <div class="hud-response-actions">
              ${!accepted && r.type === 'offer_help' ? `<button class="hud-resp-action-btn" data-resp-accept="${req.id}" data-resp-idx="${idx}">Accept Help</button>` : ''}
              ${r.type === 'offer_help' ? `<button class="hud-resp-action-btn hud-resp-schedule" data-resp-schedule="${req.id}" data-resp-idx="${idx}" data-helper-uid="${r.uid}" data-helper-name="${escHTML(r.name)}">Schedule Plan</button>` : ''}
            </div>
          ` : ''}
        </div>`;
      }).join('')}</div>`;
    }

    // Owner reply input (follow-up in the thread)
    let ownerReplyHTML = '';
    if (isOwnerView && isOwner && !isResolved) {
      ownerReplyHTML = `<div class="hud-help-respond hud-owner-reply">
        <input class="app-input hud-respond-msg" data-for="${req.id}" type="text" placeholder="Reply to this thread..." />
        <button class="app-btn app-btn--secondary hud-followup-btn" data-followup="${req.id}" style="font-size:.75rem; padding:.25rem .5rem;">Reply</button>
      </div>`;
    }

    return `<div class="hud-plan-card hud-help-card ${isResolved ? 'hud-status-completed' : ''}">
      <div class="hud-plan-top">
        <div class="hud-plan-owner">
          <div class="hud-plan-avatar" style="background:${getUserColor(req.ownerUid)}">${initials}</div>
          <span class="hud-plan-name">${escHTML(req.ownerName)}</span>
          ${isResolved ? '<span class="hud-status-badge completed">Resolved</span>' : '<span class="hud-status-badge" style="background:rgba(233,30,99,.15); color:var(--danger);">Needs Help</span>'}
        </div>
        <div class="hud-plan-owner-actions">
          ${isOwner && !isResolved ? `<button data-help-action="resolve" data-help-id="${req.id}" title="Mark resolved">${checkIcon()}</button>` : ''}
          ${isOwner ? `<button data-help-action="delete" data-help-id="${req.id}" title="Delete">${deleteIcon()}</button>` : ''}
        </div>
      </div>
      <div class="hud-plan-text" style="font-weight:600;">${escHTML(req.title)}</div>
      ${req.description ? `<div class="hud-plan-notes">${escHTML(req.description)}</div>` : ''}
      ${req.whatFailed ? `<div class="hud-help-detail"><span class="hud-help-label">What's wrong:</span> ${escHTML(req.whatFailed)}</div>` : ''}
      ${req.whatTried ? `<div class="hud-help-detail"><span class="hud-help-label">Already tried:</span> ${escHTML(req.whatTried)}</div>` : ''}
      ${responsesHTML}
      ${ownerReplyHTML}
      ${!isOwner && !isResolved ? `<div class="hud-help-respond">
        <select class="app-input hud-respond-type" data-for="${req.id}" style="max-width:160px;"><option value="offer_help">Offer to help</option><option value="suggestion">Suggest a fix</option><option value="advice">General advice</option></select>
        <input class="app-input hud-respond-msg" data-for="${req.id}" type="text" placeholder="Your response..." />
        <button class="app-btn app-btn--primary hud-respond-btn" data-respond="${req.id}" style="font-size:.75rem; padding:.25rem .5rem;">Send</button>
      </div>` : ''}
    </div>`;
  }

  function wireHelpResponses() {
    // Other users: send response
    appEl.querySelectorAll('.hud-respond-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const reqId = btn.dataset.respond;
        const typeEl = appEl.querySelector(`.hud-respond-type[data-for="${reqId}"]`);
        const msgEl = appEl.querySelector(`.hud-respond-msg[data-for="${reqId}"]`);
        const message = msgEl?.value?.trim();
        if (!message) return;
        btn.disabled = true;
        try { await addHelpResponse(reqId, { type: typeEl?.value || 'suggestion', message }); toast('Response sent!'); if (msgEl) msgEl.value = ''; }
        catch (err) { toast('Error sending response'); }
        btn.disabled = false;
      });
    });

    // Owner: follow-up reply in thread
    appEl.querySelectorAll('.hud-followup-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const reqId = btn.dataset.followup;
        const msgEl = appEl.querySelector(`.hud-owner-reply .hud-respond-msg[data-for="${reqId}"]`);
        const message = msgEl?.value?.trim();
        if (!message) return;
        btn.disabled = true;
        try { await addHelpResponse(reqId, { type: 'followup', message }); toast('Reply sent!'); if (msgEl) msgEl.value = ''; }
        catch (err) { toast('Error sending reply'); }
        btn.disabled = false;
      });
    });

    // Owner: accept help (mark a response as accepted)
    appEl.querySelectorAll('[data-resp-accept]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const reqId = btn.dataset.respAccept;
        const idx = parseInt(btn.dataset.respIdx);
        const req = _helpRequests.find(r => r.id === reqId);
        if (!req) return;
        const responses = [...(req.responses || [])];
        if (responses[idx]) {
          responses[idx] = { ...responses[idx], accepted: true };
          await db().collection('huddleHelpRequests').doc(reqId).update({
            responses, updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
          toast('Help accepted!');
        }
      });
    });

    // Owner: schedule a plan from a help offer
    appEl.querySelectorAll('[data-resp-schedule]').forEach(btn => {
      btn.addEventListener('click', () => {
        const reqId = btn.dataset.respSchedule;
        const helperName = btn.dataset.helperName;
        const helperUid = btn.dataset.helperUid;
        const req = _helpRequests.find(r => r.id === reqId);
        if (!req) return;
        showScheduleFromHelpModal(req, helperUid, helperName);
      });
    });

    // Resolve / delete
    appEl.querySelectorAll('[data-help-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.helpAction === 'resolve') { await resolveHelpRequest(btn.dataset.helpId); toast('Marked as resolved'); }
        else if (btn.dataset.helpAction === 'delete') { await deleteHelpRequest(btn.dataset.helpId); toast('Request deleted'); }
      });
    });
  }

  function showScheduleFromHelpModal(req, helperUid, helperName) {
    const overlay = document.createElement('div');
    overlay.className = 'hud-modal-overlay';
    overlay.innerHTML = `<div class="hud-modal">
      <h3>Schedule Help Session</h3>
      <p style="color:var(--muted); font-size:.82rem; margin:0 0 .75rem;">
        Create a plan for <strong>${escHTML(helperName)}</strong> to help with: <em>${escHTML(req.title)}</em>
      </p>
      <div class="hud-form-field">
        <label class="app-label">Task Description</label>
        <input id="hud-sched-text" class="app-input" type="text" value="Help session: ${escHTML(req.title)}" />
      </div>
      <div class="hud-form-row">
        <div class="hud-form-field" style="flex:1;">
          <label class="app-label">Date</label>
          <input id="hud-sched-day" class="app-input" type="date" />
        </div>
        <div class="hud-form-field">
          <label class="app-label">Start</label>
          <input id="hud-sched-start" class="app-input" type="time" value="${_huddleSettings?.defaultStartTime || '09:00'}" />
        </div>
        <div class="hud-form-field">
          <label class="app-label">End</label>
          <input id="hud-sched-end" class="app-input" type="time" value="${_huddleSettings?.defaultEndTime || '10:00'}" />
        </div>
      </div>
      <div class="hud-form-field">
        <label class="app-label">Notes</label>
        <input id="hud-sched-notes" class="app-input" type="text" placeholder="Optional details..." />
      </div>
      <div class="hud-modal-actions">
        <button class="app-btn app-btn--secondary" id="hud-sched-cancel">Cancel</button>
        <button class="app-btn app-btn--primary" id="hud-sched-confirm">Create Plan</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#hud-sched-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#hud-sched-confirm').addEventListener('click', async () => {
      const text = overlay.querySelector('#hud-sched-text').value.trim();
      const plannedDay = overlay.querySelector('#hud-sched-day').value || null;
      const startTime = overlay.querySelector('#hud-sched-start').value || null;
      const endTime = overlay.querySelector('#hud-sched-end').value || null;
      const notes = overlay.querySelector('#hud-sched-notes').value.trim() || '';

      if (!text) { toast('Please enter a description'); return; }
      if (!plannedDay) { toast('Please pick a date'); return; }

      try {
        // Create the plan
        const planRef = await createPlan({ text, plannedDay, startTime, endTime, notes });

        // Auto sign up the helper as a joiner
        if (planRef && helperUid) {
          const planId = planRef.id;
          await db().collection('huddlePlans').doc(planId).update({
            joiners: firebase.firestore.FieldValue.arrayUnion({
              uid: helperUid, name: helperName,
              skillLevel: '', helpNote: 'Scheduled from help request', type: 'join'
            }),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }

        toast('Help session scheduled!');
        overlay.remove();
      } catch (err) {
        console.warn('[Huddle] Schedule from help error:', err);
        toast('Error creating plan');
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     MODALS
     ═══════════════════════════════════════════════════════════ */
  function showSignupModal(planId) {
    const plan = _plans.find(p => p.id === planId);
    if (!plan) return;
    const existing = (plan.watchers || []).find(w => w.uid === _user.uid) || (plan.joiners || []).find(j => j.uid === _user.uid);

    const overlay = document.createElement('div');
    overlay.className = 'hud-modal-overlay';
    overlay.innerHTML = `<div class="hud-modal">
      <h3>Sign Up: ${escHTML(plan.text)}</h3>
      <p style="color:var(--muted); font-size:.82rem;">By <strong>${escHTML(plan.ownerName)}</strong></p>
      <div style="margin:.75rem 0;"><label class="app-label">How do you want to participate?</label>
        <select id="hud-su-type" class="app-input"><option value="join" ${existing?.type !== 'watch' ? 'selected' : ''}>Join (actively participate)</option><option value="watch" ${existing?.type === 'watch' ? 'selected' : ''}>Watch (observe only)</option></select></div>
      <div style="margin:.75rem 0;"><label class="app-label">Your skill level</label>
        <select id="hud-su-skill" class="app-input"><option value="learning">Learning (first time)</option><option value="practiced" ${existing?.skillLevel === 'practiced' ? 'selected' : ''}>Practiced</option><option value="canTeach" ${existing?.skillLevel === 'canTeach' ? 'selected' : ''}>Can Teach (expert)</option></select></div>
      <div style="margin:.75rem 0;"><label class="app-label">Note for the owner (optional)</label>
        <input id="hud-su-note" class="app-input" type="text" placeholder="How can you help?" value="${escHTML(existing?.helpNote || '')}" /></div>
      <div class="hud-modal-actions"><button class="app-btn app-btn--secondary" id="hud-su-cancel">Cancel</button><button class="app-btn app-btn--primary" id="hud-su-confirm">${existing ? 'Update' : 'Sign Up'}</button></div>
    </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#hud-su-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#hud-su-confirm').addEventListener('click', async () => {
      const type = overlay.querySelector('#hud-su-type').value;
      const skillLevel = overlay.querySelector('#hud-su-skill').value;
      const helpNote = overlay.querySelector('#hud-su-note').value.trim();
      await signUpForPlan(planId, { type, skillLevel, helpNote });
      toast('Signed up!');
      _popupPlanId = null;
      overlay.remove();
    });
  }

  function showDeleteConfirm(planId) {
    const overlay = document.createElement('div');
    overlay.className = 'hud-modal-overlay';
    overlay.innerHTML = `<div class="hud-modal"><h3>Delete Plan?</h3><p style="color:var(--muted); font-size:.85rem;">This will permanently remove this plan.</p>
      <div class="hud-modal-actions"><button class="app-btn app-btn--secondary" id="hud-modal-cancel">Cancel</button><button class="app-btn app-btn--danger" id="hud-modal-confirm">Delete</button></div></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#hud-modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#hud-modal-confirm').addEventListener('click', async () => { await deletePlan(planId); toast('Plan deleted'); _popupPlanId = null; overlay.remove(); });
  }

  function showSeriesDeleteModal(planId, seriesId) {
    const overlay = document.createElement('div');
    overlay.className = 'hud-modal-overlay';
    overlay.innerHTML = `<div class="hud-modal"><h3>Delete Recurring Plan</h3><p style="color:var(--muted); font-size:.85rem;">This is part of a recurring series.</p>
      <div class="hud-modal-actions">
        <button class="app-btn app-btn--secondary" id="hud-sd-cancel">Cancel</button>
        <button class="app-btn app-btn--danger" id="hud-sd-one">This One Only</button>
        <button class="app-btn app-btn--danger" id="hud-sd-all">Entire Series</button>
      </div></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#hud-sd-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#hud-sd-one').addEventListener('click', async () => { await deletePlan(planId); toast('Plan deleted'); _popupPlanId = null; overlay.remove(); });
    overlay.querySelector('#hud-sd-all').addEventListener('click', async () => { await deleteSeriesPlans(seriesId); toast('Series deleted'); _popupPlanId = null; overlay.remove(); });
  }

  /* ═══════════════════════════════════════════════════════════
     8. RUNDOWN — Weekly Task Feed
     ═══════════════════════════════════════════════════════════ */

  function renderRundownFeed() {
    const cats = getRundownCategories();

    // Group tasks by owner
    let tasks = _rundownTasks;
    if (_filterRundownCategory) tasks = tasks.filter(t => t.categoryId === _filterRundownCategory);

    const grouped = new Map();
    for (const t of tasks) {
      if (!grouped.has(t.ownerUid)) grouped.set(t.ownerUid, { name: t.ownerName, uid: t.ownerUid, tasks: [] });
      grouped.get(t.ownerUid).tasks.push(t);
    }

    const catOptions = cats.map(c =>
      `<option value="${c.id}" ${_filterRundownCategory === c.id ? 'selected' : ''}>${escHTML(c.label)}</option>`
    ).join('');

    let cardsHTML = '';
    if (grouped.size === 0) {
      cardsHTML = `<div style="color:var(--muted); text-align:center; padding:2rem;">No tasks this week. Be the first to add one!</div>`;
    } else {
      for (const [uid, group] of grouped) {
        const color = getUserColor(uid);
        cardsHTML += `<div class="hud-rundown-group">
          <div class="hud-rundown-group-header">
            <span class="hud-plan-avatar" style="background:${color}">${getInitials(group.name)}</span>
            <span class="hud-plan-name">${escHTML(group.name)}</span>
            <span style="color:var(--muted); font-size:.75rem;">${group.tasks.length} task${group.tasks.length !== 1 ? 's' : ''}</span>
          </div>
          ${group.tasks.map(t => renderRundownCard(t, uid === _user.uid)).join('')}
        </div>`;
      }
    }

    return `
      ${weekNavHTML()}
      <div class="hud-rundown-filters">
        <select id="hud-rd-cat-filter" class="app-input" style="max-width:200px; font-size:.8rem;">
          <option value="">All Categories</option>
          ${catOptions}
        </select>
      </div>
      <div class="hud-rundown-list">${cardsHTML}</div>`;
  }

  function renderRundownCard(task, isOwner) {
    const catColor = getCategoryColor(task.categoryId);
    const pendingCount = (task.joinRequests || []).filter(j => j.status === 'pending').length;
    const acceptedCount = (task.joinRequests || []).filter(j => j.status === 'accepted').length;
    const alreadyRequested = (task.joinRequests || []).some(j => j.uid === _user.uid);

    let joinBtn = '';
    if (!isOwner) {
      if (alreadyRequested) {
        joinBtn = `<span class="hud-rd-join-status">Requested</span>`;
      } else if (task.status === 'open') {
        joinBtn = `<button class="app-btn app-btn--secondary hud-rd-join-btn" data-task-id="${task.id}" style="font-size:.75rem; padding:.2rem .5rem;">Request to Join</button>`;
      }
    }

    let statusBadge = '';
    if (task.status === 'scheduled') statusBadge = '<span class="hud-status-badge" style="background:var(--accent);">Scheduled</span>';
    else if (task.status === 'done') statusBadge = '<span class="hud-status-badge" style="background:var(--success);">Done</span>';

    return `<div class="hud-rundown-card" style="border-left:3px solid ${catColor};">
      <div class="hud-rundown-card-top">
        <span class="hud-rundown-category-chip" style="background:${catColor}22; color:${catColor}; border:1px solid ${catColor}44;">${escHTML(task.categoryLabel)}</span>
        ${task.projectName ? `<span class="hud-rundown-project-chip">${escHTML(task.projectName)}</span>` : ''}
        ${statusBadge}
      </div>
      <div class="hud-rundown-card-text">${escHTML(task.text)}</div>
      <div class="hud-rundown-card-bottom">
        <div class="hud-rundown-card-meta">
          ${pendingCount ? `<span style="color:var(--warning); font-size:.72rem;">${pendingCount} pending</span>` : ''}
          ${acceptedCount ? `<span style="color:var(--success); font-size:.72rem;">${acceptedCount} joined</span>` : ''}
        </div>
        ${joinBtn}
      </div>
    </div>`;
  }

  function wireRundownFeed() {
    wireWeekNav();
    const catFilter = document.getElementById('hud-rd-cat-filter');
    if (catFilter) catFilter.addEventListener('change', () => { _filterRundownCategory = catFilter.value; renderMain(); });

    appEl.querySelectorAll('.hud-rd-join-btn').forEach(btn => {
      btn.addEventListener('click', () => showJoinTaskModal(btn.dataset.taskId));
    });
  }

  /* ═══════════════════════════════════════════════════════════
     9. ADD RUNDOWN TASK
     ═══════════════════════════════════════════════════════════ */

  function renderAddRundown() {
    const cats = getRundownCategories();
    const editing = _editingTaskId ? _rundownTasks.find(t => t.id === _editingTaskId) : null;

    const catOptions = cats.map(c =>
      `<option value="${c.id}" ${editing && editing.categoryId === c.id ? 'selected' : ''}>${escHTML(c.label)}</option>`
    ).join('');

    const projOptions = _projects.map(p =>
      `<option value="${p.id}" ${editing && editing.projectId === p.id ? 'selected' : ''}>${escHTML(p.title)}</option>`
    ).join('');

    return `<div class="hud-add-form hud-add-page">
      <h2>${editing ? 'Edit Task' : 'Add Rundown Task'}</h2>
      <p style="color:var(--muted); font-size:.82rem; margin:0 0 1.25rem;">Add what you plan to do this week. Others can request to join or shadow.</p>
      <div class="hud-form-field">
        <label class="app-label">What are you planning to do?</label>
        <input id="hud-rd-text" class="app-input" type="text" placeholder="e.g. Passage HUVECs, run Western blot..." value="${editing ? escHTML(editing.text) : ''}" />
      </div>
      <div class="hud-form-row">
        <div class="hud-form-field" style="flex:1;">
          <label class="app-label">Category</label>
          <select id="hud-rd-cat" class="app-input">${catOptions}</select>
        </div>
        <div class="hud-form-field" style="flex:1;">
          <label class="app-label">Project (optional)</label>
          <select id="hud-rd-proj" class="app-input">
            <option value="">None</option>
            ${projOptions}
          </select>
        </div>
      </div>
      <div style="margin-top:1rem;">
        <button class="app-btn app-btn--primary" id="hud-rd-submit">${editing ? 'Update Task' : 'Add Task'}</button>
        ${editing ? `<button class="app-btn app-btn--secondary" id="hud-rd-cancel-edit" style="margin-left:.5rem;">Cancel</button>` : ''}
      </div>
    </div>`;
  }

  function wireAddRundown() {
    const btn = document.getElementById('hud-rd-submit');
    if (btn) btn.addEventListener('click', async () => {
      const text = document.getElementById('hud-rd-text').value.trim();
      if (!text) { toast('Please describe your task'); return; }
      const catId = document.getElementById('hud-rd-cat').value;
      const cats = getRundownCategories();
      const cat = cats.find(c => c.id === catId);
      const projEl = document.getElementById('hud-rd-proj');
      const projId = projEl.value || null;
      const proj = projId ? _projects.find(p => p.id === projId) : null;

      try {
        if (_editingTaskId) {
          await updateRundownTask(_editingTaskId, {
            text, categoryId: catId, categoryLabel: cat ? cat.label : catId,
            projectId: projId, projectName: proj ? proj.title : null
          });
          toast('Task updated');
          _editingTaskId = null;
        } else {
          await createRundownTask({
            text, categoryId: catId, categoryLabel: cat ? cat.label : catId,
            projectId: projId, projectName: proj ? proj.title : null
          });
          toast('Task added!');
        }
        _currentSection = 'rundown';
        render();
      } catch (err) {
        console.warn('[Huddle] Add rundown error:', err);
        toast('Error saving task');
      }
    });

    const cancelBtn = document.getElementById('hud-rd-cancel-edit');
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      _editingTaskId = null;
      renderMain();
    });
  }

  /* ═══════════════════════════════════════════════════════════
     10. MY TASKS — Owner's Rundown with Join Requests
     ═══════════════════════════════════════════════════════════ */

  function renderMyTasks() {
    const myTasks = _rundownTasks.filter(t => t.ownerUid === _user.uid);

    if (myTasks.length === 0) {
      return `${weekNavHTML()}
        <div style="color:var(--muted); text-align:center; padding:2rem;">
          No tasks this week. <button class="app-btn app-btn--primary" id="hud-mt-add" style="font-size:.8rem; padding:.25rem .75rem; margin-left:.5rem;">Add Task</button>
        </div>`;
    }

    const cardsHTML = myTasks.map(task => {
      const catColor = getCategoryColor(task.categoryId);
      const joinReqs = task.joinRequests || [];
      const pending = joinReqs.filter(j => j.status === 'pending');

      let requestsHTML = '';
      if (joinReqs.length > 0) {
        requestsHTML = `<div class="hud-join-requests">
          <div class="hud-join-requests-heading">Join Requests (${joinReqs.length})</div>
          ${joinReqs.map(j => `<div class="hud-join-request">
            <div class="hud-join-request-info">
              <strong>${escHTML(j.name)}</strong>
              <span class="hud-join-skill">${j.skillLevel === 'canTeach' ? 'Can Teach' : j.skillLevel === 'practiced' ? 'Practiced' : 'Learning'}</span>
              ${j.note ? `<span class="hud-join-note">${escHTML(j.note)}</span>` : ''}
            </div>
            <div class="hud-join-actions">
              ${j.status === 'pending' ? `
                <button class="app-btn app-btn--primary hud-join-accept" data-task-id="${task.id}" data-uid="${j.uid}" data-name="${escHTML(j.name)}" style="font-size:.7rem; padding:.15rem .4rem;">Accept</button>
                <button class="app-btn app-btn--secondary hud-join-decline" data-task-id="${task.id}" data-uid="${j.uid}" style="font-size:.7rem; padding:.15rem .4rem;">Decline</button>
              ` : `<span class="hud-join-status-label hud-join-status-${j.status}">${j.status}</span>`}
            </div>
          </div>`).join('')}
        </div>`;
      }

      let statusBadge = '';
      if (task.status === 'scheduled') statusBadge = '<span class="hud-status-badge" style="background:var(--accent);">Scheduled</span>';
      else if (task.status === 'done') statusBadge = '<span class="hud-status-badge" style="background:var(--success);">Done</span>';

      return `<div class="hud-rundown-card hud-mytask-card" style="border-left:3px solid ${catColor};">
        <div class="hud-rundown-card-top">
          <span class="hud-rundown-category-chip" style="background:${catColor}22; color:${catColor}; border:1px solid ${catColor}44;">${escHTML(task.categoryLabel)}</span>
          ${task.projectName ? `<span class="hud-rundown-project-chip">${escHTML(task.projectName)}</span>` : ''}
          ${statusBadge}
          <span style="flex:1;"></span>
          <button class="hud-icon-btn hud-mt-edit" data-task-id="${task.id}" title="Edit">${editIcon()}</button>
          <button class="hud-icon-btn hud-mt-delete" data-task-id="${task.id}" title="Delete">${deleteIcon()}</button>
        </div>
        <div class="hud-rundown-card-text">${escHTML(task.text)}</div>
        ${pending.length ? `<div style="color:var(--warning); font-size:.75rem; margin:.25rem 0;">${pending.length} pending request${pending.length !== 1 ? 's' : ''}</div>` : ''}
        ${requestsHTML}
        ${task.status === 'open' ? `<div style="margin-top:.5rem;">
          <button class="app-btn app-btn--secondary hud-mt-done" data-task-id="${task.id}" style="font-size:.72rem; padding:.2rem .5rem;">Mark Done</button>
        </div>` : ''}
      </div>`;
    }).join('');

    return `${weekNavHTML()}<div class="hud-rundown-list">${cardsHTML}</div>`;
  }

  function wireMyTasks() {
    wireWeekNav();

    const addBtn = document.getElementById('hud-mt-add');
    if (addBtn) addBtn.addEventListener('click', () => { _currentSection = 'addrundown'; render(); });

    // Edit task
    appEl.querySelectorAll('.hud-mt-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        _editingTaskId = btn.dataset.taskId;
        _currentSection = 'addrundown';
        render();
      });
    });

    // Delete task
    appEl.querySelectorAll('.hud-mt-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (confirm('Delete this task?')) {
          await deleteRundownTask(btn.dataset.taskId);
          toast('Task deleted');
        }
      });
    });

    // Mark done
    appEl.querySelectorAll('.hud-mt-done').forEach(btn => {
      btn.addEventListener('click', async () => {
        await updateRundownTask(btn.dataset.taskId, { status: 'done' });
        toast('Task marked done');
      });
    });

    // Accept join request → open schedule modal
    appEl.querySelectorAll('.hud-join-accept').forEach(btn => {
      btn.addEventListener('click', async () => {
        const taskId = btn.dataset.taskId;
        const requesterUid = btn.dataset.uid;
        const requesterName = btn.dataset.name;
        await respondToJoinRequest(taskId, requesterUid, 'accepted');
        toast('Request accepted');
        const task = _rundownTasks.find(t => t.id === taskId);
        if (task) showScheduleFromRundownModal(task, requesterUid, requesterName);
      });
    });

    // Decline join request
    appEl.querySelectorAll('.hud-join-decline').forEach(btn => {
      btn.addEventListener('click', async () => {
        await respondToJoinRequest(btn.dataset.taskId, btn.dataset.uid, 'declined');
        toast('Request declined');
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     11. JOIN TASK MODAL & SCHEDULE FROM RUNDOWN
     ═══════════════════════════════════════════════════════════ */

  function showJoinTaskModal(taskId) {
    const task = _rundownTasks.find(t => t.id === taskId);
    if (!task) return;

    const overlay = document.createElement('div');
    overlay.className = 'hud-modal-overlay';
    overlay.innerHTML = `<div class="hud-modal">
      <h3>Request to Join</h3>
      <p style="color:var(--muted); font-size:.82rem; margin:0 0 .75rem;">
        <strong>${escHTML(task.ownerName)}</strong>: ${escHTML(task.text)}
      </p>
      <div style="margin:.75rem 0;">
        <label class="app-label">Your skill level for this task</label>
        <select id="hud-jt-skill" class="app-input">
          <option value="learning">Learning (first time / shadowing)</option>
          <option value="practiced">Practiced (can help)</option>
          <option value="canTeach">Can Teach (expert)</option>
        </select>
      </div>
      <div style="margin:.75rem 0;">
        <label class="app-label">Note (optional)</label>
        <input id="hud-jt-note" class="app-input" type="text" placeholder="What do you want to learn or how can you help?" />
      </div>
      <div class="hud-modal-actions">
        <button class="app-btn app-btn--secondary" id="hud-jt-cancel">Cancel</button>
        <button class="app-btn app-btn--primary" id="hud-jt-confirm">Send Request</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#hud-jt-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#hud-jt-confirm').addEventListener('click', async () => {
      const skillLevel = overlay.querySelector('#hud-jt-skill').value;
      const note = overlay.querySelector('#hud-jt-note').value.trim();
      await requestJoinTask(taskId, { skillLevel, note });
      toast('Request sent!');
      overlay.remove();
    });
  }

  function showScheduleFromRundownModal(task, requesterUid, requesterName) {
    const days = getWeekDays(_currentWeekOffset);

    // Check for availability overlap
    let overlapHTML = '';
    const dayOptions = days.map(d => {
      const overlaps = McgheeLab.ScheduleService ? McgheeLab.ScheduleService.resolveAvailabilityOverlap(_user.uid, requesterUid, d.date) : [];
      const overlapStr = overlaps.length > 0
        ? overlaps.map(o => `${fmtTime(o.startTime)}-${fmtTime(o.endTime)}`).join(', ')
        : '';
      return { date: d.date, label: `${d.dayShort} ${d.monthDay}`, overlaps, overlapStr };
    });

    const hasAnyOverlap = dayOptions.some(d => d.overlaps.length > 0);
    if (hasAnyOverlap) {
      overlapHTML = `<div class="hud-sched-overlap-info">
        <div style="font-size:.75rem; color:var(--muted); margin-bottom:.35rem;">Schedule overlaps with ${escHTML(requesterName)}:</div>
        ${dayOptions.filter(d => d.overlaps.length > 0).map(d =>
          `<div style="font-size:.78rem; margin:.15rem 0;"><strong>${d.label}</strong>: ${d.overlapStr}</div>`
        ).join('')}
      </div>`;
    }

    const overlay = document.createElement('div');
    overlay.className = 'hud-modal-overlay';
    overlay.innerHTML = `<div class="hud-modal">
      <h3>Schedule Task</h3>
      <p style="color:var(--muted); font-size:.82rem; margin:0 0 .75rem;">
        Schedule <em>${escHTML(task.text)}</em> with <strong>${escHTML(requesterName)}</strong>
      </p>
      ${overlapHTML}
      <div class="hud-form-field">
        <label class="app-label">Task Description</label>
        <input id="hud-srd-text" class="app-input" type="text" value="${escHTML(task.text)}" />
      </div>
      <div class="hud-form-row">
        <div class="hud-form-field" style="flex:1;">
          <label class="app-label">Date</label>
          <input id="hud-srd-day" class="app-input" type="date" />
        </div>
        <div class="hud-form-field">
          <label class="app-label">Start</label>
          <input id="hud-srd-start" class="app-input" type="time" value="${_huddleSettings?.defaultStartTime || '09:00'}" />
        </div>
        <div class="hud-form-field">
          <label class="app-label">End</label>
          <input id="hud-srd-end" class="app-input" type="time" value="${_huddleSettings?.defaultEndTime || '10:00'}" />
        </div>
      </div>
      <div class="hud-form-field">
        <label class="app-label">Notes</label>
        <input id="hud-srd-notes" class="app-input" type="text" placeholder="Optional details..." />
      </div>
      <div class="hud-modal-actions">
        <button class="app-btn app-btn--secondary" id="hud-srd-cancel">Cancel</button>
        <button class="app-btn app-btn--primary" id="hud-srd-confirm">Create Plan</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#hud-srd-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#hud-srd-confirm').addEventListener('click', async () => {
      const text = overlay.querySelector('#hud-srd-text').value.trim();
      const plannedDay = overlay.querySelector('#hud-srd-day').value || null;
      const startTime = overlay.querySelector('#hud-srd-start').value || null;
      const endTime = overlay.querySelector('#hud-srd-end').value || null;
      const notes = overlay.querySelector('#hud-srd-notes').value.trim() || '';

      if (!text) { toast('Please enter a description'); return; }
      if (!plannedDay) { toast('Please pick a date'); return; }

      try {
        const planRef = await createPlan({ text, plannedDay, startTime, endTime, notes });
        // Auto-add requester as joiner
        if (planRef && requesterUid) {
          await db().collection('huddlePlans').doc(planRef.id).update({
            joiners: firebase.firestore.FieldValue.arrayUnion({
              uid: requesterUid, name: requesterName,
              skillLevel: '', helpNote: 'Joined from rundown task', type: 'join'
            }),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        }
        // Update rundown task status
        await updateRundownTask(task.id, { status: 'scheduled', scheduledPlanId: planRef.id });
        toast('Task scheduled!');
        overlay.remove();
      } catch (err) {
        console.warn('[Huddle] Schedule from rundown error:', err);
        toast('Error creating plan');
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     13. TEAM AVAILABILITY — Gantt View
     ═══════════════════════════════════════════════════════════ */

  function renderTeamAvailability() {
    const days = getWeekDays(_currentWeekOffset);
    if (_teamViewDay === null) _teamViewDay = 0; // default Monday
    const selectedDay = days[_teamViewDay] || days[0];
    const dateStr = selectedDay.date;

    // Day selector tabs
    const dayTabs = days.map((d, i) =>
      `<button class="hud-view-btn ${i === _teamViewDay ? 'active' : ''}" data-team-day="${i}">${d.dayShort}</button>`
    ).join('');

    // Get all users' schedules for this day
    const userSchedules = [];
    const seenUids = new Set();
    const _ssTemplates = McgheeLab.ScheduleService ? McgheeLab.ScheduleService.getAllTemplates() : [];
    for (const tmpl of _ssTemplates) {
      seenUids.add(tmpl.id);
      const blocks = McgheeLab.ScheduleService.resolveScheduleForUser(tmpl.id, dateStr);
      userSchedules.push({ uid: tmpl.id, name: tmpl.ownerName, blocks });
    }

    // Time range for the bar
    const barStart = (_huddleSettings?.gridStartHour || 6) * 60;
    const barEnd = (_huddleSettings?.gridEndHour || 18) * 60;
    const barRange = barEnd - barStart;

    // Time labels
    const hourLabels = [];
    for (let h = Math.floor(barStart / 60); h <= Math.floor(barEnd / 60); h++) {
      const pct = ((h * 60 - barStart) / barRange * 100).toFixed(1);
      hourLabels.push(`<span class="hud-team-hour" style="left:${pct}%;">${h > 12 ? h - 12 : h}${h >= 12 ? 'p' : 'a'}</span>`);
    }

    let rowsHTML = '';
    if (userSchedules.length === 0) {
      rowsHTML = `<div style="color:var(--muted); text-align:center; padding:2rem;">No team members have set up their schedules yet.</div>`;
    } else {
      const _ssReasonColors = McgheeLab.ScheduleService ? McgheeLab.ScheduleService.REASON_COLORS : {};

      for (const us of userSchedules) {
        const color = getUserColor(us.uid);
        const isMe = us.uid === _user.uid;

        // Separate blocks by role
        const availBlocks = us.blocks.filter(b => b.type === 'available' && b.source !== 'calendar' && b.source !== 'custom');
        const overlayBlocks = us.blocks.filter(b => b.type === 'unavailable' || b.source === 'calendar' || b.source === 'custom');

        // Helper: time string to minutes
        const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

        // 1. Render base availability (green background)
        let segmentsHTML = '';
        for (const block of availBlocks) {
          const startMin = toMin(block.startTime);
          const endMin = toMin(block.endTime);
          const left = Math.max(0, (startMin - barStart) / barRange * 100);
          const width = Math.min(100 - left, (endMin - startMin) / barRange * 100);
          if (width <= 0) continue;

          segmentsHTML += `<div class="hud-team-segment" style="left:${left.toFixed(1)}%; width:${width.toFixed(1)}%; background:${color}44; border:1px solid ${color}66;" title="Available: ${fmtTime(block.startTime)}-${fmtTime(block.endTime)}"></div>`;
        }

        // 2. Overlay blocks subtract from availability and show context
        for (const block of overlayBlocks) {
          const startMin = toMin(block.startTime);
          const endMin = toMin(block.endTime);
          const left = Math.max(0, (startMin - barStart) / barRange * 100);
          const width = Math.min(100 - left, (endMin - startMin) / barRange * 100);
          if (width <= 0) continue;

          const isCal = block.source === 'calendar';
          const isCustom = block.source === 'custom';
          const isBusyAvail = block.calStatus === 'busy-available';
          const label = block.title || block.reason || 'Busy';

          let segColor, bgStyle, extraClass = '';

          if (isBusyAvail) {
            // Busy but available — slanted bar pattern, muted green
            segColor = '#16a34a';
            bgStyle = `background: repeating-linear-gradient(-45deg, ${segColor}22, ${segColor}22 4px, ${segColor}44 4px, ${segColor}44 8px); border:1px solid ${segColor}66;`;
            extraClass = ' hud-team-seg--busy-avail';
          } else if (isCal) {
            // Calendar event — purple, subtracts availability
            segColor = '#9333ea';
            bgStyle = `background:${segColor}55; border:1px solid ${segColor}66;`;
          } else if (isCustom) {
            // Custom event — use custom color
            segColor = block.color || '#a78bfa';
            bgStyle = `background:${segColor}55; border:1px solid ${segColor}66;`;
          } else {
            // Regular unavailable (blackout, special unavailability)
            segColor = _ssReasonColors[block.reason] || '#6b7280';
            bgStyle = `background:${segColor}33; border:1px solid ${segColor}66;`;
            if (block.rigidity === 'rigid') extraClass = ' hud-team-seg--rigid';
          }

          segmentsHTML += `<div class="hud-team-segment${extraClass}" style="left:${left.toFixed(1)}%; width:${width.toFixed(1)}%; ${bgStyle} z-index:1;" title="${escHTML(label)}: ${fmtTime(block.startTime)}-${fmtTime(block.endTime)}">
            ${width > 6 ? `<span class="hud-team-seg-label">${escHTML(label)}</span>` : ''}
          </div>`;
        }

        rowsHTML += `<div class="hud-team-row ${isMe ? 'hud-team-row--me' : ''}" data-team-uid="${us.uid}">
          <div class="hud-team-row-label">
            <span class="hud-plan-avatar" style="background:${color}; width:24px; height:24px; font-size:.65rem;">${getInitials(us.name)}</span>
            <span style="font-size:.78rem;">${escHTML(us.name)}${isMe ? ' (you)' : ''}</span>
          </div>
          <div class="hud-team-bar">
            ${segmentsHTML}
          </div>
        </div>`;
      }
    }

    return `
      ${weekNavHTML()}
      <div class="hud-view-toggle" style="margin:.5rem 0;">${dayTabs}</div>
      <div class="hud-team-container">
        <div class="hud-team-hour-labels" style="margin-left:140px; position:relative; height:18px; font-size:.65rem; color:var(--muted);">
          ${hourLabels.join('')}
        </div>
        ${rowsHTML}
      </div>`;
  }

  function wireTeamAvailability() {
    wireWeekNav();

    // Day tabs
    appEl.querySelectorAll('[data-team-day]').forEach(btn => {
      btn.addEventListener('click', () => {
        _teamViewDay = +btn.dataset.teamDay;
        renderMain();
      });
    });

    // Click a row to see comparison (future: could show detailed overlay)
    appEl.querySelectorAll('.hud-team-row').forEach(row => {
      row.addEventListener('click', () => {
        const uid = row.dataset.teamUid;
        if (uid === _user.uid) return;
        // Show a quick toast with overlap info
        const days = getWeekDays(_currentWeekOffset);
        const dateStr = days[_teamViewDay || 0]?.date;
        if (!dateStr) return;
        const overlaps = McgheeLab.ScheduleService ? McgheeLab.ScheduleService.resolveAvailabilityOverlap(_user.uid, uid, dateStr) : [];
        if (overlaps.length === 0) {
          toast('No schedule overlap found');
        } else {
          const str = overlaps.map(o => `${fmtTime(o.startTime)}-${fmtTime(o.endTime)}`).join(', ');
          toast(`Overlaps: ${str}`);
        }
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════
     7. SETTINGS PAGE
     ═══════════════════════════════════════════════════════════ */
  const DEFAULT_SETTINGS = {
    defaultStartTime: '09:00',
    defaultEndTime: '10:00',
    defaultView: 'weekly',
    gridStartHour: 6,
    gridEndHour: 18,
    defaultRecurrence: 'none',    // 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly'
    defaultRecDays: [1, 3, 5],    // Mon=1, Wed=3, Fri=5
    showWeekends: true
  };

  async function loadSettings() {
    try {
      const doc = await db().collection('huddleSettings').doc(_user.uid).get();
      _huddleSettings = doc.exists ? { ...DEFAULT_SETTINGS, ...doc.data() } : { ...DEFAULT_SETTINGS };
    } catch (err) {
      _huddleSettings = { ...DEFAULT_SETTINGS };
    }
  }

  async function saveSettings(data) {
    _huddleSettings = { ..._huddleSettings, ...data };
    await db().collection('huddleSettings').doc(_user.uid).set(
      _huddleSettings,
      { merge: true }
    );
  }

  function renderSettings() {
    const s = _huddleSettings || DEFAULT_SETTINGS;
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    return `
      <div class="hud-add-form hud-add-page">
        <h2>Huddle Settings</h2>
        <p style="color:var(--muted); font-size:.82rem; margin:0 0 1.25rem;">Set your defaults for new plans and display preferences.</p>

        <div class="hud-settings-group">
          <h3 class="hud-settings-heading">Plan Defaults</h3>
          <div class="hud-form-row">
            <div class="hud-form-field" style="flex:1;">
              <label class="app-label">Default Start Time</label>
              <input id="hud-set-start" class="app-input" type="time" value="${s.defaultStartTime}" />
            </div>
            <div class="hud-form-field" style="flex:1;">
              <label class="app-label">Default End Time</label>
              <input id="hud-set-end" class="app-input" type="time" value="${s.defaultEndTime}" />
            </div>
          </div>
          <div class="hud-form-field">
            <label class="app-label">Default Recurrence</label>
            <select id="hud-set-recurrence" class="app-input" style="max-width:220px;">
              <option value="none" ${s.defaultRecurrence === 'none' ? 'selected' : ''}>One-time (no recurrence)</option>
              <option value="daily" ${s.defaultRecurrence === 'daily' ? 'selected' : ''}>Daily</option>
              <option value="weekly" ${s.defaultRecurrence === 'weekly' ? 'selected' : ''}>Weekly</option>
              <option value="biweekly" ${s.defaultRecurrence === 'biweekly' ? 'selected' : ''}>Biweekly</option>
              <option value="monthly" ${s.defaultRecurrence === 'monthly' ? 'selected' : ''}>Monthly</option>
            </select>
          </div>
          <div class="hud-form-field">
            <label class="app-label">Default Recurrence Days</label>
            <div class="hud-day-picker">
              ${dayNames.map((d, i) => `<label class="hud-day-check ${(s.defaultRecDays || []).includes(i) ? 'checked' : ''}">
                <input type="checkbox" data-rec-day="${i}" ${(s.defaultRecDays || []).includes(i) ? 'checked' : ''} /> ${d}
              </label>`).join('')}
            </div>
          </div>
        </div>

        <div class="hud-settings-group">
          <h3 class="hud-settings-heading">Display</h3>
          <div class="hud-form-field">
            <label class="app-label">Default Calendar View</label>
            <select id="hud-set-view" class="app-input" style="max-width:220px;">
              <option value="daily" ${s.defaultView === 'daily' ? 'selected' : ''}>Daily</option>
              <option value="weekly" ${s.defaultView === 'weekly' ? 'selected' : ''}>Weekly</option>
              <option value="monthly" ${s.defaultView === 'monthly' ? 'selected' : ''}>Monthly</option>
            </select>
          </div>
          <div class="hud-form-row">
            <div class="hud-form-field" style="flex:1;">
              <label class="app-label">Grid Start Hour</label>
              <select id="hud-set-grid-start" class="app-input">
                ${[4,5,6,7,8,9].map(h => `<option value="${h}" ${s.gridStartHour === h ? 'selected' : ''}>${fmtTime(String(h).padStart(2,'0') + ':00')}</option>`).join('')}
              </select>
            </div>
            <div class="hud-form-field" style="flex:1;">
              <label class="app-label">Grid End Hour</label>
              <select id="hud-set-grid-end" class="app-input">
                ${[16,17,18,19,20,21,22,23].map(h => `<option value="${h}" ${s.gridEndHour === h ? 'selected' : ''}>${fmtTime(String(h).padStart(2,'0') + ':00')}</option>`).join('')}
              </select>
            </div>
          </div>
          <label class="hud-filter-check">
            <input type="checkbox" id="hud-set-weekends" ${s.showWeekends ? 'checked' : ''} />
            Show weekends on time grids
          </label>
        </div>

        ${(_profile?.role === 'admin') ? `
        <div class="hud-settings-group">
          <h3 class="hud-settings-heading">Rundown Categories (Admin)</h3>
          <p style="color:var(--muted); font-size:.78rem; margin:0 0 .75rem;">Manage categories available for rundown tasks lab-wide.</p>
          <div id="hud-cat-list">
            ${getRundownCategories().map((c, i) => `<div class="hud-category-row" data-cat-idx="${i}">
              <input type="color" class="hud-cat-color" value="${c.color}" data-cat-idx="${i}" />
              <input type="text" class="app-input hud-cat-label" value="${escHTML(c.label)}" data-cat-idx="${i}" style="flex:1; font-size:.82rem;" />
              <button class="hud-icon-btn hud-cat-remove" data-cat-idx="${i}" title="Remove">${deleteIcon()}</button>
            </div>`).join('')}
          </div>
          <div style="margin-top:.5rem; display:flex; gap:.5rem;">
            <button class="app-btn app-btn--secondary" id="hud-cat-add" style="font-size:.78rem;">+ Add Category</button>
            <button class="app-btn app-btn--primary" id="hud-cat-save" style="font-size:.78rem;">Save Categories</button>
          </div>
        </div>` : ''}

        <div class="hud-form-actions" style="margin-top:1.25rem;">
          <button id="hud-settings-save" class="app-btn app-btn--primary">Save Settings</button>
        </div>
      </div>`;
  }

  function wireSettings() {
    const saveBtn = document.getElementById('hud-settings-save');
    if (!saveBtn) return;

    // Admin category management
    const catAdd = document.getElementById('hud-cat-add');
    if (catAdd) {
      catAdd.addEventListener('click', () => {
        const list = document.getElementById('hud-cat-list');
        const idx = list.querySelectorAll('.hud-category-row').length;
        const newRow = document.createElement('div');
        newRow.className = 'hud-category-row';
        newRow.dataset.catIdx = idx;
        newRow.innerHTML = `
          <input type="color" class="hud-cat-color" value="#94a3b8" data-cat-idx="${idx}" />
          <input type="text" class="app-input hud-cat-label" value="" data-cat-idx="${idx}" placeholder="New category..." style="flex:1; font-size:.82rem;" />
          <button class="hud-icon-btn hud-cat-remove" data-cat-idx="${idx}" title="Remove">${deleteIcon()}</button>`;
        list.appendChild(newRow);
        newRow.querySelector('.hud-cat-remove').addEventListener('click', () => newRow.remove());
        newRow.querySelector('.hud-cat-label').focus();
      });
    }

    const catSave = document.getElementById('hud-cat-save');
    if (catSave) {
      catSave.addEventListener('click', async () => {
        const rows = document.querySelectorAll('.hud-category-row');
        const cats = [];
        rows.forEach(row => {
          const label = row.querySelector('.hud-cat-label')?.value?.trim();
          const color = row.querySelector('.hud-cat-color')?.value || '#94a3b8';
          if (label) {
            const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
            cats.push({ id, label, color });
          }
        });
        if (cats.length === 0) { toast('Must have at least one category'); return; }
        try {
          await saveRundownConfig(cats);
          toast('Categories saved!');
        } catch (err) { toast('Error saving categories'); }
      });
    }

    // Wire remove buttons for existing rows
    appEl.querySelectorAll('.hud-cat-remove').forEach(btn => {
      btn.addEventListener('click', () => btn.closest('.hud-category-row').remove());
    });

    saveBtn.addEventListener('click', async () => {
      const recDays = [];
      appEl.querySelectorAll('[data-rec-day]').forEach(cb => {
        if (cb.checked) recDays.push(parseInt(cb.dataset.recDay));
      });

      const data = {
        defaultStartTime: document.getElementById('hud-set-start')?.value || '09:00',
        defaultEndTime: document.getElementById('hud-set-end')?.value || '10:00',
        defaultRecurrence: document.getElementById('hud-set-recurrence')?.value || 'none',
        defaultRecDays: recDays,
        defaultView: document.getElementById('hud-set-view')?.value || 'weekly',
        gridStartHour: parseInt(document.getElementById('hud-set-grid-start')?.value || 6),
        gridEndHour: parseInt(document.getElementById('hud-set-grid-end')?.value || 18),
        showWeekends: document.getElementById('hud-set-weekends')?.checked ?? true
      };

      saveBtn.disabled = true;
      try {
        await saveSettings(data);
        _myPlansView = data.defaultView;
        toast('Settings saved!');
      } catch (err) {
        toast('Error saving settings');
      }
      saveBtn.disabled = false;
    });
  }

  /* ═══════════════════════════════════════════════════════════
     SHARED: Week Nav, Filters
     ═══════════════════════════════════════════════════════════ */
  function weekNavHTML() {
    return `<div class="hud-week-nav">
      <button id="hud-week-prev">&larr;</button>
      <span class="hud-week-label">${getWeekLabel(_currentWeekOffset)}</span>
      <button id="hud-week-next">&rarr;</button>
      ${_currentWeekOffset !== 0 ? '<button id="hud-week-today">This Week</button>' : ''}
    </div>`;
  }

  function wireWeekNav() {
    const p = document.getElementById('hud-week-prev'), n = document.getElementById('hud-week-next'), t = document.getElementById('hud-week-today');
    if (p) p.addEventListener('click', () => { _currentWeekOffset--; subscribePlans(); subscribeHelp(); subscribeRundown(); McgheeLab.ScheduleService?.setWeekOffset(_currentWeekOffset); renderMain(); });
    if (n) n.addEventListener('click', () => { _currentWeekOffset++; subscribePlans(); subscribeHelp(); subscribeRundown(); McgheeLab.ScheduleService?.setWeekOffset(_currentWeekOffset); renderMain(); });
    if (t) t.addEventListener('click', () => { _currentWeekOffset = 0; subscribePlans(); subscribeHelp(); subscribeRundown(); McgheeLab.ScheduleService?.setWeekOffset(_currentWeekOffset); renderMain(); });
  }

  function wireFilters() {
    const toggle = document.getElementById('hud-filter-toggle');
    const panel = document.getElementById('hud-filter-panel');
    if (toggle && panel) toggle.addEventListener('click', () => { panel.style.display = panel.style.display === 'none' ? '' : 'none'; });

    appEl.querySelectorAll('[data-filter="member"]').forEach(cb => {
      cb.addEventListener('change', () => { if (cb.checked) _filterMembers.add(cb.dataset.uid); else _filterMembers.delete(cb.dataset.uid); renderMain(); });
    });
    const clearBtn = document.getElementById('hud-filter-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => { _filterMembers.clear(); _filterStatus.clear(); renderMain(); });
  }

  /* ═══════════════════════════════════════════════════════════
     HELPERS
     ═══════════════════════════════════════════════════════════ */
  function getInitials(name) { if (!name) return '?'; return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2); }

  function escHTML(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function toast(msg) {
    const ex = document.querySelector('.hud-toast');
    if (ex) ex.remove();
    clearTimeout(_toastTimer);
    const el = document.createElement('div');
    el.className = 'hud-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    _toastTimer = setTimeout(() => el.remove(), 2500);
  }

  function notifyResize() {
    if (McgheeLab.AppBridge.isEmbedded()) {
      window.parent.postMessage({ type: 'mcgheelab-app-resize', height: document.body.scrollHeight }, window.location.origin);
    }
  }

  /* ─── SVG Icons ───────────────────────────────────────── */
  function calendarIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'; }
  function myPlansIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>'; }
  function plusIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'; }
  function helpIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'; }
  function myHelpIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'; }
  function requestHelpIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'; }
  function protocolIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'; }
  function filterIcon() { return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>'; }
  function checkIcon() { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'; }
  function deleteIcon() { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'; }
  function settingsIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'; }
  // Rundown & Schedule icons
  function rundownIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="13" y2="15"/></svg>'; }
  function addTaskIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>'; }
  function myTasksIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M9 14l2 2 4-4"/></svg>'; }
  function teamAvailIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>'; }
  function scheduleIcon() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'; }
  function lockIcon() { return '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'; }
  function editIcon() { return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'; }

})();
