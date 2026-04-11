/* ================================================================
   Lab Meeting — McGheeLab Lab App
   Schedule presentations, manage agendas, share notes,
   and track action items from weekly lab meetings.
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
  let _meetings = [];
  let _config = null;          // meetingConfig/settings doc
  let _labMembers = [];        // all users for assignee pickers
  let _currentSection = 'upcoming';
  let _unsubMeetings = null;
  let _toastTimer = null;
  let _archiveSearch = '';
  let _archivePresenter = '';
  let _archiveExpanded = null;
  let _myItemsShowAll = false;
  let _scheduleTab = 'overview'; // 'overview' | 'assign'

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
      await loadConfig();
      await loadLabMembers();
      render();
      subscribeMeetings();
      subscribeLabMembers();
      subscribeConfig();

      if (McgheeLab.MobileShell?.enableTabSwipe) {
        const tabs = [{ id: 'upcoming' }, { id: 'schedule' }, { id: 'archive' }, { id: 'myitems' }];
        if (_bridgeProfile?.role === 'admin') tabs.push({ id: 'settings' });
        McgheeLab.MobileShell.enableTabSwipe(tabs, () => _currentSection, (id) => { _currentSection = id; render(); });
      }
    }

    McgheeLab.AppBridge.init();
    if (McgheeLab.MobileShell) McgheeLab.MobileShell.configure({ appId: 'meetings', title: 'Lab Meeting' });
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
     HELPERS
     ═══════════════════════════════════════════════════════════ */
  function escHTML(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function genId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxx-xxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));
  }

  function toast(msg) {
    const ex = document.querySelector('.mtg-toast');
    if (ex) ex.remove();
    clearTimeout(_toastTimer);
    const el = document.createElement('div');
    el.className = 'mtg-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    _toastTimer = setTimeout(() => el.remove(), 2500);
  }

  function notifyResize() {
    if (McgheeLab.AppBridge.isEmbedded()) {
      window.parent.postMessage({ type: 'mcgheelab-app-resize', height: document.body.scrollHeight }, window.location.origin);
    }
  }

  function isAdmin() {
    return _profile && _profile.role === 'admin';
  }

  /** Meeting admin = site admin OR listed in meetingConfig.meetingAdmins */
  function isMeetingAdmin() {
    if (isAdmin()) return true;
    return _config && Array.isArray(_config.meetingAdmins) && _config.meetingAdmins.includes(_user.uid);
  }

  function fmtDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function fmtDateShort(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function fmtTime(timeStr) {
    if (!timeStr) return '';
    const [h, m] = timeStr.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + ' ' + ampm;
  }

  function toDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function todayStr() { return toDateStr(new Date()); }

  function daysUntil(dateStr) {
    const target = new Date(dateStr + 'T12:00:00');
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    return Math.round((target - now) / 86400000);
  }

  function memberName(uid) {
    const m = _labMembers.find(u => u.uid === uid);
    return m ? (m.name || m.displayName || m.email) : 'Unknown';
  }

  /** Get presenters array — handles both old (presenterId) and new (presenters[]) format */
  function getPresenters(mtg) {
    if (mtg.presenters && mtg.presenters.length) return mtg.presenters;
    if (mtg.presenterId) return [{ uid: mtg.presenterId, name: mtg.presenterName || '' }];
    return [];
  }

  function presenterNames(mtg) {
    const p = getPresenters(mtg);
    if (!p.length) return 'TBD';
    return p.map(x => x.name || memberName(x.uid)).join(' & ');
  }

  function isUserPresenter(mtg) {
    return getPresenters(mtg).some(p => p.uid === _user.uid);
  }

  /** Get the Monday of the week containing dateStr */
  function weekStart(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const day = d.getDay();
    d.setDate(d.getDate() - ((day + 6) % 7)); // shift to Monday
    return toDateStr(d);
  }

  /* ═══════════════════════════════════════════════════════════
     MINI CALENDAR WIDGET
     ═══════════════════════════════════════════════════════════ */
  function showCalendarPicker(inputEl, onSelect) {
    // Remove any existing picker
    document.querySelectorAll('.mtg-cal-popout').forEach(el => el.remove());

    const sel = inputEl.value || todayStr();
    let viewYear = parseInt(sel.slice(0, 4));
    let viewMonth = parseInt(sel.slice(5, 7)) - 1;

    const popout = document.createElement('div');
    popout.className = 'mtg-cal-popout';
    inputEl.parentNode.style.position = 'relative';
    inputEl.parentNode.appendChild(popout);

    function buildCal() {
      const dayNames = ['Mo','Tu','We','Th','Fr','Sa','Su'];
      const monthName = new Date(viewYear, viewMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const first = new Date(viewYear, viewMonth, 1);
      const startDay = (first.getDay() + 6) % 7; // 0=Mon
      const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
      const today = todayStr();

      let cells = '';
      for (let i = 0; i < startDay; i++) cells += '<span class="mtg-cal-empty"></span>';
      for (let d = 1; d <= daysInMonth; d++) {
        const ds = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const isSel = ds === sel;
        const isToday = ds === today;
        cells += `<button class="mtg-cal-day ${isSel ? 'mtg-cal-sel' : ''} ${isToday ? 'mtg-cal-today' : ''}" data-date="${ds}">${d}</button>`;
      }

      popout.innerHTML = `
        <div class="mtg-cal-header">
          <button class="mtg-cal-nav" data-dir="-1">&lsaquo;</button>
          <span class="mtg-cal-month">${monthName}</span>
          <button class="mtg-cal-nav" data-dir="1">&rsaquo;</button>
        </div>
        <div class="mtg-cal-grid">
          ${dayNames.map(n => `<span class="mtg-cal-label">${n}</span>`).join('')}
          ${cells}
        </div>`;

      // Nav arrows
      popout.querySelectorAll('.mtg-cal-nav').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          viewMonth += parseInt(btn.dataset.dir);
          if (viewMonth < 0) { viewMonth = 11; viewYear--; }
          if (viewMonth > 11) { viewMonth = 0; viewYear++; }
          buildCal();
        });
      });

      // Day selection
      popout.querySelectorAll('.mtg-cal-day').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          inputEl.value = btn.dataset.date;
          onSelect(btn.dataset.date);
          popout.remove();
        });
      });
    }

    buildCal();

    // Close on outside click
    function onClickAway(e) {
      if (!popout.contains(e.target) && e.target !== inputEl) {
        popout.remove();
        document.removeEventListener('click', onClickAway, true);
      }
    }
    setTimeout(() => document.addEventListener('click', onClickAway, true), 0);
  }

  /* ═══════════════════════════════════════════════════════════
     FIRESTORE — Config & Members
     ═══════════════════════════════════════════════════════════ */
  async function loadConfig() {
    try {
      const doc = await db().collection('meetingConfig').doc('settings').get();
      _config = doc.exists ? doc.data() : null;
    } catch (err) {
      console.warn('Failed to load meeting config:', err);
      _config = null;
    }
  }

  async function saveConfig(data) {
    try {
      await db().collection('meetingConfig').doc('settings').set({
        ...data,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      _config = { ..._config, ...data };
      toast('Settings saved');
    } catch (err) {
      console.warn('Failed to save config:', err);
      toast('Error saving settings');
    }
  }

  async function loadLabMembers() {
    try {
      const snap = await db().collection('users').get();
      _labMembers = snap.docs.map(d => ({ uid: d.id, ...d.data() }))
        .filter(u => u.role !== 'guest')
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    } catch (err) {
      console.warn('Failed to load lab members:', err);
      _labMembers = [];
    }
  }

  function subscribeLabMembers() {
    db().collection('users').onSnapshot(snap => {
      _labMembers = snap.docs.map(d => ({ uid: d.id, ...d.data() }))
        .filter(u => u.role !== 'guest')
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    });
  }

  function subscribeConfig() {
    db().collection('meetingConfig').doc('settings').onSnapshot(doc => {
      if (doc.exists) { _config = doc.data(); }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     FIRESTORE — Meetings CRUD
     ═══════════════════════════════════════════════════════════ */
  function subscribeMeetings() {
    if (_unsubMeetings) _unsubMeetings();
    _unsubMeetings = db().collection('meetings')
      .orderBy('date', 'asc')
      .onSnapshot(snap => {
        _meetings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderMain();
      }, err => {
        console.warn('Meetings listener error:', err);
      });
  }

  async function createMeeting(data) {
    try {
      await db().collection('meetings').add({
        ...data,
        presenters: data.presenters || [],
        agendaItems: data.agendaItems || [],
        actionItems: data.actionItems || [],
        feedback: data.feedback || [],
        notes: data.notes || '',
        presentationTitle: data.presentationTitle || '',
        presentationNotes: data.presentationNotes || '',
        presentationLinks: data.presentationLinks || [],
        createdBy: _user.uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      toast('Meeting created');
    } catch (err) {
      console.warn('Failed to create meeting:', err);
      toast('Error creating meeting');
    }
  }

  async function updateMeeting(id, data) {
    try {
      await db().collection('meetings').doc(id).update({
        ...data,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (err) {
      console.warn('Failed to update meeting:', err);
      toast('Error updating meeting');
    }
  }

  async function deleteMeeting(id) {
    try {
      await db().collection('meetings').doc(id).delete();
      toast('Meeting deleted');
    } catch (err) {
      console.warn('Failed to delete meeting:', err);
      toast('Error deleting meeting');
    }
  }

  /* ─── Presenter Assignment ───────────────────────────── */
  async function assignPresenter(meetingId, slot, uid) {
    const mtg = _meetings.find(m => m.id === meetingId);
    if (!mtg) return;
    const presenters = [...getPresenters(mtg)];
    const entry = uid ? { uid, name: memberName(uid) } : null;
    if (slot === 0) {
      if (entry) presenters[0] = entry; else presenters.splice(0, 1);
    } else if (slot === 1) {
      if (entry) presenters[1] = entry; else if (presenters.length > 1) presenters.splice(1, 1);
    }
    await updateMeeting(meetingId, { presenters: presenters.filter(Boolean) });
    toast('Presenter updated');
  }

  /* ─── Agenda Items ───────────────────────────────────── */
  async function addAgendaItem(meetingId, text, type) {
    const meeting = _meetings.find(m => m.id === meetingId);
    if (!meeting) return;
    const items = [...(meeting.agendaItems || [])];
    items.push({
      id: genId(),
      text: text,
      addedBy: _user.uid,
      addedByName: _profile.name || _user.displayName || _user.email,
      type: type || 'business',
      order: items.length,
      done: false
    });
    await updateMeeting(meetingId, { agendaItems: items });
    toast('Agenda item added');
  }

  async function toggleAgendaItem(meetingId, itemId) {
    const meeting = _meetings.find(m => m.id === meetingId);
    if (!meeting) return;
    const items = (meeting.agendaItems || []).map(it =>
      it.id === itemId ? { ...it, done: !it.done } : it
    );
    await updateMeeting(meetingId, { agendaItems: items });
  }

  async function removeAgendaItem(meetingId, itemId) {
    const meeting = _meetings.find(m => m.id === meetingId);
    if (!meeting) return;
    const items = (meeting.agendaItems || []).filter(it => it.id !== itemId);
    await updateMeeting(meetingId, { agendaItems: items });
    toast('Agenda item removed');
  }

  /* ─── Action Items ───────────────────────────────────── */
  async function addActionItem(meetingId, text, assigneeUid, deadline) {
    const meeting = _meetings.find(m => m.id === meetingId);
    if (!meeting) return;
    const items = [...(meeting.actionItems || [])];
    items.push({
      id: genId(),
      text: text,
      assigneeUid: assigneeUid || '',
      assigneeName: assigneeUid ? memberName(assigneeUid) : '',
      deadline: deadline || null,
      status: 'open',
      createdAt: new Date().toISOString()
    });
    await updateMeeting(meetingId, { actionItems: items });
    toast('Action item added');
  }

  async function toggleActionItem(meetingId, itemId) {
    const meeting = _meetings.find(m => m.id === meetingId);
    if (!meeting) return;
    const items = (meeting.actionItems || []).map(it =>
      it.id === itemId ? { ...it, status: it.status === 'done' ? 'open' : 'done' } : it
    );
    await updateMeeting(meetingId, { actionItems: items });
  }

  async function removeActionItem(meetingId, itemId) {
    const meeting = _meetings.find(m => m.id === meetingId);
    if (!meeting) return;
    const items = (meeting.actionItems || []).filter(it => it.id !== itemId);
    await updateMeeting(meetingId, { actionItems: items });
    toast('Action item removed');
  }

  /* ─── Feedback / Reactions ───────────────────────────── */
  async function addFeedback(meetingId, type, comment) {
    const meeting = _meetings.find(m => m.id === meetingId);
    if (!meeting) return;
    const fb = [...(meeting.feedback || [])];
    const idx = fb.findIndex(f => f.uid === _user.uid && f.type === type);
    if (idx >= 0) {
      fb.splice(idx, 1);
      await updateMeeting(meetingId, { feedback: fb });
      toast('Reaction removed');
      return;
    }
    fb.push({
      uid: _user.uid,
      name: _profile.name || _user.displayName || _user.email,
      type: type,
      comment: comment || '',
      createdAt: new Date().toISOString()
    });
    await updateMeeting(meetingId, { feedback: fb });
    toast('Reaction added');
  }

  /* ─── Presentation Files & Links ──────────────────────── */
  async function uploadFile(file, meetingDate) {
    if (typeof firebase === 'undefined' || !firebase.storage) {
      toast('Storage not available');
      return null;
    }
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `meetings/${meetingDate}/${Date.now()}_${safeName}`;
      const ref = firebase.storage().ref().child(path);
      const snap = await ref.put(file);
      const downloadUrl = await snap.ref.getDownloadURL();
      return {
        url: downloadUrl,
        storagePath: path,
        name: file.name,
        size: file.size,
        contentType: file.type,
        isImage: (file.type || '').startsWith('image/'),
        isUpload: true
      };
    } catch (err) {
      console.warn('Upload error:', err);
      toast('Upload failed: ' + (err.message || 'Unknown error'));
      return null;
    }
  }

  function formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  async function addPresentationLink(meetingId, label, url) {
    const meeting = _meetings.find(m => m.id === meetingId);
    if (!meeting) return;
    const links = [...(meeting.presentationLinks || [])];
    links.push({ label, url });
    await updateMeeting(meetingId, { presentationLinks: links });
    toast('Link added');
  }

  async function addPresentationFile(meetingId, fileInfo) {
    const meeting = _meetings.find(m => m.id === meetingId);
    if (!meeting) return;
    const links = [...(meeting.presentationLinks || [])];
    links.push({
      label: fileInfo.name,
      url: fileInfo.url,
      storagePath: fileInfo.storagePath,
      name: fileInfo.name,
      size: fileInfo.size,
      contentType: fileInfo.contentType,
      isImage: fileInfo.isImage,
      isUpload: true
    });
    await updateMeeting(meetingId, { presentationLinks: links });
    toast('File uploaded');
  }

  async function removePresentationLink(meetingId, index) {
    const meeting = _meetings.find(m => m.id === meetingId);
    if (!meeting) return;
    const links = [...(meeting.presentationLinks || [])];
    links.splice(index, 1);
    await updateMeeting(meetingId, { presentationLinks: links });
    toast('Link removed');
  }

  /* ─── Postpone Meeting ───────────────────────────────── */
  function showPostponeModal(mtg) {
    const overlay = document.createElement('div');
    overlay.className = 'mtg-modal-overlay';
    overlay.innerHTML = `
      <div class="mtg-modal">
        <h3>Postpone Meeting</h3>
        <p class="mtg-muted">Move this meeting (${fmtDate(mtg.date)}) to a new date.</p>
        <label class="app-label">New Date</label>
        <div class="mtg-form-row">
          <input class="app-input" id="mtg-postpone-date" type="text" value="" placeholder="Click to pick a date" readonly />
        </div>
        <div style="display:flex;gap:.5rem;margin-top:1rem;">
          <button class="app-btn app-btn--primary" id="mtg-postpone-save">Move Meeting</button>
          <button class="app-btn app-btn--secondary" id="mtg-postpone-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Attach calendar to the date input
    const dateInput = overlay.querySelector('#mtg-postpone-date');
    dateInput.addEventListener('click', () => {
      showCalendarPicker(dateInput, () => {});
    });

    overlay.querySelector('#mtg-postpone-save').addEventListener('click', async () => {
      const newDate = dateInput.value;
      if (!newDate) { toast('Pick a new date'); return; }
      if (newDate === mtg.date) { toast('Same date — pick a different one'); return; }
      await updateMeeting(mtg.id, { date: newDate });
      overlay.remove();
      toast('Meeting postponed to ' + fmtDate(newDate));
    });

    overlay.querySelector('#mtg-postpone-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  /* ═══════════════════════════════════════════════════════════
     MEETING GENERATION
     ═══════════════════════════════════════════════════════════ */
  async function generateMeetings() {
    if (!_config) { toast('Configure settings first'); return; }
    const { defaultDay, defaultTime, defaultDuration, defaultLocation,
            semesterStart, semesterEnd, skipWeeks } = _config;
    if (!semesterStart || !semesterEnd) {
      toast('Set semester start and end dates first');
      return;
    }

    const existingDates = new Set(_meetings.map(m => m.date));
    const skipSet = new Set((skipWeeks || []).map(w => w)); // week-start (Monday) dates
    const start = new Date(semesterStart + 'T12:00:00');
    const end = new Date(semesterEnd + 'T12:00:00');
    let created = 0;

    const d = new Date(start);
    while (d <= end) {
      if (d.getDay() === (defaultDay || 3)) {
        const dateStr = toDateStr(d);
        const wk = weekStart(dateStr);
        if (!existingDates.has(dateStr) && !skipSet.has(wk)) {
          await createMeeting({
            date: dateStr,
            time: defaultTime || '14:00',
            duration: defaultDuration || 60,
            location: defaultLocation || '',
            status: 'upcoming',
            presenters: []  // admin assigns manually
          });
          created++;
        }
      }
      d.setDate(d.getDate() + 1);
    }

    toast(created ? `${created} meeting(s) generated` : 'No new meetings to generate');
    renderMain();
  }

  /* ═══════════════════════════════════════════════════════════
     RENDER — Main Dispatcher
     ═══════════════════════════════════════════════════════════ */
  function render() {
    if (McgheeLab.MobileShell?.saveTabScroll) McgheeLab.MobileShell.saveTabScroll('mtg-tabs');
    appEl.innerHTML = `
      <div class="mtg-layout">
        <nav class="mtg-sidebar" id="mtg-tabs">${sidebarHTML()}</nav>
        <div class="mtg-main" id="mtg-main">${renderSection()}</div>
      </div>`;
    wireSidebar();
    wireSection();
    notifyResize();
    if (McgheeLab.MobileShell?.centerActiveTab) {
      McgheeLab.MobileShell.centerActiveTab(document.getElementById('mtg-tabs'), '.active');
    }
  }

  function renderMain() {
    const m = document.getElementById('mtg-main');
    if (!m) return render();
    m.innerHTML = renderSection();
    wireSection();
    notifyResize();
  }

  /* ─── Sidebar ─────────────────────────────────────────── */
  function sidebarHTML() {
    const openItems = getAllOpenActionItems().filter(i => i.assigneeUid === _user.uid).length;

    const sections = [
      { heading: '', items: [
        { id: 'upcoming', label: 'Next Meeting', icon: calendarIcon() },
        { id: 'schedule', label: 'Schedule', icon: listIcon() },
      ]},
      { heading: '', items: [
        { id: 'archive', label: 'Archive', icon: archiveIcon() },
        { id: 'myitems', label: 'My Items' + (openItems ? ` (${openItems})` : ''), icon: checkIcon() },
      ]},
      // Settings visible only to site admin (config writes require admin)
      ...(isAdmin() ? [{ heading: '', items: [
        { id: 'settings', label: 'Settings', icon: settingsIcon() },
      ]}] : [])
    ];

    return sections.map((sec, i) => `
      ${i > 0 ? '<div class="mtg-sidebar-divider"></div>' : ''}
      ${sec.items.map(it => `
        <button class="mtg-sidebar-btn ${_currentSection === it.id ? 'active' : ''}" data-section="${it.id}">
          ${it.icon} ${it.label}
        </button>
      `).join('')}
    `).join('');
  }

  function wireSidebar() {
    appEl.querySelectorAll('.mtg-sidebar-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const section = btn.dataset.section;
        if (section === _currentSection) return;
        _currentSection = section;
        render();
      });
    });
  }

  function renderSection() {
    switch (_currentSection) {
      case 'upcoming':  return renderUpcoming();
      case 'schedule':  return renderSchedule();
      case 'archive':   return renderArchive();
      case 'myitems':   return renderMyItems();
      case 'settings':  return renderSettings();
      default:          return renderUpcoming();
    }
  }

  function wireSection() {
    switch (_currentSection) {
      case 'upcoming':  wireUpcoming(); break;
      case 'schedule':  wireSchedule(); break;
      case 'archive':   wireArchive(); break;
      case 'myitems':   wireMyItems(); break;
      case 'settings':  wireSettings(); break;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     1. NEXT MEETING VIEW
     ═══════════════════════════════════════════════════════════ */
  function getNextMeeting() {
    const today = todayStr();
    return _meetings.find(m => m.date >= today && m.status !== 'cancelled');
  }

  function getPreviousMeeting() {
    const today = todayStr();
    const past = _meetings.filter(m => m.date < today || m.status === 'completed');
    return past.length ? past[past.length - 1] : null;
  }

  function getAllOpenActionItems() {
    const items = [];
    _meetings.forEach(m => {
      (m.actionItems || []).forEach(ai => {
        if (ai.status === 'open') items.push({ ...ai, meetingId: m.id, meetingDate: m.date });
      });
    });
    return items;
  }

  function renderUpcoming() {
    const mtg = getNextMeeting();
    if (!mtg) {
      return `
        <div class="app-empty">
          <p>No upcoming meetings scheduled.</p>
          ${isMeetingAdmin() ? '<p style="color:var(--muted)">Go to Settings to configure and generate meetings.</p>' : ''}
        </div>`;
    }

    const days = daysUntil(mtg.date);
    const countdownText = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days`;
    const pres = getPresenters(mtg);
    const isMePresenter = isUserPresenter(mtg);

    // Previous meeting's open action items
    const prevMtg = getPreviousMeeting();
    const carryItems = prevMtg ? (prevMtg.actionItems || []) : [];

    return `
      <div class="mtg-upcoming">
        <!-- Header -->
        <div class="mtg-meeting-header">
          <div class="mtg-meeting-date">${fmtDate(mtg.date)} &middot; ${fmtTime(mtg.time)}${mtg.location ? ' &middot; ' + escHTML(mtg.location) : ''}</div>
          <div class="mtg-countdown">${countdownText}</div>
        </div>

        <!-- Presenters -->
        <div class="app-card mtg-section">
          <div class="mtg-section-title">${presenterIcon()} Presenter(s)</div>
          ${pres.length ? `
            <div class="mtg-presenter-list">
              ${pres.map(p => `
                <div class="mtg-presenter">
                  <strong>${escHTML(p.name || memberName(p.uid))}</strong>
                  ${p.uid === _user.uid ? '<span class="app-badge app-badge--active">You</span>' : ''}
                </div>
              `).join('')}
            </div>` : `<div class="mtg-muted">No presenters assigned yet${isMeetingAdmin() ? ' — assign on the <a href="#" class="mtg-link-inline" id="mtg-go-assign">Schedule &gt; Assign</a> tab' : ''}</div>`}
          ${mtg.presentationTitle ? `<div class="mtg-pres-title">"${escHTML(mtg.presentationTitle)}"</div>` : ''}
          ${mtg.presentationNotes ? `<div class="mtg-pres-notes">${escHTML(mtg.presentationNotes)}</div>` : ''}
          ${(mtg.presentationLinks || []).length ? `
            <div class="mtg-pres-links">
              ${mtg.presentationLinks.map((lnk, i) => `
                ${lnk.isUpload && lnk.isImage ? `
                  <div class="mtg-file-preview">
                    <a href="${escHTML(lnk.url)}" target="_blank" rel="noopener"><img src="${escHTML(lnk.url)}" alt="${escHTML(lnk.name)}" class="mtg-file-thumb" /></a>
                    <span class="mtg-file-name">${escHTML(lnk.name)}</span>
                    ${(isMePresenter || isMeetingAdmin()) ? `<button class="mtg-link-remove" data-meeting="${mtg.id}" data-link-idx="${i}">&times;</button>` : ''}
                  </div>` : lnk.isUpload ? `
                  <div class="mtg-file-card">
                    ${fileIcon()}
                    <a href="${escHTML(lnk.url)}" target="_blank" rel="noopener" class="mtg-file-name">${escHTML(lnk.name)}</a>
                    <span class="mtg-muted">${formatFileSize(lnk.size)}</span>
                    ${(isMePresenter || isMeetingAdmin()) ? `<button class="mtg-link-remove" data-meeting="${mtg.id}" data-link-idx="${i}">&times;</button>` : ''}
                  </div>` : `
                  <a href="${escHTML(lnk.url)}" target="_blank" rel="noopener" class="mtg-link-chip">${linkIcon()} ${escHTML(lnk.label)}</a>
                  ${(isMePresenter || isMeetingAdmin()) ? `<button class="mtg-link-remove" data-meeting="${mtg.id}" data-link-idx="${i}">&times;</button>` : ''}`}
              `).join('')}
            </div>` : ''}
          ${isMePresenter || isMeetingAdmin() ? `
            <div class="mtg-pres-edit">
              <button class="app-btn app-btn--secondary mtg-btn-sm" id="mtg-edit-pres">Edit Presentation Details</button>
            </div>` : ''}
        </div>

        <!-- Agenda -->
        <div class="app-card mtg-section">
          <div class="mtg-section-title">${agendaIcon()} Agenda</div>
          <div class="mtg-agenda-list" id="mtg-agenda-list">
            ${pres.length ? `
              <div class="mtg-agenda-item mtg-agenda-item--pres">
                <span class="mtg-agenda-type-badge mtg-agenda-type--presentation">Presentation</span>
                ${escHTML(presenterNames(mtg))}'s presentation
              </div>` : ''}
            ${(mtg.agendaItems || []).map(item => `
              <div class="mtg-agenda-item">
                <label class="mtg-agenda-check">
                  <input type="checkbox" data-meeting="${mtg.id}" data-item="${item.id}" ${item.done ? 'checked' : ''} ${!isMeetingAdmin() ? 'disabled' : ''} />
                  <span class="${item.done ? 'mtg-done' : ''}">${escHTML(item.text)}</span>
                </label>
                <span class="mtg-agenda-type-badge mtg-agenda-type--${item.type}">${item.type}</span>
                <span class="mtg-agenda-by">${escHTML(item.addedByName)}</span>
                ${isMeetingAdmin() ? `<button class="mtg-remove-btn" data-meeting="${mtg.id}" data-remove-agenda="${item.id}">&times;</button>` : ''}
              </div>
            `).join('')}
          </div>
          ${isMeetingAdmin() ? `
            <div class="mtg-add-agenda">
              <input class="app-input mtg-input-sm" id="mtg-agenda-text" type="text" placeholder="Add agenda item..." />
              <select class="app-input mtg-select-sm" id="mtg-agenda-type">
                <option value="business">Business</option>
                <option value="announcement">Announcement</option>
                <option value="discussion">Discussion</option>
              </select>
              <button class="app-btn app-btn--primary mtg-btn-sm" id="mtg-agenda-add">Add</button>
            </div>` : ''}
        </div>

        <!-- Carry-over Action Items from Previous Meeting -->
        ${carryItems.length ? `
          <div class="app-card mtg-section">
            <div class="mtg-section-title">${checkIcon()} Open Items from Previous Meeting</div>
            <div class="mtg-action-list">
              ${carryItems.map(ai => `
                <div class="mtg-action-item ${ai.status === 'done' ? 'mtg-action-done' : ''}">
                  <label class="mtg-action-check">
                    <input type="checkbox" data-meeting="${prevMtg.id}" data-action="${ai.id}" ${ai.status === 'done' ? 'checked' : ''} ${!isMeetingAdmin() ? 'disabled' : ''} />
                    <span class="${ai.status === 'done' ? 'mtg-done' : ''}">${escHTML(ai.text)}</span>
                  </label>
                  <span class="mtg-action-assignee">${escHTML(ai.assigneeName)}</span>
                  ${ai.deadline ? `<span class="mtg-action-deadline">${fmtDateShort(ai.deadline)}</span>` : ''}
                </div>
              `).join('')}
            </div>
          </div>` : ''}

        <!-- Notes -->
        <div class="app-card mtg-section">
          <div class="mtg-section-title">${notesIcon()} Notes</div>
          ${isMeetingAdmin() ? `
            <textarea class="app-input mtg-notes-area" id="mtg-notes" placeholder="Shared meeting notes...">${escHTML(mtg.notes || '')}</textarea>
            <button class="app-btn app-btn--secondary mtg-btn-sm" id="mtg-save-notes" style="margin-top:.5rem">Save Notes</button>
          ` : (mtg.notes ? `<div class="mtg-archive-notes">${escHTML(mtg.notes)}</div>` : '<div class="mtg-muted">No notes yet</div>')}
        </div>

        <!-- Action Items for This Meeting -->
        <div class="app-card mtg-section">
          <div class="mtg-section-title">${checkIcon()} Action Items</div>
          <div class="mtg-action-list" id="mtg-action-list">
            ${(mtg.actionItems || []).map(ai => `
              <div class="mtg-action-item ${ai.status === 'done' ? 'mtg-action-done' : ''}">
                <label class="mtg-action-check">
                  <input type="checkbox" data-meeting="${mtg.id}" data-action="${ai.id}" ${ai.status === 'done' ? 'checked' : ''} ${!isMeetingAdmin() ? 'disabled' : ''} />
                  <span class="${ai.status === 'done' ? 'mtg-done' : ''}">${escHTML(ai.text)}</span>
                </label>
                <span class="mtg-action-assignee">${escHTML(ai.assigneeName)}</span>
                ${ai.deadline ? `<span class="mtg-action-deadline">${fmtDateShort(ai.deadline)}</span>` : ''}
                ${(isMeetingAdmin()) ? `<button class="mtg-remove-btn" data-meeting="${mtg.id}" data-remove-action="${ai.id}">&times;</button>` : ''}
              </div>
            `).join('')}
          </div>
          ${isMeetingAdmin() ? `
            <div class="mtg-add-action">
              <input class="app-input mtg-input-sm" id="mtg-action-text" type="text" placeholder="New action item..." />
              <select class="app-input mtg-select-sm" id="mtg-action-assignee">
                <option value="">Assignee...</option>
                ${_labMembers.map(u => `<option value="${u.uid}">${escHTML(u.name || u.email)}</option>`).join('')}
              </select>
              <input class="app-input mtg-input-sm" id="mtg-action-deadline" type="date" />
              <button class="app-btn app-btn--primary mtg-btn-sm" id="mtg-action-add">Add</button>
            </div>` : ''}
        </div>

        <!-- Feedback / Reactions -->
        ${(mtg.status === 'completed' || mtg.date <= todayStr()) && pres.length ? `
          <div class="app-card mtg-section">
            <div class="mtg-section-title">${reactionIcon()} Reactions</div>
            <div class="mtg-feedback-summary">
              ${feedbackSummaryHTML(mtg)}
            </div>
            ${!isUserPresenter(mtg) ? `
              <div class="mtg-feedback-chips">
                ${['interesting', 'question', 'collaborate', 'relevant'].map(type => {
                  const active = (mtg.feedback || []).some(f => f.uid === _user.uid && f.type === type);
                  return `<button class="mtg-feedback-chip ${active ? 'mtg-feedback-chip--active' : ''}" data-meeting="${mtg.id}" data-feedback="${type}">${feedbackLabel(type)}</button>`;
                }).join('')}
              </div>` : ''}
          </div>` : ''}

        <!-- Admin actions -->
        ${isMeetingAdmin() ? `
          <div class="mtg-admin-actions">
            ${mtg.status === 'upcoming' ? `
              <button class="app-btn app-btn--primary" id="mtg-complete">Mark as Completed</button>
              <button class="app-btn app-btn--secondary" id="mtg-postpone">Postpone</button>
              <button class="app-btn app-btn--danger" id="mtg-cancel">Cancel Meeting</button>
            ` : ''}
            ${mtg.status === 'completed' ? `
              <button class="app-btn app-btn--secondary" id="mtg-reopen">Reopen Meeting</button>
            ` : ''}
          </div>` : ''}
      </div>`;
  }

  function wireUpcoming() {
    const mtg = getNextMeeting();
    if (!mtg) return;

    // Link to Schedule > Assign tab
    const goAssign = document.getElementById('mtg-go-assign');
    if (goAssign) goAssign.addEventListener('click', e => { e.preventDefault(); _currentSection = 'schedule'; _scheduleTab = 'assign'; render(); });

    // Agenda checkboxes
    appEl.querySelectorAll('[data-item]').forEach(cb => {
      cb.addEventListener('change', () => toggleAgendaItem(cb.dataset.meeting, cb.dataset.item));
    });

    // Remove agenda items
    appEl.querySelectorAll('[data-remove-agenda]').forEach(btn => {
      btn.addEventListener('click', () => removeAgendaItem(btn.dataset.meeting, btn.dataset.removeAgenda));
    });

    // Add agenda item
    const addAgendaBtn = document.getElementById('mtg-agenda-add');
    if (addAgendaBtn) {
      addAgendaBtn.addEventListener('click', () => {
        const text = document.getElementById('mtg-agenda-text').value.trim();
        const type = document.getElementById('mtg-agenda-type').value;
        if (!text) return;
        addAgendaItem(mtg.id, text, type);
        document.getElementById('mtg-agenda-text').value = '';
      });
      const input = document.getElementById('mtg-agenda-text');
      if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') addAgendaBtn.click(); });
    }

    // Action item checkboxes
    appEl.querySelectorAll('[data-action]').forEach(cb => {
      cb.addEventListener('change', () => toggleActionItem(cb.dataset.meeting, cb.dataset.action));
    });

    // Remove action items
    appEl.querySelectorAll('[data-remove-action]').forEach(btn => {
      btn.addEventListener('click', () => removeActionItem(btn.dataset.meeting, btn.dataset.removeAction));
    });

    // Add action item
    const addActionBtn = document.getElementById('mtg-action-add');
    if (addActionBtn) {
      addActionBtn.addEventListener('click', () => {
        const text = document.getElementById('mtg-action-text').value.trim();
        const assignee = document.getElementById('mtg-action-assignee').value;
        const deadline = document.getElementById('mtg-action-deadline').value;
        if (!text) return;
        addActionItem(mtg.id, text, assignee, deadline);
        document.getElementById('mtg-action-text').value = '';
        document.getElementById('mtg-action-assignee').value = '';
        document.getElementById('mtg-action-deadline').value = '';
      });
      const input = document.getElementById('mtg-action-text');
      if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') addActionBtn.click(); });
    }

    // Save notes
    const saveNotesBtn = document.getElementById('mtg-save-notes');
    if (saveNotesBtn) {
      saveNotesBtn.addEventListener('click', () => {
        updateMeeting(mtg.id, { notes: document.getElementById('mtg-notes').value });
        toast('Notes saved');
      });
    }

    // Edit presentation details
    const editPresBtn = document.getElementById('mtg-edit-pres');
    if (editPresBtn) editPresBtn.addEventListener('click', () => showPresModal(mtg));

    // Remove presentation links
    appEl.querySelectorAll('[data-link-idx]').forEach(btn => {
      btn.addEventListener('click', () => removePresentationLink(btn.dataset.meeting, parseInt(btn.dataset.linkIdx)));
    });

    // Feedback chips
    appEl.querySelectorAll('[data-feedback]').forEach(btn => {
      btn.addEventListener('click', () => addFeedback(btn.dataset.meeting, btn.dataset.feedback, ''));
    });

    // Complete meeting
    const completeBtn = document.getElementById('mtg-complete');
    if (completeBtn) {
      completeBtn.addEventListener('click', () => {
        updateMeeting(mtg.id, { status: 'completed' });
        toast('Meeting marked as completed');
      });
    }

    // Postpone meeting
    const postponeBtn = document.getElementById('mtg-postpone');
    if (postponeBtn) postponeBtn.addEventListener('click', () => showPostponeModal(mtg));

    // Cancel meeting
    const cancelBtn = document.getElementById('mtg-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (confirm('Cancel this meeting?')) {
          updateMeeting(mtg.id, { status: 'cancelled' });
          toast('Meeting cancelled');
        }
      });
    }

    // Reopen completed meeting
    const reopenBtn = document.getElementById('mtg-reopen');
    if (reopenBtn) {
      reopenBtn.addEventListener('click', () => {
        updateMeeting(mtg.id, { status: 'upcoming' });
        toast('Meeting reopened');
      });
    }
  }

  /* ─── Presentation Edit Modal ────────────────────────── */
  function showPresModal(mtg) {
    const existingFiles = (mtg.presentationLinks || []);
    const overlay = document.createElement('div');
    overlay.className = 'mtg-modal-overlay';
    overlay.innerHTML = `
      <div class="mtg-modal">
        <h3>Edit Presentation</h3>
        <label class="app-label">Title</label>
        <input class="app-input" id="mtg-modal-title" type="text" value="${escHTML(mtg.presentationTitle || '')}" placeholder="Presentation title..." />
        <label class="app-label">Notes / Abstract</label>
        <textarea class="app-input" id="mtg-modal-notes" rows="4" placeholder="Brief description...">${escHTML(mtg.presentationNotes || '')}</textarea>

        <label class="app-label" style="margin-top:1rem">Files & Links</label>
        <div class="mtg-modal-files" id="mtg-modal-files">
          ${existingFiles.map((f, i) => `
            <div class="mtg-modal-file-row">
              ${f.isUpload ? fileIcon() : linkIcon()}
              <a href="${escHTML(f.url)}" target="_blank" rel="noopener">${escHTML(f.label || f.name)}</a>
              ${f.size ? `<span class="mtg-muted">(${formatFileSize(f.size)})</span>` : ''}
              <button class="mtg-card-remove" data-remove-link="${i}">&times;</button>
            </div>
          `).join('')}
          ${!existingFiles.length ? '<div class="mtg-muted">No files or links yet</div>' : ''}
        </div>

        <div class="mtg-upload-zone" id="mtg-upload-zone">
          <div class="mtg-upload-label">${uploadIcon()} Drop files here or <button class="mtg-upload-browse" id="mtg-upload-browse">browse</button></div>
          <input type="file" id="mtg-upload-input" style="display:none" multiple />
          <div class="mtg-upload-status" id="mtg-upload-status"></div>
        </div>

        <label class="app-label" style="margin-top:.75rem">Add Link</label>
        <div style="display:flex;gap:.5rem;">
          <input class="app-input" id="mtg-modal-link-label" type="text" placeholder="Label (e.g. Slides)" style="flex:1" />
          <input class="app-input" id="mtg-modal-link-url" type="url" placeholder="URL" style="flex:2" />
          <button class="app-btn app-btn--secondary mtg-btn-sm" id="mtg-modal-add-link">Add</button>
        </div>

        <div style="display:flex;gap:.5rem;margin-top:1rem;">
          <button class="app-btn app-btn--primary" id="mtg-modal-save">Save</button>
          <button class="app-btn app-btn--secondary" id="mtg-modal-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Save title & notes
    overlay.querySelector('#mtg-modal-save').addEventListener('click', async () => {
      await updateMeeting(mtg.id, {
        presentationTitle: overlay.querySelector('#mtg-modal-title').value.trim(),
        presentationNotes: overlay.querySelector('#mtg-modal-notes').value.trim()
      });
      overlay.remove();
      toast('Presentation updated');
    });

    // Add URL link
    overlay.querySelector('#mtg-modal-add-link').addEventListener('click', async () => {
      const label = overlay.querySelector('#mtg-modal-link-label').value.trim();
      const url = overlay.querySelector('#mtg-modal-link-url').value.trim();
      if (!label || !url) return;
      await addPresentationLink(mtg.id, label, url);
      overlay.querySelector('#mtg-modal-link-label').value = '';
      overlay.querySelector('#mtg-modal-link-url').value = '';
      // Refresh file list in modal
      refreshModalFiles(overlay, mtg.id);
    });

    // Remove file/link buttons
    overlay.querySelectorAll('[data-remove-link]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await removePresentationLink(mtg.id, parseInt(btn.dataset.removeLink));
        refreshModalFiles(overlay, mtg.id);
      });
    });

    // File upload — browse button
    const browseBtn = overlay.querySelector('#mtg-upload-browse');
    const fileInput = overlay.querySelector('#mtg-upload-input');
    if (browseBtn && fileInput) {
      browseBtn.addEventListener('click', e => { e.preventDefault(); fileInput.click(); });
      fileInput.addEventListener('change', () => handleModalUpload(overlay, mtg, fileInput.files));
    }

    // File upload — drag and drop
    const zone = overlay.querySelector('#mtg-upload-zone');
    if (zone) {
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('mtg-upload-active'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('mtg-upload-active'));
      zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('mtg-upload-active');
        if (e.dataTransfer.files.length) handleModalUpload(overlay, mtg, e.dataTransfer.files);
      });
    }

    // Close
    overlay.querySelector('#mtg-modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  async function handleModalUpload(overlay, mtg, files) {
    const status = overlay.querySelector('#mtg-upload-status');
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      status.textContent = `Uploading ${file.name}...`;
      const info = await uploadFile(file, mtg.date);
      if (info) {
        await addPresentationFile(mtg.id, info);
      }
    }
    status.textContent = '';
    refreshModalFiles(overlay, mtg.id);
  }

  function refreshModalFiles(overlay, meetingId) {
    const mtg = _meetings.find(m => m.id === meetingId);
    if (!mtg) return;
    const container = overlay.querySelector('#mtg-modal-files');
    if (!container) return;
    const files = mtg.presentationLinks || [];
    container.innerHTML = files.length ? files.map((f, i) => `
      <div class="mtg-modal-file-row">
        ${f.isUpload ? fileIcon() : linkIcon()}
        <a href="${escHTML(f.url)}" target="_blank" rel="noopener">${escHTML(f.label || f.name)}</a>
        ${f.size ? `<span class="mtg-muted">(${formatFileSize(f.size)})</span>` : ''}
        <button class="mtg-card-remove" data-remove-link="${i}">&times;</button>
      </div>
    `).join('') : '<div class="mtg-muted">No files or links yet</div>';
    // Re-wire remove buttons
    container.querySelectorAll('[data-remove-link]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await removePresentationLink(meetingId, parseInt(btn.dataset.removeLink));
        refreshModalFiles(overlay, meetingId);
      });
    });
  }

  /* ─── Feedback Helpers ───────────────────────────────── */
  function feedbackLabel(type) {
    switch (type) {
      case 'interesting': return 'Interesting';
      case 'question':    return 'I have questions';
      case 'collaborate': return 'Want to collaborate';
      case 'relevant':    return 'Relevant to my work';
      default:            return type;
    }
  }

  function feedbackSummaryHTML(mtg) {
    const fb = mtg.feedback || [];
    if (!fb.length) return '<span class="mtg-muted">No reactions yet</span>';
    const counts = {};
    fb.forEach(f => { counts[f.type] = (counts[f.type] || 0) + 1; });
    const collabs = fb.filter(f => f.type === 'collaborate');
    return `
      <div class="mtg-fb-counts">
        ${Object.entries(counts).map(([type, count]) =>
          `<span class="mtg-fb-tag mtg-fb-tag--${type}">${feedbackLabel(type)} (${count})</span>`
        ).join('')}
      </div>
      ${collabs.length ? `<div class="mtg-fb-collabs">${collabs.map(c => escHTML(c.name)).join(', ')} want${collabs.length === 1 ? 's' : ''} to collaborate</div>` : ''}`;
  }

  /* ═══════════════════════════════════════════════════════════
     2. SCHEDULE VIEW — two tabs: Overview + Assign Presenters
     ═══════════════════════════════════════════════════════════ */
  function renderSchedule() {
    const showAssign = isMeetingAdmin();

    return `
      <div class="mtg-schedule">
        <h2 class="mtg-page-title">Meeting Schedule</h2>

        ${showAssign ? `
          <div class="mtg-tabs">
            <button class="mtg-tab ${_scheduleTab === 'overview' ? 'mtg-tab--active' : ''}" data-sched-tab="overview">Schedule</button>
            <button class="mtg-tab ${_scheduleTab === 'assign' ? 'mtg-tab--active' : ''}" data-sched-tab="assign">Assign Presenters</button>
          </div>` : ''}

        <div id="mtg-sched-content">
          ${_scheduleTab === 'assign' && showAssign ? renderAssignTab() : renderOverviewTab()}
        </div>
      </div>`;
  }

  function renderOverviewTab() {
    const today = todayStr();
    // Hide completed meetings — show upcoming and cancelled only
    const visibleMeetings = _meetings.filter(m => m.status !== 'completed');

    return `
      <div class="app-card mtg-section">
        <div class="mtg-section-title">${calendarIcon()} Upcoming Meetings</div>
        ${visibleMeetings.length ? `
          <div class="mtg-schedule-list">
            ${visibleMeetings.map(m => {
              return `
                <div class="mtg-schedule-row ${m.date === today ? 'mtg-today' : ''} ${m.status === 'cancelled' ? 'mtg-past' : ''}">
                  <span class="mtg-sched-date">${fmtDateShort(m.date)}</span>
                  <span class="mtg-sched-presenter">${escHTML(presenterNames(m))}</span>
                  ${m.presentationTitle ? `<span class="mtg-sched-title">${escHTML(m.presentationTitle)}</span>` : ''}
                  ${m.status === 'cancelled' ? '<span class="mtg-sched-status app-badge app-badge--soon">cancelled</span>' : ''}
                  ${isMeetingAdmin() && m.status === 'upcoming' ? `<button class="app-btn app-btn--secondary mtg-btn-xs" data-postpone-meeting="${m.id}">Postpone</button>` : ''}
                  ${isMeetingAdmin() ? `<button class="mtg-remove-btn" data-delete-meeting="${m.id}" title="Delete">&times;</button>` : ''}
                </div>`;
            }).join('')}
          </div>` : '<div class="app-empty"><p>No upcoming meetings scheduled.</p></div>'}
      </div>`;
  }

  function renderAssignTab() {
    const today = todayStr();
    const upcoming = _meetings.filter(m => m.status === 'upcoming' && m.date >= today);

    return `
      <div class="mtg-assign-layout">
        <!-- Meeting slots (draggable rows for reorder) -->
        <div class="mtg-assign-meetings" id="mtg-assign-meetings">
          ${upcoming.length ? upcoming.map(m => {
            const pres = getPresenters(m);
            return `
              <div class="mtg-assign-row" draggable="true" data-assign-meeting="${m.id}">
                <span class="mtg-assign-handle" title="Drag to reorder">&#9776;</span>
                <div class="mtg-assign-date">${fmtDateShort(m.date)}</div>
                <div class="mtg-assign-slots">
                  <div class="mtg-assign-slot" data-drop-meeting="${m.id}" data-drop-slot="0">
                    ${pres[0] ? `<div class="mtg-pres-card" draggable="true" data-card-uid="${pres[0].uid}" data-card-from="${m.id}" data-card-slot="0">${escHTML(pres[0].name || memberName(pres[0].uid))}<button class="mtg-card-remove" data-unassign-meeting="${m.id}" data-unassign-slot="0">&times;</button></div>` : '<span class="mtg-slot-empty">Drop presenter here</span>'}
                  </div>
                  <div class="mtg-assign-slot" data-drop-meeting="${m.id}" data-drop-slot="1">
                    ${pres[1] ? `<div class="mtg-pres-card" draggable="true" data-card-uid="${pres[1].uid}" data-card-from="${m.id}" data-card-slot="1">${escHTML(pres[1].name || memberName(pres[1].uid))}<button class="mtg-card-remove" data-unassign-meeting="${m.id}" data-unassign-slot="1">&times;</button></div>` : '<span class="mtg-slot-empty">+ optional</span>'}
                  </div>
                </div>
                <button class="mtg-remove-btn" data-delete-meeting="${m.id}" title="Delete">&times;</button>
              </div>`;
          }).join('') : '<div class="app-empty"><p>No upcoming meetings to assign.</p></div>'}
        </div>

        <!-- Member pool — always shows all members (can assign same person multiple times) -->
        <div class="mtg-assign-pool">
          <div class="mtg-section-title">${presenterIcon()} Lab Members</div>
          <div class="mtg-pool-cards" id="mtg-pool-cards" data-drop-meeting="pool">
            ${_labMembers.map(u => `
              <div class="mtg-pres-card mtg-pool-card" draggable="true" data-card-uid="${u.uid}" data-card-from="pool">
                ${escHTML(u.name || u.email)}
              </div>
            `).join('')}
          </div>
        </div>
      </div>`;
  }

  function wireSchedule() {
    // Tab switching
    appEl.querySelectorAll('[data-sched-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        _scheduleTab = btn.dataset.schedTab;
        renderMain();
      });
    });

    // Delete meeting buttons (both tabs)
    appEl.querySelectorAll('[data-delete-meeting]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm('Delete this meeting?')) deleteMeeting(btn.dataset.deleteMeeting);
      });
    });

    // Postpone buttons (overview tab)
    appEl.querySelectorAll('[data-postpone-meeting]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mtg = _meetings.find(m => m.id === btn.dataset.postponeMeeting);
        if (mtg) showPostponeModal(mtg);
      });
    });

    if (_scheduleTab === 'assign') {
      wireAssignDrag();
      wireRowReorder();
      appEl.querySelectorAll('[data-unassign-meeting]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          assignPresenter(btn.dataset.unassignMeeting, parseInt(btn.dataset.unassignSlot), '');
        });
      });
    }
  }

  /** Drag presenter cards into meeting slots */
  function wireAssignDrag() {
    let dragUid = null;
    let dragFromMeeting = null;
    let dragFromSlot = null;

    appEl.querySelectorAll('.mtg-pres-card[draggable]').forEach(card => {
      card.addEventListener('dragstart', e => {
        // Don't let row drag fire — only card drag
        e.stopPropagation();
        dragUid = card.dataset.cardUid;
        dragFromMeeting = card.dataset.cardFrom;
        dragFromSlot = card.dataset.cardSlot !== undefined ? parseInt(card.dataset.cardSlot) : null;
        card.classList.add('mtg-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'card');
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('mtg-dragging');
        dragUid = null;
      });
    });

    // Drop zones: meeting slots
    appEl.querySelectorAll('.mtg-assign-slot').forEach(slot => {
      slot.addEventListener('dragover', e => {
        if (!dragUid) return; // only accept card drags
        e.preventDefault();
        slot.classList.add('mtg-drop-over');
      });
      slot.addEventListener('dragleave', () => slot.classList.remove('mtg-drop-over'));
      slot.addEventListener('drop', async e => {
        e.preventDefault();
        slot.classList.remove('mtg-drop-over');
        if (!dragUid) return;
        const targetMeeting = slot.dataset.dropMeeting;
        const targetSlot = parseInt(slot.dataset.dropSlot);

        // If dragging from a meeting slot, remove from source first
        if (dragFromMeeting && dragFromMeeting !== 'pool') {
          await assignPresenter(dragFromMeeting, dragFromSlot, '');
        }

        await assignPresenter(targetMeeting, targetSlot, dragUid);
        dragUid = null;
      });
    });

    // Drop on pool = unassign
    const poolEl = document.getElementById('mtg-pool-cards');
    if (poolEl) {
      poolEl.addEventListener('dragover', e => {
        if (!dragUid || dragFromMeeting === 'pool') return;
        e.preventDefault();
        poolEl.classList.add('mtg-drop-over');
      });
      poolEl.addEventListener('dragleave', () => poolEl.classList.remove('mtg-drop-over'));
      poolEl.addEventListener('drop', async e => {
        e.preventDefault();
        poolEl.classList.remove('mtg-drop-over');
        if (!dragUid || !dragFromMeeting || dragFromMeeting === 'pool') return;
        await assignPresenter(dragFromMeeting, dragFromSlot, '');
        dragUid = null;
      });
    }
  }

  /** Drag meeting rows to reorder (swap dates) */
  function wireRowReorder() {
    const container = document.getElementById('mtg-assign-meetings');
    if (!container) return;
    let dragRow = null;

    container.querySelectorAll('.mtg-assign-row').forEach(row => {
      // Only start row drag from the handle
      row.querySelector('.mtg-assign-handle')?.addEventListener('mousedown', () => { row.draggable = true; });
      row.addEventListener('dragstart', e => {
        if (!e.dataTransfer.getData('text/plain')) { // not a card drag
          dragRow = row;
          row.classList.add('mtg-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', 'row');
        }
      });
      row.addEventListener('dragend', () => {
        if (dragRow) { dragRow.classList.remove('mtg-dragging'); dragRow = null; }
        row.draggable = false;
      });
      row.addEventListener('dragover', e => {
        if (!dragRow || dragRow === row) return;
        e.preventDefault();
        const rect = row.getBoundingClientRect();
        if (e.clientY > rect.top + rect.height / 2) row.after(dragRow);
        else row.before(dragRow);
      });
    });

    // On drop, save the new date ordering by swapping dates
    container.addEventListener('dragend', async () => {
      const rows = Array.from(container.querySelectorAll('.mtg-assign-row'));
      const meetingIds = rows.map(r => r.dataset.assignMeeting);
      // Collect original dates in their original order
      const originalDates = meetingIds.map(id => {
        const m = _meetings.find(x => x.id === id);
        return m ? m.date : '';
      });
      // The visual order is now the desired order, but dates should stay in chronological slots
      // So swap presenter assignments to match the new visual order
      const sortedDates = [...originalDates].sort();
      const updates = [];
      meetingIds.forEach((id, i) => {
        const m = _meetings.find(x => x.id === id);
        if (m && m.date !== sortedDates[i]) {
          updates.push(updateMeeting(id, { date: sortedDates[i] }));
        }
      });
      if (updates.length) {
        await Promise.all(updates);
        toast('Meeting order updated');
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════
     3. ARCHIVE VIEW
     ═══════════════════════════════════════════════════════════ */
  function renderArchive() {
    let past = _meetings.filter(m => m.status === 'completed').reverse();

    if (_archiveSearch) {
      const q = _archiveSearch.toLowerCase();
      past = past.filter(m =>
        presenterNames(m).toLowerCase().includes(q) ||
        (m.presentationTitle || '').toLowerCase().includes(q) ||
        (m.notes || '').toLowerCase().includes(q)
      );
    }

    if (_archivePresenter) {
      past = past.filter(m => getPresenters(m).some(p => p.uid === _archivePresenter));
    }

    // Unique presenters for filter
    const presenters = [];
    const seen = new Set();
    _meetings.filter(m => m.status === 'completed').forEach(m => {
      getPresenters(m).forEach(p => {
        if (!seen.has(p.uid)) { seen.add(p.uid); presenters.push(p); }
      });
    });

    return `
      <div class="mtg-archive">
        <h2 class="mtg-page-title">Meeting Archive</h2>

        <div class="mtg-archive-filters">
          <input class="app-input mtg-input-sm" id="mtg-archive-search" type="text" placeholder="Search notes, titles, presenters..." value="${escHTML(_archiveSearch)}" />
          <select class="app-input mtg-select-sm" id="mtg-archive-presenter">
            <option value="">All presenters</option>
            ${presenters.map(p => `<option value="${p.uid}" ${_archivePresenter === p.uid ? 'selected' : ''}>${escHTML(p.name)}</option>`).join('')}
          </select>
        </div>

        ${past.length ? past.map(m => `
          <div class="app-card mtg-archive-card ${_archiveExpanded === m.id ? 'mtg-expanded' : ''}">
            <div class="mtg-archive-header" data-toggle-archive="${m.id}">
              <div class="mtg-archive-left">
                <span class="mtg-archive-date">${fmtDate(m.date)}</span>
                <strong>${escHTML(presenterNames(m))}</strong>
                ${m.presentationTitle ? ` &mdash; <em>${escHTML(m.presentationTitle)}</em>` : ''}
              </div>
              <div class="mtg-archive-right">
                ${(m.feedback || []).length ? `<span class="mtg-fb-count">${(m.feedback || []).length} reactions</span>` : ''}
                <span class="mtg-expand-icon">${_archiveExpanded === m.id ? '&#9650;' : '&#9660;'}</span>
              </div>
            </div>
            ${_archiveExpanded === m.id ? `
              <div class="mtg-archive-body">
                ${(m.presentationLinks || []).length ? `
                  <div class="mtg-section-sub">
                    <strong>Materials:</strong>
                    <div class="mtg-pres-links">
                    ${m.presentationLinks.map(lnk => lnk.isUpload
                      ? `<div class="mtg-file-card">${lnk.isImage ? '' : fileIcon()}<a href="${escHTML(lnk.url)}" target="_blank" rel="noopener" class="mtg-file-name">${escHTML(lnk.name)}</a><span class="mtg-muted">${formatFileSize(lnk.size)}</span></div>`
                      : `<a href="${escHTML(lnk.url)}" target="_blank" rel="noopener" class="mtg-link-chip">${linkIcon()} ${escHTML(lnk.label)}</a>`
                    ).join('')}
                    </div>
                  </div>` : ''}
                ${(m.agendaItems || []).length ? `
                  <div class="mtg-section-sub">
                    <strong>Agenda:</strong>
                    <ul class="mtg-archive-list">${m.agendaItems.map(a => `<li class="${a.done ? 'mtg-done' : ''}">${escHTML(a.text)} <span class="mtg-muted">(${a.type})</span></li>`).join('')}</ul>
                  </div>` : ''}
                ${m.notes ? `
                  <div class="mtg-section-sub">
                    <strong>Notes:</strong>
                    <div class="mtg-archive-notes">${escHTML(m.notes)}</div>
                  </div>` : ''}
                ${(m.actionItems || []).length ? `
                  <div class="mtg-section-sub">
                    <strong>Action Items:</strong>
                    <ul class="mtg-archive-list">${m.actionItems.map(a => `<li class="${a.status === 'done' ? 'mtg-done' : ''}"><span>${escHTML(a.text)}</span> &mdash; ${escHTML(a.assigneeName)} ${a.deadline ? `(due ${fmtDateShort(a.deadline)})` : ''} ${a.status === 'done' ? '&#10003;' : ''}</li>`).join('')}</ul>
                  </div>` : ''}
                ${(m.feedback || []).length ? `
                  <div class="mtg-section-sub">
                    <strong>Reactions:</strong>
                    ${feedbackSummaryHTML(m)}
                  </div>` : ''}
                ${!isUserPresenter(m) ? `
                  <div class="mtg-feedback-chips mtg-archive-feedback">
                    ${['interesting', 'question', 'collaborate', 'relevant'].map(type => {
                      const active = (m.feedback || []).some(f => f.uid === _user.uid && f.type === type);
                      return `<button class="mtg-feedback-chip ${active ? 'mtg-feedback-chip--active' : ''}" data-meeting="${m.id}" data-feedback="${type}">${feedbackLabel(type)}</button>`;
                    }).join('')}
                  </div>` : ''}
              </div>` : ''}
          </div>
        `).join('') : '<div class="app-empty"><p>No completed meetings yet.</p></div>'}
      </div>`;
  }

  function wireArchive() {
    const searchEl = document.getElementById('mtg-archive-search');
    if (searchEl) {
      let debounce;
      searchEl.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { _archiveSearch = searchEl.value; renderMain(); }, 300);
      });
    }

    const presEl = document.getElementById('mtg-archive-presenter');
    if (presEl) presEl.addEventListener('change', () => { _archivePresenter = presEl.value; renderMain(); });

    appEl.querySelectorAll('[data-toggle-archive]').forEach(el => {
      el.addEventListener('click', () => {
        _archiveExpanded = _archiveExpanded === el.dataset.toggleArchive ? null : el.dataset.toggleArchive;
        renderMain();
      });
    });

    appEl.querySelectorAll('[data-feedback]').forEach(btn => {
      btn.addEventListener('click', () => addFeedback(btn.dataset.meeting, btn.dataset.feedback, ''));
    });
  }

  /* ═══════════════════════════════════════════════════════════
     4. MY ITEMS VIEW
     ═══════════════════════════════════════════════════════════ */
  function renderMyItems() {
    let items = [];
    _meetings.forEach(m => {
      (m.actionItems || []).forEach(ai => {
        if (ai.assigneeUid === _user.uid) {
          items.push({ ...ai, meetingId: m.id, meetingDate: m.date });
        }
      });
    });

    if (!_myItemsShowAll) items = items.filter(i => i.status === 'open');

    items.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
      if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return a.meetingDate.localeCompare(b.meetingDate);
    });

    return `
      <div class="mtg-myitems">
        <h2 class="mtg-page-title">My Action Items</h2>
        <div class="mtg-myitems-toggle">
          <label class="mtg-toggle-label">
            <input type="checkbox" id="mtg-show-all" ${_myItemsShowAll ? 'checked' : ''} />
            Show completed items
          </label>
        </div>
        ${items.length ? `
          <div class="mtg-myitems-list">
            ${items.map(ai => `
              <div class="app-card mtg-myitem ${ai.status === 'done' ? 'mtg-action-done' : ''}">
                <label class="mtg-action-check">
                  <input type="checkbox" data-meeting="${ai.meetingId}" data-action="${ai.id}" ${ai.status === 'done' ? 'checked' : ''} />
                  <span class="${ai.status === 'done' ? 'mtg-done' : ''}">${escHTML(ai.text)}</span>
                </label>
                <div class="mtg-myitem-meta">
                  <span class="mtg-muted">From ${fmtDateShort(ai.meetingDate)} meeting</span>
                  ${ai.deadline ? `<span class="mtg-action-deadline ${ai.deadline < todayStr() && ai.status === 'open' ? 'mtg-overdue' : ''}">Due ${fmtDateShort(ai.deadline)}</span>` : ''}
                </div>
              </div>
            `).join('')}
          </div>` : `
          <div class="app-empty">
            <p>${_myItemsShowAll ? 'No action items assigned to you.' : 'No open action items. Nice!'}</p>
          </div>`}
      </div>`;
  }

  function wireMyItems() {
    const toggle = document.getElementById('mtg-show-all');
    if (toggle) toggle.addEventListener('change', () => { _myItemsShowAll = toggle.checked; renderMain(); });

    appEl.querySelectorAll('[data-action]').forEach(cb => {
      cb.addEventListener('change', () => toggleActionItem(cb.dataset.meeting, cb.dataset.action));
    });
  }

  /* ═══════════════════════════════════════════════════════════
     5. SETTINGS VIEW — no rotation, skip weeks, calendar pickers
     ═══════════════════════════════════════════════════════════ */
  function renderSettings() {
    const cfg = _config || {};

    // Non-admins see read-only
    if (!isAdmin()) {
      return `
        <div class="mtg-settings">
          <h2 class="mtg-page-title">Settings</h2>
          <div class="app-card">
            <p class="mtg-muted">Meeting settings are managed by the lab PI.</p>
            ${_config ? `
              <div class="mtg-settings-info">
                <p><strong>Meeting day:</strong> ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][cfg.defaultDay || 3]}</p>
                <p><strong>Time:</strong> ${fmtTime(cfg.defaultTime || '14:00')}</p>
                <p><strong>Duration:</strong> ${cfg.defaultDuration || 60} min</p>
                <p><strong>Location:</strong> ${escHTML(cfg.defaultLocation || 'TBD')}</p>
              </div>` : ''}
          </div>
        </div>`;
    }

    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const skipWeeks = cfg.skipWeeks || [];
    const meetingAdmins = cfg.meetingAdmins || [];

    return `
      <div class="mtg-settings">
        <h2 class="mtg-page-title">Meeting Settings</h2>

        <div class="app-card mtg-section">
          <div class="mtg-section-title">Meeting Defaults</div>
          <div class="mtg-settings-form">
            <div class="mtg-form-row">
              <label class="app-label">Day of Week</label>
              <select class="app-input" id="mtg-cfg-day">
                ${dayNames.map((name, i) => `<option value="${i}" ${(cfg.defaultDay || 3) === i ? 'selected' : ''}>${name}</option>`).join('')}
              </select>
            </div>
            <div class="mtg-form-row">
              <label class="app-label">Time</label>
              <input class="app-input" id="mtg-cfg-time" type="time" value="${cfg.defaultTime || '14:00'}" />
            </div>
            <div class="mtg-form-row">
              <label class="app-label">Duration (minutes)</label>
              <input class="app-input" id="mtg-cfg-duration" type="number" value="${cfg.defaultDuration || 60}" min="15" max="180" step="15" />
            </div>
            <div class="mtg-form-row">
              <label class="app-label">Location</label>
              <input class="app-input" id="mtg-cfg-location" type="text" value="${escHTML(cfg.defaultLocation || '')}" placeholder="Room number or Zoom link" />
            </div>
          </div>
        </div>

        <div class="app-card mtg-section">
          <div class="mtg-section-title">Semester Dates</div>
          <div class="mtg-settings-form">
            <div class="mtg-form-row">
              <label class="app-label">Semester Start</label>
              <input class="app-input mtg-cal-input" id="mtg-cfg-start" type="text" value="${cfg.semesterStart || ''}" placeholder="Click to pick" readonly />
            </div>
            <div class="mtg-form-row">
              <label class="app-label">Semester End</label>
              <input class="app-input mtg-cal-input" id="mtg-cfg-end" type="text" value="${cfg.semesterEnd || ''}" placeholder="Click to pick" readonly />
            </div>
          </div>
        </div>

        <div class="app-card mtg-section">
          <div class="mtg-section-title">Skip Weeks</div>
          <p class="mtg-muted" style="margin-bottom:.75rem">Weeks when no meeting should be generated (conferences, holidays, breaks).</p>
          <div class="mtg-skip-list" id="mtg-skip-list">
            ${skipWeeks.map(wk => `
              <div class="mtg-skip-row">
                <span>Week of ${fmtDate(wk)}</span>
                <button class="mtg-remove-btn" data-remove-skip="${wk}">&times;</button>
              </div>
            `).join('')}
            ${!skipWeeks.length ? '<div class="mtg-muted">No skip weeks added</div>' : ''}
          </div>
          <div class="mtg-skip-add">
            <input class="app-input mtg-input-sm mtg-cal-input" id="mtg-skip-date" type="text" placeholder="Pick a date in the week to skip" readonly />
            <button class="app-btn app-btn--secondary mtg-btn-sm" id="mtg-skip-add-btn">Add Skip Week</button>
          </div>
        </div>

        <div class="app-card mtg-section">
          <div class="mtg-section-title">${presenterIcon()} Meeting Admins</div>
          <p class="mtg-muted" style="margin-bottom:.75rem">Members with admin rights to this app (assign presenters, manage meetings, complete/postpone/cancel).</p>
          <div class="mtg-admin-list" id="mtg-admin-list">
            ${meetingAdmins.map(uid => `
              <div class="mtg-admin-row">
                <span>${escHTML(memberName(uid))}</span>
                <button class="mtg-remove-btn" data-remove-admin="${uid}">&times;</button>
              </div>
            `).join('')}
            ${!meetingAdmins.length ? '<div class="mtg-muted">No meeting admins added (only site admin has access)</div>' : ''}
          </div>
          <div class="mtg-admin-add">
            <select class="app-input mtg-select-sm" id="mtg-admin-add-member">
              <option value="">Add meeting admin...</option>
              ${_labMembers.filter(u => !meetingAdmins.includes(u.uid) && u.role !== 'admin').map(u =>
                `<option value="${u.uid}">${escHTML(u.name || u.email)}</option>`
              ).join('')}
            </select>
            <button class="app-btn app-btn--secondary mtg-btn-sm" id="mtg-admin-add-btn">Add</button>
          </div>
        </div>

        <div class="mtg-settings-actions">
          <button class="app-btn app-btn--primary" id="mtg-save-settings">Save Settings</button>
          <button class="app-btn app-btn--secondary" id="mtg-generate">Generate Meetings</button>
        </div>
      </div>`;
  }

  function wireSettings() {
    if (!isAdmin()) return;

    // Calendar pickers for semester dates
    const startInput = document.getElementById('mtg-cfg-start');
    const endInput = document.getElementById('mtg-cfg-end');
    const skipInput = document.getElementById('mtg-skip-date');
    if (startInput) startInput.addEventListener('click', () => showCalendarPicker(startInput, () => {}));
    if (endInput) endInput.addEventListener('click', () => showCalendarPicker(endInput, () => {}));
    if (skipInput) skipInput.addEventListener('click', () => showCalendarPicker(skipInput, () => {}));

    // Add skip week
    const addSkipBtn = document.getElementById('mtg-skip-add-btn');
    if (addSkipBtn) {
      addSkipBtn.addEventListener('click', () => {
        const dateVal = skipInput.value;
        if (!dateVal) { toast('Pick a date first'); return; }
        const wk = weekStart(dateVal);
        const current = (_config && _config.skipWeeks) || [];
        if (current.includes(wk)) { toast('That week is already skipped'); return; }
        const updated = [...current, wk].sort();
        saveConfig({ skipWeeks: updated });
        skipInput.value = '';
        renderMain();
      });
    }

    // Remove skip week
    appEl.querySelectorAll('[data-remove-skip]').forEach(btn => {
      btn.addEventListener('click', () => {
        const wk = btn.dataset.removeSkip;
        const updated = ((_config && _config.skipWeeks) || []).filter(w => w !== wk);
        saveConfig({ skipWeeks: updated });
        renderMain();
      });
    });

    // Add meeting admin
    const addAdminBtn = document.getElementById('mtg-admin-add-btn');
    if (addAdminBtn) {
      addAdminBtn.addEventListener('click', () => {
        const sel = document.getElementById('mtg-admin-add-member');
        const uid = sel.value;
        if (!uid) return;
        const current = (_config && _config.meetingAdmins) || [];
        saveConfig({ meetingAdmins: [...current, uid] });
        renderMain();
      });
    }

    // Remove meeting admin
    appEl.querySelectorAll('[data-remove-admin]').forEach(btn => {
      btn.addEventListener('click', () => {
        const uid = btn.dataset.removeAdmin;
        const updated = ((_config && _config.meetingAdmins) || []).filter(u => u !== uid);
        saveConfig({ meetingAdmins: updated });
        renderMain();
      });
    });

    // Save settings
    const saveBtn = document.getElementById('mtg-save-settings');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        saveConfig({
          defaultDay: parseInt(document.getElementById('mtg-cfg-day').value),
          defaultTime: document.getElementById('mtg-cfg-time').value,
          defaultDuration: parseInt(document.getElementById('mtg-cfg-duration').value),
          defaultLocation: document.getElementById('mtg-cfg-location').value.trim(),
          semesterStart: document.getElementById('mtg-cfg-start').value,
          semesterEnd: document.getElementById('mtg-cfg-end').value
        });
      });
    }

    // Generate meetings
    const genBtn = document.getElementById('mtg-generate');
    if (genBtn) {
      genBtn.addEventListener('click', async () => {
        saveBtn.click();
        await new Promise(r => setTimeout(r, 500));
        await generateMeetings();
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════
     ICONS (inline SVGs)
     ═══════════════════════════════════════════════════════════ */
  function calendarIcon() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
  }
  function listIcon() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
  }
  function archiveIcon() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';
  }
  function checkIcon() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
  }
  function settingsIcon() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  }
  function presenterIcon() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  }
  function agendaIcon() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>';
  }
  function notesIcon() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
  }
  function linkIcon() {
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  }
  function reactionIcon() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
  }
  function fileIcon() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
  }
  function uploadIcon() {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
  }
})();
