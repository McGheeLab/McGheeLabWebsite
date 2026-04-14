/* ================================================================
   Scheduler — McGheeLab Lab App
   Two tabs:
   1. My Schedule — personal calendar with layers (recurring,
      overrides, calendar imports, custom events)
   2. My Schedulers — create schedulers, add guests, manage
      sessions/freeform availability, share invite links
   ================================================================ */

(() => {
  const appEl = document.getElementById('app');
  const SS = () => McgheeLab.ScheduleService;
  const SU = () => McgheeLab.ScheduleUtils;
  const CS = () => McgheeLab.CalendarService;

  /* ─── Helpers ───────────────────────────────────────────────── */
  function esc(s) {
    const el = document.createElement('div');
    el.textContent = s ?? '';
    return el.innerHTML;
  }

  function generateKey() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function db() {
    if (typeof firebase === 'undefined') throw new Error('Firebase SDK not loaded');
    return firebase.firestore();
  }

  function lockIcon() { return '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>'; }
  function calIcon() { return '&#128197;'; }

  /* ─── ScheduleDB (Firestore operations) ─────────────────────── */
  const SDB = {
    async getSchedule(id) {
      const doc = await db().collection('schedules').doc(id).get();
      return doc.exists ? { id: doc.id, ...doc.data() } : null;
    },
    async saveSchedule(data) {
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      const id = data.id;
      const rest = Object.assign({}, data);
      delete rest.id;
      await db().collection('schedules').doc(id).set(rest, { merge: true });
      return id;
    },
    async getSpeakers(scheduleId) {
      const snap = await db().collection('participants')
        .where('scheduleId', '==', scheduleId).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async getSpeakerByKey(key) {
      const doc = await db().collection('participants').doc(key).get();
      return doc.exists ? { id: doc.id, ...doc.data() } : null;
    },
    async addSpeaker(data) {
      const key = generateKey();
      data.key = key;
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await db().collection('participants').doc(key).set(data);
      return key;
    },
    async updateSpeaker(id, data) {
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await db().collection('participants').doc(id).update(data);
    },
    async updateSpeakerByKey(key, data) {
      data.key = key;
      data.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await db().collection('participants').doc(key).update(data);
    },
    async deleteSpeaker(id) {
      await db().collection('participants').doc(id).delete();
    },
    async deleteSchedule(id) {
      const parts = await SDB.getSpeakers(id);
      for (const p of parts) await SDB.deleteSpeaker(p.id);
      await db().collection('schedules').doc(id).delete();
    }
  };

  /* ─── State ─────────────────────────────────────────────────── */
  let _user = null;
  let _profile = null;
  let _currentTab = 'myschedule';   // 'myschedule' | 'schedulers'
  let _currentView = 'list';         // 'list' | 'editor' (for schedulers tab)
  let _editingId = null;

  // My Schedule state
  let _weekOffset = 0;
  let _schedMode = 'recurring';      // 'recurring' | 'special' | 'blackout'
  let _schedZoomIdx = 5;
  let _toastTimer = null;

  /* ─── Init ──────────────────────────────────────────────────── */
  McgheeLab.AppBridge.init();
  if (McgheeLab.MobileShell) McgheeLab.MobileShell.configure({ appId: 'scheduler', title: 'Scheduler' });
  McgheeLab.AppBridge.onReady(async (user, profile) => {
    _user = user;
    _profile = profile;

    // Init shared services
    if (SS()) await SS().init(_user, _profile);
    if (CS()) await CS().init(_user, {});

    // Re-render on schedule data changes OR calendar events arriving
    if (SS()) SS().onChange(() => {
      if (_currentTab === 'myschedule') renderMyScheduleContent();
    });
    if (CS()) CS().onChange(() => {
      if (_currentTab === 'myschedule') renderMyScheduleContent();
    });

    if (McgheeLab.MobileShell?.enableTabSwipe) {
      McgheeLab.MobileShell.enableTabSwipe(
        [{ id: 'myschedule' }, { id: 'schedulers' }],
        () => _currentTab,
        (id) => { _currentTab = id; renderApp(); }
      );
    }

    renderApp();
  });

  /* ─── Resize helper (for embedded mode) ─────────────────────── */
  function notifyResize() {
    if (!McgheeLab.AppBridge.isEmbedded()) return;
    requestAnimationFrame(() => {
      const h = document.documentElement.scrollHeight;
      window.parent.postMessage({ type: 'mcgheelab-app-resize', height: h }, window.location.origin);
    });
  }

  function toast(msg) {
    const el = document.getElementById('sched-toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'sched-toast';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.className = 'sched-toast hidden'; }, 2600);
  }

  /* ─── Router ────────────────────────────────────────────────── */
  function renderApp() {
    if (!_user) return;

    // Tab bar
    const tabBar = `<div class="sched-tab-bar" id="sched-tabs">
      <button class="sched-tab${_currentTab === 'myschedule' ? ' active' : ''}" data-tab="myschedule">My Schedule</button>
      <button class="sched-tab${_currentTab === 'schedulers' ? ' active' : ''}" data-tab="schedulers">My Schedulers</button>
    </div>`;

    appEl.innerHTML = `${tabBar}
      <div id="sched-tab-content"></div>
      <div class="sched-toast hidden" id="sched-toast"></div>`;

    // Wire tab clicks
    appEl.querySelectorAll('.sched-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        _currentTab = btn.dataset.tab;
        renderApp();
      });
    });

    // Render active tab
    const content = document.getElementById('sched-tab-content');
    if (_currentTab === 'myschedule') {
      renderMyScheduleTab(content);
    } else {
      renderSchedulersTab(content);
    }
  }

  function navigate(view, id) {
    _currentView = view;
    _editingId = id || null;
    renderApp();
  }

  /* ================================================================
     MY SCHEDULE TAB — layered calendar view
     ================================================================ */

  function renderMyScheduleTab(container) {
    const s = SS();
    if (!s) {
      container.innerHTML = '<p class="empty-state">Schedule service not loaded.</p>';
      return;
    }

    container.innerHTML = renderMyScheduleHTML();
    wireMySchedule();
  }

  function renderMyScheduleContent() {
    const content = document.getElementById('sched-tab-content');
    if (!content || _currentTab !== 'myschedule') return;
    content.innerHTML = renderMyScheduleHTML();
    wireMySchedule();
  }

  function renderMyScheduleHTML() {
    const s = SS();
    const su = SU();
    if (!s || !su) return '';

    const days = su.getWeekDays(_weekOffset);
    const bounds = { startHour: 0, endHour: 24 };
    const slots = su.timeLabels(bounds.startHour, bounds.endHour);
    const slotH = su.ZOOM_LEVELS[_schedZoomIdx];
    const totalRows = slots.length;
    const today = su.todayStr();
    const layerCfg = s.getLayerConfig();

    // Week label
    const weekLabel = su.getWeekLabel(_weekOffset);

    // Day headers
    const dayHeaders = days.map((d, i) => {
      const isToday = d.date === today;
      const dayNum = parseInt(d.date.split('-')[2], 10);
      return `<div class="ms-grid-day-header ms-sticky-head ${isToday ? 'ms-today' : ''}" style="grid-column:${i + 2}; grid-row:1;">${d.dayShort}<span class="ms-grid-daynum">${dayNum}</span></div>`;
    }).join('');

    // Time labels
    const timeSlots = slots.map((sl, si) => {
      const isHalf = sl.time.endsWith(':30');
      if (isHalf) return `<div class="ms-grid-time-label--half" style="grid-column:1; grid-row:${si + 2};"></div>`;
      return `<div class="ms-grid-time-label" style="grid-column:1; grid-row:${si + 2};">${sl.label}</div>`;
    }).join('');

    // Empty cells for drag targets
    let cellsHTML = '';
    for (let di = 0; di < days.length; di++) {
      for (let si = 0; si < totalRows; si++) {
        cellsHTML += `<div class="ms-cell" data-day="${di}" data-slot="${si}" data-date="${days[di].date}" style="grid-column:${di + 2}; grid-row:${si + 2};"></div>`;
      }
    }

    // Render blocks from all layers
    let blocksHTML = '';
    for (let di = 0; di < days.length; di++) {
      const dateStr = days[di].date;
      const blocks = s.resolveScheduleForUser(_user.uid, dateStr);

      // Also get calendar events as visible layer (separate from blackout injection)
      const calEvents = (layerCfg.calendar && CS()) ? CS().getEventsForDate(dateStr) : [];

      for (const block of blocks) {
        // Filter by layer visibility
        if (block.source === 'template' && !layerCfg.recurring) continue;
        if (block.source === 'override' && !layerCfg.overrides) continue;
        if (block.source === 'custom' && !layerCfg.custom) continue;
        if (block.source === 'calendar' && !layerCfg.calendar) continue;

        const startSlot = su.timeToSlot(block.startTime, bounds.startHour);
        const endSlot = su.timeToSlot(block.endTime, bounds.startHour);
        if (startSlot < 0 || endSlot <= startSlot) continue;
        const span = endSlot - startSlot;

        const isUnavail = block.type === 'unavailable';
        const isCal = block.source === 'calendar';
        const isCustom = block.source === 'custom';
        const isBusyAvail = isCal && block.calStatus === 'busy-available';

        // Calendar events: purple when unavailable, muted green when busy-available
        const color = isCustom ? (block.color || '#a78bfa')
          : isCal ? (isBusyAvail ? '#16a34a' : '#9333ea')
          : s.MODE_COLORS[block.mode] || (isUnavail ? '#ef4444' : '#22c55e');

        const rigidClass = isUnavail && block.rigidity === 'rigid' ? ' ms-block--rigid' : '';
        const flexClass = isUnavail && block.rigidity === 'flexible' ? ' ms-block--flexible' : '';
        const calClass = isCal ? ' ms-block--calendar' : '';
        const customClass = isCustom ? ' ms-block--custom' : '';
        const busyAvailClass = isBusyAvail ? ' ms-block--busy-available' : '';

        const label = isCal ? (block.title || 'Calendar')
          : isCustom ? (block.title || 'Event')
          : isUnavail ? (block.reason || 'Busy') : 'Available';

        const calStatusLabel = isCal ? (isBusyAvail ? 'Busy but Available' : 'Unavailable') : '';
        const modeTag = !isCal && !isCustom ? (s.MODE_LABELS[block.mode] || '') : '';
        const rawEventId = block.id.replace('cal_', '');

        blocksHTML += `<div class="ms-block${rigidClass}${flexClass}${calClass}${customClass}${busyAvailClass}" data-block-id="${block.id}" data-date="${dateStr}" data-source="${block.source || ''}" data-cal-status="${block.calStatus || ''}" style="grid-column:${di + 2}; grid-row:${startSlot + 2}/span ${span}; border-left-color:${color}; background:${color}${isBusyAvail ? '33' : '22'}; color:${color};">
          <span class="ms-block-label">${isCal ? calIcon() + ' ' : ''}${isUnavail && block.rigidity === 'rigid' && !isCal ? lockIcon() + ' ' : ''}${esc(label)}</span>
          ${modeTag ? `<span class="ms-block-mode">${modeTag}</span>` : ''}
          ${isCal ? `<span class="ms-block-mode">${calStatusLabel}</span>` : ''}
          ${isCal ? `<div class="ms-block-cal-actions">
            <button class="ms-block-status-toggle" data-event-id="${rawEventId}" data-current="${block.calStatus || 'unavailable'}" title="${isBusyAvail ? 'Mark as unavailable' : 'Mark as busy but available'}">${isBusyAvail ? '&#128308;' : '&#128994;'}</button>
            <button class="ms-block-dismiss" data-dismiss-id="${rawEventId}" title="Dismiss">&times;</button>
          </div>` : ''}
        </div>`;
      }

      // Render calendar events as visible layer (those not already injected as blackout)
      if (layerCfg.calendar && CS()) {
        for (const ev of calEvents) {
          const st = su.parseCalTimeToHHMM(ev.startTime);
          const et = su.parseCalTimeToHHMM(ev.endTime);
          if (!st || !et || st >= et) continue;

          // Skip if already rendered via resolveScheduleForUser blackout injection
          const alreadyRendered = blocks.some(b => b.id === 'cal_' + ev.id);
          if (alreadyRendered) continue;

          const startSlot = su.timeToSlot(st, bounds.startHour);
          const endSlot = su.timeToSlot(et, bounds.startHour);
          if (startSlot < 0 || endSlot <= startSlot) continue;
          const span = endSlot - startSlot;

          blocksHTML += `<div class="ms-block ms-block--calendar" data-block-id="cal_${ev.id}" data-date="${dateStr}" data-source="calendar" style="grid-column:${di + 2}; grid-row:${startSlot + 2}/span ${span}; border-left-color:#9333ea; background:#9333ea22; color:#9333ea;">
            <span class="ms-block-label">${calIcon()} ${esc(ev.title || 'Calendar')}</span>
            <button class="ms-block-dismiss" data-dismiss-id="${ev.id}" title="Dismiss">&times;</button>
          </div>`;
        }
      }
    }

    // Zoom controls
    const zoomHTML = `<div class="ms-zoom-controls">
      <button class="ms-zoom-btn" id="ms-zoom-out">&minus;</button>
      <button class="ms-zoom-btn" id="ms-zoom-in">&plus;</button>
    </div>`;

    // Mode selector
    const modeSelector = `<div class="ms-mode-selector">
      <button class="ms-mode-btn${_schedMode === 'recurring' ? ' active' : ''}" data-mode="recurring" style="--mode-color:#22c55e">
        <span class="ms-mode-dot" style="background:#22c55e"></span> General Availability
      </button>
      <button class="ms-mode-btn${_schedMode === 'special' ? ' active' : ''}" data-mode="special" style="--mode-color:#3b82f6">
        <span class="ms-mode-dot" style="background:#3b82f6"></span> Special Availability
      </button>
      <button class="ms-mode-btn${_schedMode === 'blackout' ? ' active' : ''}" data-mode="blackout" style="--mode-color:#ef4444">
        <span class="ms-mode-dot" style="background:#ef4444"></span> Special Unavailability
      </button>
    </div>`;

    // Layer toggles — calendar sources named by provider
    const dismissedCount = CS()?.getDismissedCount() || 0;
    const conn = CS()?.isConnected() || {};

    // Build dynamic calendar source labels
    let calendarLayerRows = '';
    if (conn.google) {
      calendarLayerRows += `<div class="ms-layer-row">
        <span class="ms-layer-dot" style="background:#4285f4"></span>
        <span class="ms-layer-label">Google Calendar</span>
      </div>`;
    }
    if (conn.outlook || conn.outlookIcs) {
      calendarLayerRows += `<div class="ms-layer-row">
        <span class="ms-layer-dot" style="background:#0078d4"></span>
        <span class="ms-layer-label">Outlook Calendar</span>
      </div>`;
    }
    if (conn.ics && !conn.outlookIcs) {
      calendarLayerRows += `<div class="ms-layer-row">
        <span class="ms-layer-dot" style="background:#a3aaae"></span>
        <span class="ms-layer-label">Apple / ICS Calendar</span>
      </div>`;
    }
    // If no specific providers connected, show generic label
    if (!calendarLayerRows) {
      calendarLayerRows = `<div class="ms-layer-row">
        <span class="ms-layer-dot" style="background:#9333ea"></span>
        <span class="ms-layer-label">External Calendars</span>
      </div>`;
    }

    const layerPanel = `<div class="ms-layer-panel">
      <div class="ms-layer-row">
        <span class="ms-layer-dot" style="background:#22c55e"></span>
        <span class="ms-layer-label">General Availability</span>
        <label class="ms-layer-toggle"><input type="checkbox" data-layer="recurring" ${layerCfg.recurring ? 'checked' : ''} /><span class="ms-toggle-slider"></span></label>
      </div>
      <div class="ms-layer-row">
        <span class="ms-layer-dot" style="background:#3b82f6"></span>
        <span class="ms-layer-label">Special Availability / Unavailability</span>
        <label class="ms-layer-toggle"><input type="checkbox" data-layer="overrides" ${layerCfg.overrides ? 'checked' : ''} /><span class="ms-toggle-slider"></span></label>
      </div>
      <div class="ms-layer-row ms-layer-row--group">
        ${calendarLayerRows}
        <label class="ms-layer-toggle"><input type="checkbox" data-layer="calendar" ${layerCfg.calendar ? 'checked' : ''} /><span class="ms-toggle-slider"></span></label>
      </div>
      <div class="ms-layer-row">
        <span class="ms-layer-dot" style="background:#a78bfa"></span>
        <span class="ms-layer-label">Custom Events</span>
        <label class="ms-layer-toggle"><input type="checkbox" data-layer="custom" ${layerCfg.custom ? 'checked' : ''} /><span class="ms-toggle-slider"></span></label>
      </div>
      ${dismissedCount ? `<button class="ms-restore-btn" id="ms-restore-dismissed">Restore ${dismissedCount} dismissed event${dismissedCount > 1 ? 's' : ''}</button>` : ''}
    </div>`;

    const cornerCell = `<div class="ms-grid-corner ms-sticky-head" style="grid-column:1; grid-row:1;"></div>`;

    return `<div class="ms-layout">
      <div class="ms-header">
        <div class="ms-week-nav">
          <button class="ms-nav-btn" id="ms-week-prev">&lsaquo;</button>
          <span class="ms-week-label">${weekLabel}</span>
          <button class="ms-nav-btn" id="ms-week-next">&rsaquo;</button>
          ${_weekOffset !== 0 ? '<button class="ms-nav-today" id="ms-week-today">Today</button>' : ''}
        </div>
        ${modeSelector}
        <div class="ms-toolbar">
          <button class="app-btn app-btn--secondary" id="ms-copy-mon" style="font-size:.72rem;padding:.2rem .5rem;">Copy Mon &rarr; Weekdays</button>
          <button class="app-btn app-btn--secondary" id="ms-add-custom" style="font-size:.72rem;padding:.2rem .5rem;">+ Custom Event</button>
          ${zoomHTML}
        </div>
        ${layerPanel}
        <p style="color:var(--muted);font-size:.75rem;margin:.25rem 0 0;">Select a mode, then drag to create blocks. Click blocks to edit.</p>
      </div>
      <div class="ms-body">
        <div class="ms-scroll-area">
          <div class="ms-grid-wrap" id="ms-grid-wrap" data-slot-h="${slotH}">
            <div class="ms-grid" data-mode="${_schedMode}" style="grid-template-columns:60px repeat(${days.length}, 1fr); grid-template-rows:auto repeat(${totalRows}, ${slotH}px);">
              ${cornerCell}${dayHeaders}${timeSlots}${cellsHTML}${blocksHTML}
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  function wireMySchedule() {
    const s = SS();
    const su = SU();
    if (!s || !su) return;

    const days = su.getWeekDays(_weekOffset);
    const bounds = { startHour: 0, endHour: 24 };

    // Week navigation
    document.getElementById('ms-week-prev')?.addEventListener('click', () => {
      _weekOffset--;
      s.setWeekOffset(_weekOffset);
      renderMyScheduleContent();
    });
    document.getElementById('ms-week-next')?.addEventListener('click', () => {
      _weekOffset++;
      s.setWeekOffset(_weekOffset);
      renderMyScheduleContent();
    });
    document.getElementById('ms-week-today')?.addEventListener('click', () => {
      _weekOffset = 0;
      s.setWeekOffset(0);
      renderMyScheduleContent();
    });

    // Mode selector
    appEl.querySelectorAll('.ms-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _schedMode = btn.dataset.mode;
        appEl.querySelectorAll('.ms-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === _schedMode));
        const grid = appEl.querySelector('.ms-grid');
        if (grid) grid.dataset.mode = _schedMode;
      });
    });

    // Layer toggles
    appEl.querySelectorAll('[data-layer]').forEach(cb => {
      cb.addEventListener('change', () => {
        const cfg = s.getLayerConfig();
        cfg[cb.dataset.layer] = cb.checked;
        s.saveLayerConfig(cfg);
      });
    });

    // Restore dismissed
    document.getElementById('ms-restore-dismissed')?.addEventListener('click', async () => {
      if (CS()) {
        await CS().restoreDismissed();
        renderMyScheduleContent();
        toast('Dismissed events restored');
      }
    });

    // Zoom
    document.getElementById('ms-zoom-in')?.addEventListener('click', () => {
      if (_schedZoomIdx < su.ZOOM_LEVELS.length - 1) { _schedZoomIdx++; renderMyScheduleContent(); }
    });
    document.getElementById('ms-zoom-out')?.addEventListener('click', () => {
      if (_schedZoomIdx > 0) { _schedZoomIdx--; renderMyScheduleContent(); }
    });

    // Auto-scroll to 8 AM
    const wrap = document.getElementById('ms-grid-wrap');
    if (wrap) {
      const slotH = su.ZOOM_LEVELS[_schedZoomIdx];
      wrap.scrollTop = slotH * 16;
    }

    // Copy Monday to weekdays
    document.getElementById('ms-copy-mon')?.addEventListener('click', async () => {
      const tmpl = s.getMyTemplate();
      if (!tmpl || !tmpl.blocks) { toast('No schedule to copy'); return; }
      const monBlocks = tmpl.blocks.filter(b => b.dayOfWeek === 1);
      if (!monBlocks.length) { toast('No Monday blocks to copy'); return; }
      let newBlocks = tmpl.blocks.filter(b => b.dayOfWeek === 0 || b.dayOfWeek === 1 || b.dayOfWeek === 6);
      for (let dow = 2; dow <= 5; dow++) {
        for (const mb of monBlocks) {
          newBlocks.push({ ...mb, id: s.genBlockId(), dayOfWeek: dow });
        }
      }
      await s.saveScheduleTemplate(newBlocks);
      toast('Monday schedule copied to weekdays');
    });

    // Add custom event button
    document.getElementById('ms-add-custom')?.addEventListener('click', () => {
      showCustomEventModal(su.todayStr(), '09:00', '10:00');
    });

    // Click block to edit or dismiss
    appEl.querySelectorAll('.ms-block').forEach(block => {
      block.addEventListener('click', (e) => {
        if (e.target.classList.contains('ms-block-dismiss')) return; // handled below
        e.stopPropagation();
        const source = block.dataset.source;
        if (source === 'calendar') {
          toast('Calendar event — dismiss with the X button, or edit in your calendar app.');
          return;
        }
        if (source === 'custom') {
          showEditCustomEventModal(block.dataset.blockId.replace('custom_', ''), block.dataset.date);
          return;
        }
        showScheduleBlockEditor(block.dataset.blockId, block.dataset.date);
      });
    });

    // Dismiss calendar events
    // Dismiss calendar events
    appEl.querySelectorAll('.ms-block-dismiss').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const eventId = btn.dataset.dismissId;
        if (CS() && eventId) {
          await CS().dismissEvent(eventId);
          renderMyScheduleContent();
          toast('Event dismissed');
        }
      });
    });

    // Toggle calendar event status: unavailable ↔ busy-available
    appEl.querySelectorAll('.ms-block-status-toggle').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const eventId = btn.dataset.eventId;
        const current = btn.dataset.current;
        const newStatus = current === 'busy-available' ? 'unavailable' : 'busy-available';
        if (CS() && eventId) {
          await CS().setEventStatus(eventId, newStatus);
          renderMyScheduleContent();
          toast(newStatus === 'busy-available' ? 'Marked as busy but available' : 'Marked as unavailable');
        }
      });
    });

    // Drag to create on empty cells
    let dragStart = null;
    appEl.querySelectorAll('.ms-cell').forEach(cell => {
      cell.addEventListener('pointerdown', (e) => {
        dragStart = { day: +cell.dataset.day, slot: +cell.dataset.slot, date: cell.dataset.date };
        cell.setPointerCapture(e.pointerId);
      });
      cell.addEventListener('pointerup', () => {
        if (!dragStart) return;
        const endDay = +cell.dataset.day;
        const endSlot = +cell.dataset.slot;
        if (endDay !== dragStart.day) { dragStart = null; return; }
        const startSlot = Math.min(dragStart.slot, endSlot);
        const endSlotFinal = Math.max(dragStart.slot, endSlot) + 1;
        const startTime = su.slotToTime(startSlot, bounds.startHour);
        const endTime = su.slotToTime(endSlotFinal, bounds.startHour);
        dragStart = null;
        showNewScheduleBlockModal(cell.dataset.date, startTime, endTime, _schedMode);
      });
    });
  }

  /* ─── New Block Modal ────────────────────────────────────── */
  function showNewScheduleBlockModal(dateStr, startTime, endTime, mode) {
    const s = SS();
    const su = SU();
    mode = mode || _schedMode;
    const d = new Date(dateStr + 'T00:00:00');
    const dow = d.getDay();
    const dayLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const modeColor = s.MODE_COLORS[mode] || '#22c55e';
    const modeLabel = s.MODE_LABELS[mode] || 'Block';
    const reasonOptions = s.UNAVAIL_REASONS.map(r => `<option value="${r}">${r}</option>`).join('');

    const isRecurring = mode === 'recurring';
    const isSpecial = mode === 'special';
    const isBlackout = mode === 'blackout';

    const overlay = document.createElement('div');
    overlay.className = 'ms-modal-overlay';
    overlay.innerHTML = `<div class="ms-modal">
      <h3 style="display:flex;align-items:center;gap:.5rem">
        <span class="ms-mode-dot" style="background:${modeColor};width:10px;height:10px;border-radius:50%;display:inline-block"></span>
        Add ${modeLabel} Block
      </h3>
      <p style="color:var(--muted);font-size:.82rem;">${dayLabel}, ${su.fmtTime(startTime)} – ${su.fmtTime(endTime)}</p>
      ${isRecurring ? `
        <div style="margin:.75rem 0;">
          <label class="app-label">Type</label>
          <select id="ms-sb-type" class="app-input">
            <option value="available">Available (in lab)</option>
            <option value="unavailable">Unavailable</option>
          </select>
        </div>` : ''}
      ${isRecurring || isBlackout ? `
        <div id="ms-sb-unavail-fields" style="${isBlackout ? '' : 'display:none;'}">
          <div style="margin:.75rem 0;">
            <label class="app-label">Reason</label>
            <select id="ms-sb-reason" class="app-input">${reasonOptions}</select>
          </div>
          <div style="margin:.75rem 0;">
            <label class="app-label">Flexibility</label>
            <div style="display:flex;gap:.35rem">
              <button class="ms-rig-btn active" data-rig="rigid">Rigid</button>
              <button class="ms-rig-btn" data-rig="flexible">Flexible</button>
            </div>
          </div>
        </div>` : ''}
      <div style="display:flex;gap:.5rem;margin:.75rem 0;">
        <div style="flex:1"><label class="app-label">Start</label><input id="ms-sb-start" class="app-input" type="time" value="${startTime}" /></div>
        <div style="flex:1"><label class="app-label">End</label><input id="ms-sb-end" class="app-input" type="time" value="${endTime}" /></div>
      </div>
      ${isRecurring ? `<p style="font-size:.75rem;color:var(--muted);margin:.5rem 0">Repeats every ${d.toLocaleDateString('en-US', { weekday: 'long' })}.</p>` : ''}
      ${isSpecial ? `<p style="font-size:.75rem;color:var(--muted);margin:.5rem 0">Special availability on ${dayLabel} only.</p>` : ''}
      ${isBlackout ? `<p style="font-size:.75rem;color:var(--muted);margin:.5rem 0">Special unavailability for ${dayLabel} only.</p>` : ''}
      <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:1rem">
        <button class="app-btn app-btn--secondary" id="ms-sb-cancel">Cancel</button>
        <button class="app-btn app-btn--primary" id="ms-sb-save">Save</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    if (isRecurring) {
      const typeSelect = overlay.querySelector('#ms-sb-type');
      const unavailFields = overlay.querySelector('#ms-sb-unavail-fields');
      if (typeSelect && unavailFields) {
        typeSelect.addEventListener('change', () => {
          unavailFields.style.display = typeSelect.value === 'unavailable' ? '' : 'none';
        });
      }
    }

    let rigidity = 'rigid';
    overlay.querySelectorAll('[data-rig]').forEach(btn => {
      btn.addEventListener('click', () => {
        rigidity = btn.dataset.rig;
        overlay.querySelectorAll('[data-rig]').forEach(b => b.classList.toggle('active', b.dataset.rig === rigidity));
      });
    });

    overlay.querySelector('#ms-sb-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#ms-sb-save').addEventListener('click', async () => {
      let type, reason;
      if (isRecurring) {
        type = overlay.querySelector('#ms-sb-type')?.value || 'available';
        reason = type === 'unavailable' ? overlay.querySelector('#ms-sb-reason')?.value : null;
      } else if (isSpecial) {
        type = 'available'; reason = null;
      } else {
        type = 'unavailable';
        reason = overlay.querySelector('#ms-sb-reason')?.value || 'Other';
      }
      const st = overlay.querySelector('#ms-sb-start').value;
      const et = overlay.querySelector('#ms-sb-end').value;
      if (!st || !et || st >= et) { toast('Invalid time range'); return; }

      const blockData = { startTime: st, endTime: et, type, reason, rigidity: type === 'unavailable' ? rigidity : 'flexible', mode };
      try {
        if (isRecurring) {
          const tmpl = s.getMyTemplate();
          const blocks = tmpl ? [...tmpl.blocks] : [];
          blocks.push({ ...blockData, id: s.genBlockId(), dayOfWeek: dow });
          await s.saveScheduleTemplate(blocks);
        } else {
          await s.addScheduleOverride({ date: dateStr, action: 'add', blockId: null, block: blockData });
        }
        toast('Block saved');
        overlay.remove();
      } catch (err) { toast('Error saving block'); }
    });
  }

  /* ─── Edit Block Modal ───────────────────────────────────── */
  function showScheduleBlockEditor(blockId, dateStr) {
    const s = SS();
    const su = SU();
    const tmpl = s.getMyTemplate();
    const tmplBlock = tmpl?.blocks?.find(b => b.id === blockId);
    const ovrBlock = s.getAllOverrides().find(o => o.id === blockId);
    const block = tmplBlock || (ovrBlock ? { ...ovrBlock.block, id: blockId } : null);
    if (!block) return;

    const isTemplate = !!tmplBlock;
    const blockMode = block.mode || (isTemplate ? 'recurring' : (block.type === 'available' ? 'special' : 'blackout'));
    const modeColor = s.MODE_COLORS[blockMode] || '#22c55e';
    const modeLabel = s.MODE_LABELS[blockMode] || 'Block';
    const isBlackout = blockMode === 'blackout';
    const isRecurring = blockMode === 'recurring';
    const reasonOptions = s.UNAVAIL_REASONS.map(r => `<option value="${r}" ${block.reason === r ? 'selected' : ''}>${r}</option>`).join('');

    const overlay = document.createElement('div');
    overlay.className = 'ms-modal-overlay';
    overlay.innerHTML = `<div class="ms-modal">
      <h3 style="display:flex;align-items:center;gap:.5rem">
        <span class="ms-mode-dot" style="background:${modeColor};width:10px;height:10px;border-radius:50%;display:inline-block"></span>
        Edit ${modeLabel} Block
      </h3>
      ${isRecurring ? `<div style="margin:.75rem 0;"><label class="app-label">Type</label>
        <select id="ms-sbe-type" class="app-input">
          <option value="available" ${block.type === 'available' ? 'selected' : ''}>Available</option>
          <option value="unavailable" ${block.type === 'unavailable' ? 'selected' : ''}>Unavailable</option>
        </select></div>` : ''}
      ${(isRecurring || isBlackout) ? `<div id="ms-sbe-unavail-fields" style="${(isBlackout || block.type === 'unavailable') ? '' : 'display:none;'}">
        <div style="margin:.75rem 0;"><label class="app-label">Reason</label>
          <select id="ms-sbe-reason" class="app-input">${reasonOptions}</select></div>
        <div style="margin:.75rem 0;"><label class="app-label">Flexibility</label>
          <div style="display:flex;gap:.35rem">
            <button class="ms-rig-btn ${block.rigidity === 'rigid' ? 'active' : ''}" data-rig="rigid">Rigid</button>
            <button class="ms-rig-btn ${block.rigidity === 'flexible' ? 'active' : ''}" data-rig="flexible">Flexible</button>
          </div></div></div>` : ''}
      <div style="display:flex;gap:.5rem;margin:.75rem 0;">
        <div style="flex:1"><label class="app-label">Start</label><input id="ms-sbe-start" class="app-input" type="time" value="${block.startTime}" /></div>
        <div style="flex:1"><label class="app-label">End</label><input id="ms-sbe-end" class="app-input" type="time" value="${block.endTime}" /></div>
      </div>
      <div style="display:flex;gap:.5rem;margin-top:1rem">
        <button class="app-btn app-btn--danger" id="ms-sbe-delete">Delete</button>
        <span style="flex:1"></span>
        <button class="app-btn app-btn--secondary" id="ms-sbe-cancel">Cancel</button>
        <button class="app-btn app-btn--primary" id="ms-sbe-save">Save</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    if (isRecurring) {
      const typeSelect = overlay.querySelector('#ms-sbe-type');
      if (typeSelect) typeSelect.addEventListener('change', () => {
        const uf = overlay.querySelector('#ms-sbe-unavail-fields');
        if (uf) uf.style.display = typeSelect.value === 'unavailable' ? '' : 'none';
      });
    }

    let rigidity = block.rigidity || 'rigid';
    overlay.querySelectorAll('[data-rig]').forEach(btn => {
      btn.addEventListener('click', () => {
        rigidity = btn.dataset.rig;
        overlay.querySelectorAll('[data-rig]').forEach(b => b.classList.toggle('active', b.dataset.rig === rigidity));
      });
    });

    overlay.querySelector('#ms-sbe-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#ms-sbe-delete').addEventListener('click', async () => {
      try {
        if (isTemplate) {
          const blocks = (tmpl?.blocks || []).filter(b => b.id !== blockId);
          await s.saveScheduleTemplate(blocks);
        } else {
          await s.deleteScheduleOverride(blockId);
        }
        toast('Block deleted');
        overlay.remove();
      } catch (err) { toast('Error deleting'); }
    });

    overlay.querySelector('#ms-sbe-save').addEventListener('click', async () => {
      let type, reason;
      if (isRecurring) {
        type = overlay.querySelector('#ms-sbe-type')?.value || block.type;
        reason = type === 'unavailable' ? overlay.querySelector('#ms-sbe-reason')?.value : null;
      } else if (blockMode === 'special') {
        type = 'available'; reason = null;
      } else {
        type = 'unavailable';
        reason = overlay.querySelector('#ms-sbe-reason')?.value || block.reason;
      }
      const st = overlay.querySelector('#ms-sbe-start').value;
      const et = overlay.querySelector('#ms-sbe-end').value;
      if (!st || !et || st >= et) { toast('Invalid time range'); return; }

      const updatedBlock = { startTime: st, endTime: et, type, reason, rigidity: type === 'unavailable' ? rigidity : 'flexible', mode: blockMode };
      try {
        if (isTemplate) {
          const blocks = (tmpl?.blocks || []).map(b => b.id === blockId ? { ...b, ...updatedBlock } : b);
          await s.saveScheduleTemplate(blocks);
        } else {
          await s.deleteScheduleOverride(blockId);
          await s.addScheduleOverride({ date: dateStr, action: 'add', blockId: null, block: updatedBlock });
        }
        toast('Block updated');
        overlay.remove();
      } catch (err) { toast('Error saving'); }
    });
  }

  /* ─── Custom Event Modal ─────────────────────────────────── */
  const PRESET_COLORS = ['#5baed1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#fb923c', '#6b7280', '#3b82f6', '#a78bfa', '#78716c'];

  function showCustomEventModal(dateStr, startTime, endTime, existing) {
    const su = SU();
    const s = SS();
    const d = new Date(dateStr + 'T00:00:00');
    const dow = d.getDay();
    const dayLabel = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const isEdit = !!existing;

    const overlay = document.createElement('div');
    overlay.className = 'ms-modal-overlay';
    overlay.innerHTML = `<div class="ms-modal">
      <h3>${isEdit ? 'Edit' : 'Add'} Custom Event</h3>
      <div style="margin:.75rem 0;">
        <label class="app-label">Title</label>
        <input id="ms-ce-title" class="app-input" type="text" placeholder="e.g., Lab Meeting" value="${esc(existing?.title || '')}" />
      </div>
      <div style="display:flex;gap:.5rem;margin:.75rem 0;">
        <div style="flex:1"><label class="app-label">Start</label><input id="ms-ce-start" class="app-input" type="time" value="${existing?.startTime || startTime}" /></div>
        <div style="flex:1"><label class="app-label">End</label><input id="ms-ce-end" class="app-input" type="time" value="${existing?.endTime || endTime}" /></div>
      </div>
      <div style="margin:.75rem 0;">
        <label class="app-label">Color</label>
        <div class="ms-color-picker" id="ms-ce-colors">
          ${PRESET_COLORS.map(c => `<button class="ms-color-swatch${(existing?.color || '#a78bfa') === c ? ' active' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}
        </div>
      </div>
      <div style="margin:.75rem 0;">
        <label style="font-size:.78rem;color:var(--muted);display:flex;align-items:center;gap:.35rem">
          <input type="checkbox" id="ms-ce-recurring" ${existing?.isRecurring ? 'checked' : ''} /> Repeat every ${d.toLocaleDateString('en-US', { weekday: 'long' })}
        </label>
      </div>
      <div style="display:flex;gap:.5rem;margin-top:1rem">
        ${isEdit ? '<button class="app-btn app-btn--danger" id="ms-ce-delete">Delete</button><span style="flex:1"></span>' : '<span style="flex:1"></span>'}
        <button class="app-btn app-btn--secondary" id="ms-ce-cancel">Cancel</button>
        <button class="app-btn app-btn--primary" id="ms-ce-save">Save</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);

    let selectedColor = existing?.color || '#a78bfa';
    overlay.querySelectorAll('.ms-color-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        selectedColor = sw.dataset.color;
        overlay.querySelectorAll('.ms-color-swatch').forEach(s2 => s2.classList.toggle('active', s2.dataset.color === selectedColor));
      });
    });

    overlay.querySelector('#ms-ce-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    if (isEdit) {
      overlay.querySelector('#ms-ce-delete')?.addEventListener('click', async () => {
        try {
          await s.deleteCustomEvent(existing.id);
          toast('Event deleted');
          overlay.remove();
        } catch { toast('Error deleting'); }
      });
    }

    overlay.querySelector('#ms-ce-save').addEventListener('click', async () => {
      const title = overlay.querySelector('#ms-ce-title').value.trim();
      if (!title) { toast('Enter a title'); return; }
      const st = overlay.querySelector('#ms-ce-start').value;
      const et = overlay.querySelector('#ms-ce-end').value;
      if (!st || !et || st >= et) { toast('Invalid time range'); return; }
      const isRecurring = overlay.querySelector('#ms-ce-recurring').checked;

      const eventData = {
        title, startTime: st, endTime: et, color: selectedColor,
        isRecurring,
        date: isRecurring ? null : dateStr,
        dayOfWeek: isRecurring ? dow : null
      };
      if (isEdit) eventData.id = existing.id;

      try {
        await s.saveCustomEvent(eventData);
        toast(isEdit ? 'Event updated' : 'Event created');
        overlay.remove();
      } catch { toast('Error saving'); }
    });
  }

  function showEditCustomEventModal(eventId, dateStr) {
    const s = SS();
    const events = s.getCustomEventsForDate(dateStr);
    const ev = events.find(e => e.id === eventId);
    if (!ev) return;
    showCustomEventModal(dateStr, ev.startTime, ev.endTime, ev);
  }

  /* ================================================================
     SCHEDULERS TAB — existing scheduler CRUD
     ================================================================ */
  function renderSchedulersTab(container) {
    if (_currentView === 'editor' && _editingId) {
      renderEditor(container, _editingId);
    } else {
      renderList(container);
    }
  }

  function renderList(container) {
    container.innerHTML = `
      <div class="sched-home-header">
        <h2>My Schedulers</h2>
        <button class="app-btn app-btn--primary" id="new-sched-btn">+ New Scheduler</button>
      </div>
      <div id="sched-create-area" hidden></div>
      <div id="sched-list">
        <p class="app-empty"><span>Loading schedulers&hellip;</span></p>
      </div>`;

    document.getElementById('new-sched-btn').addEventListener('click', () => {
      const area = document.getElementById('sched-create-area');
      if (area.hidden) {
        area.hidden = false;
        area.innerHTML = createFormHTML();
        wireCreateForm();
      } else {
        area.hidden = true;
        area.innerHTML = '';
      }
    });

    subscribeList();
  }

  function createFormHTML() {
    return `
      <div class="sched-create-form">
        <form id="sched-form">
          <div class="form-group">
            <label for="sched-title-input">Title</label>
            <input type="text" id="sched-title-input" required placeholder="e.g., Lab Meeting Schedule">
          </div>
          <div class="form-group">
            <label for="sched-desc-input">Description</label>
            <textarea id="sched-desc-input" rows="2" placeholder="Brief description (optional)"></textarea>
          </div>
          <div class="form-group">
            <label for="sched-mode-input">Mode</label>
            <select id="sched-mode-input">
              <option value="sessions">Sessions — fixed time windows on specific days</option>
              <option value="freeform">Freeform — guests paint their own availability</option>
            </select>
          </div>
          <div style="display:flex;gap:.5rem;">
            <button type="submit" class="app-btn app-btn--primary">Create</button>
            <button type="button" class="app-btn app-btn--secondary" id="cancel-create-btn">Cancel</button>
          </div>
          <div id="create-status" class="form-status" hidden></div>
        </form>
      </div>`;
  }

  function wireCreateForm() {
    document.getElementById('cancel-create-btn')?.addEventListener('click', () => {
      const area = document.getElementById('sched-create-area');
      area.hidden = true;
      area.innerHTML = '';
    });

    document.getElementById('sched-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const st = document.getElementById('create-status');
      st.hidden = true;

      const title = document.getElementById('sched-title-input').value.trim();
      if (!title) return;

      const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)
        + '-' + Date.now().toString(36);

      try {
        await SDB.saveSchedule({
          id, title,
          subtitle: '', semester: '',
          description: document.getElementById('sched-desc-input').value.trim(),
          mode: document.getElementById('sched-mode-input').value,
          sessionBlocks: [], selectedDays: [], startDate: '', endDate: '',
          sections: ['overview', 'speakers'],
          slotDefs: [], guestFields: [], booleanQuestions: [],
          startHour: 8, endHour: 18, granularity: 30,
          ownerUid: _user.uid
        });
        st.textContent = 'Scheduler created!';
        st.className = 'form-status success';
        st.hidden = false;
        document.getElementById('sched-form').reset();
        setTimeout(() => {
          document.getElementById('sched-create-area').hidden = true;
          document.getElementById('sched-create-area').innerHTML = '';
        }, 800);
        await subscribeList();
      } catch (err) {
        st.textContent = 'Error: ' + err.message;
        st.className = 'form-status error';
        st.hidden = false;
      }
    });
  }

  let _unsubList = null;

  function subscribeList() {
    if (_unsubList) _unsubList();
    const el = document.getElementById('sched-list');
    if (!el) return;

    _unsubList = db().collection('schedules')
      .where('ownerUid', '==', _user.uid)
      .onSnapshot(snap => {
        renderListItems(el, snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }, err => {
        el.innerHTML = '<p class="error-text">Failed to load: ' + esc(err.message) + '</p>';
      });
  }

  function renderListItems(el, schedules) {
    try {
      schedules.sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));

      if (!schedules.length) {
        el.innerHTML = '<p class="empty-state">No schedulers yet. Click "+ New Scheduler" to get started.</p>';
        notifyResize();
        return;
      }

      el.innerHTML = '<div class="sched-list">' + schedules.map(s => `
        <div class="sched-item">
          <div class="sched-item-info">
            <strong>${esc(s.title || 'Untitled')}</strong>
            <span class="hint">${esc(s.mode || 'sessions')}${s.sessionBlocks?.length ? ' &middot; ' + s.sessionBlocks.length + ' session(s)' : (s.startDate ? ' &middot; ' + esc(s.startDate) + (s.endDate ? ' \u2013 ' + esc(s.endDate) : '') : '')}</span>
          </div>
          <div class="sched-item-actions">
            <button class="app-btn app-btn--primary" data-manage="${s.id}">Manage</button>
            <button class="app-btn app-btn--danger" data-delete="${s.id}">Delete</button>
          </div>
        </div>
      `).join('') + '</div>';

      el.querySelectorAll('[data-manage]').forEach(btn => {
        btn.addEventListener('click', () => navigate('editor', btn.dataset.manage));
      });

      el.querySelectorAll('[data-delete]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this scheduler and all its participants?')) return;
          try {
            btn.disabled = true;
            btn.textContent = 'Deleting\u2026';
            await SDB.deleteSchedule(btn.dataset.delete);
            await subscribeList();
          } catch (err) {
            alert('Delete failed: ' + err.message);
            btn.disabled = false;
            btn.textContent = 'Delete';
          }
        });
      });

      notifyResize();
    } catch (err) {
      el.innerHTML = '<p class="error-text">Failed to load: ' + esc(err.message) + '</p>';
    }
  }

  /* ─── Editor View ───────────────────────────────────────────── */
  async function renderEditor(container, scheduleId) {
    const Sched = McgheeLab.Scheduler;
    if (!Sched) {
      container.innerHTML = '<p class="error-text">Scheduler engine not loaded.</p>';
      return;
    }

    container.innerHTML = `
      <div class="sched-editor-header">
        <button class="sched-back-link" id="sched-back-btn">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          All Schedulers
        </button>
        <h2 id="sched-editor-title">Loading&hellip;</h2>
      </div>
      <p class="muted-text" id="sched-editor-subtitle"></p>
      <div id="scheduler-editor-content">
        <p class="app-empty"><span>Loading&hellip;</span></p>
      </div>`;

    document.getElementById('sched-back-btn').addEventListener('click', () => navigate('list'));

    let schedule = await SDB.getSchedule(scheduleId);
    if (!schedule) {
      document.getElementById('scheduler-editor-content').innerHTML =
        '<p class="muted-text">Scheduler not found.</p>';
      return;
    }

    if (schedule.ownerUid !== _user.uid && _profile?.role !== 'admin') {
      document.getElementById('scheduler-editor-content').innerHTML =
        '<p class="muted-text">Access denied.</p>';
      return;
    }

    const titleEl = document.getElementById('sched-editor-title');
    const subtitleEl = document.getElementById('sched-editor-subtitle');
    if (titleEl) titleEl.textContent = schedule.title || 'Scheduler';
    if (subtitleEl) subtitleEl.textContent = schedule.description || '';

    let speakers = [];
    try { speakers = await SDB.getSpeakers(scheduleId); } catch (e) {}

    const edContainer = document.getElementById('scheduler-editor-content');
    if (!edContainer) return;

    let _adminViewMode = 'admin';
    let _previewSpeakerIdx = 0;

    function buildConfig() {
      return {
        scheduleId, schedule, speakers,
        currentSpeaker: null, viewType: 'admin', useKeyAuth: false,
        adminViewMode: _adminViewMode, previewSpeakerIdx: _previewSpeakerIdx,
        buildInviteURL: (sid, key) => {
          const base = location.origin + location.pathname.replace(/apps\/scheduler\/.*$/, '');
          return `${base}#/schedule/${sid}?key=${key}`;
        },
        onSaveSpeaker: async (id, data) => { await SDB.updateSpeaker(id, data); },
        onSaveSchedule: async (data) => { await SDB.saveSchedule(data); },
        onAddSpeaker: async (data) => { await SDB.addSpeaker(data); },
        onDeleteSpeaker: async (id) => { await SDB.deleteSpeaker(id); },
        onRefresh: async () => {
          schedule = await SDB.getSchedule(scheduleId);
          speakers = await SDB.getSpeakers(scheduleId);
          if (titleEl) titleEl.textContent = schedule.title || 'Scheduler';
          if (subtitleEl) subtitleEl.textContent = schedule.description || '';
          edContainer.innerHTML = Sched.render(buildConfig());
          Sched.wire('scheduler-editor-content', buildConfig());
          notifyResize();
        },
        onSwitchView: (mode, idx) => {
          _adminViewMode = mode;
          _previewSpeakerIdx = idx || 0;
          edContainer.innerHTML = Sched.render(buildConfig());
          Sched.wire('scheduler-editor-content', buildConfig());
          notifyResize();
        }
      };
    }

    edContainer.innerHTML = Sched.render(buildConfig());
    Sched.wire('scheduler-editor-content', buildConfig());
    notifyResize();
  }

})();
