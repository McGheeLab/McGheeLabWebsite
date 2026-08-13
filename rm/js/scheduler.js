/* ================================================================
   Scheduler — RM-native port (V3.47 + V3.55)
   ================================================================
   Two-tab page covering both halves of the original /apps/scheduler/:

   1. **My Schedule** (V3.55) — personal calendar with layers
      (recurring availability, per-week overrides, custom events,
      Google/Outlook/Apple calendar overlay). Drag on the time grid
      to create blocks; click blocks to edit; toggle layer visibility
      from the layer panel. Backed by McgheeLab.ScheduleService +
      McgheeLab.CalendarService brought into RM in V3.51 and loaded
      from rm/pages/scheduler.html. Gracefully degrades to an empty
      Gantt with a "service not loaded" notice if those scripts are
      absent.

   2. **My Schedulers** (V3.47) — create + manage shareable scheduler
      links (lab seminar lineup, meeting time-poll). Editor view
      mounts McgheeLab.Scheduler from /scheduler.js and wires
      onSaveSchedule / onSaveSpeaker / etc. config callbacks to
      surgical Firestore writes via firebridge.db(). List view uses
      api.load + LIVE_SYNC for cache + cross-tab updates.

   Default tab is `schedulers` to preserve the V3.47 behavior; user
   switches to `myschedule` via the tab bar at the top.

   firestore.rules (already in place):
     - schedules/{id} + participants/{id}: V3.47 covered.
     - huddleScheduleTemplates / huddleScheduleOverrides /
       scheduleCustomEvents: line 288-307; ScheduleService writes via
       these on My Schedule edits.
   ================================================================ */

(function () {
  'use strict';

  const root = document.getElementById('sched-root');
  if (!root) {
    console.warn('[scheduler] #sched-root container missing');
    return;
  }

  /* ─── State ─────────────────────────────────────────────── */
  let _user = null;
  let _profile = null;
  let _currentTab = 'schedulers'; // 'myschedule' | 'schedulers' (V3.55)
  let _view = 'list';        // 'list' | 'editor' (within Schedulers tab)
  let _editingId = null;
  let _schedules = [];       // cached list (filtered client-side)
  let _live = null;
  let _toastTimer = null;

  /* ─── My Schedule state (V3.55) ─────────────────────────── */
  let _weekOffset = 0;
  let _schedMode = 'recurring';      // 'recurring' | 'special' | 'blackout'
  let _schedZoomIdx = 5;             // index into ScheduleUtils.ZOOM_LEVELS

  /* V3.342: narrow screens show a 3-day window into the week */
  let _dayWindowStart = 0;           // 0..4 — first visible day index
  const _narrowMQ = window.matchMedia('(max-width: 700px)');
  if (_narrowMQ.addEventListener) {
    _narrowMQ.addEventListener('change', () => {
      _dayWindowStart = 0;
      if (_currentTab === 'myschedule') renderMyScheduleContent();
    });
  }
  function msIsNarrow() { return _narrowMQ.matches; }
  function msVisibleDays() {
    const su = SU();
    const all = su ? su.getWeekDays(_weekOffset) : [];
    if (!msIsNarrow()) return all;
    const start = Math.max(0, Math.min(4, _dayWindowStart));
    return all.slice(start, start + 3);
  }
  /* Shift the 3-day window; rolls into adjacent weeks at the edges. */
  function msShiftDays(delta) {
    const s = SS();
    let start = Math.max(0, Math.min(4, _dayWindowStart)) + delta;
    if (start < 0) {
      _weekOffset--; if (s) s.setWeekOffset(_weekOffset);
      start = 4;
    } else if (start > 4) {
      _weekOffset++; if (s) s.setWeekOffset(_weekOffset);
      start = 0;
    }
    _dayWindowStart = start;
    renderMyScheduleContent();
  }

  /* Service aliases — null when shared services aren't loaded
   * (graceful degradation, same pattern as the lab app). */
  function SS() { return (typeof McgheeLab !== 'undefined' && McgheeLab.ScheduleService) || null; }
  function SU() { return (typeof McgheeLab !== 'undefined' && McgheeLab.ScheduleUtils) || null; }
  function CS() { return (typeof McgheeLab !== 'undefined' && McgheeLab.CalendarService) || null; }

  function lockIcon() { return '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>'; }
  function calIcon() { return '\u{1F4C5}'; }

  function db() {
    if (typeof firebridge !== 'undefined' && firebridge.db) return firebridge.db();
    if (typeof firebase === 'undefined') throw new Error('Firebase SDK not loaded');
    return firebase.firestore();
  }

  function isAdmin() { return _profile && _profile.role === 'admin'; }

  /* ─── Boot ──────────────────────────────────────────────── */
  (async function () {
    if (typeof firebridge === 'undefined') {
      console.warn('[scheduler] firebridge not available');
      return;
    }
    if (typeof McgheeLab === 'undefined' || !McgheeLab.Scheduler) {
      root.innerHTML = '<div class="empty-state">Scheduler engine not loaded — check that <code>/scheduler.js</code> is reachable.</div>';
      return;
    }
    if (firebridge.requireSignIn) await firebridge.requireSignIn();

    _user = firebridge.getUser ? firebridge.getUser() : null;
    _profile = firebridge.getProfile ? firebridge.getProfile() : null;
    if (!_user) return;

    // V3.55: init shared services (no-op if not loaded). ScheduleService
    // and CalendarService back the My Schedule tab; without them the tab
    // shows an empty Gantt with a "service not loaded" notice.
    if (CS()) {
      try { await CS().init(_user, {}); } catch (e) { console.warn('[scheduler] CalendarService init:', e); }
    }
    if (SS()) {
      try { await SS().init(_user, _profile); } catch (e) { console.warn('[scheduler] ScheduleService init:', e); }
      if (SS().onChange) {
        SS().onChange(() => {
          if (_currentTab === 'myschedule') renderMyScheduleContent();
          else if (_currentTab === 'team') renderTeamContent();
        });
      }
    }
    if (CS() && CS().onChange) {
      CS().onChange(() => { if (_currentTab === 'myschedule') renderMyScheduleContent(); });
    }

    try {
      await loadAndRender();
    } catch (err) {
      console.warn('[scheduler] initial load failed:', err);
      root.innerHTML = '<div class="empty-state">Failed to load schedulers — see console.</div>';
      return;
    }

    if (typeof LIVE_SYNC !== 'undefined' && LIVE_SYNC.attach) {
      _live = LIVE_SYNC.attach({
        paths: ['scheduler/list.json'],
        refresh: async () => {
          // Only refresh the list view; editor manages its own state.
          if (_view === 'list') await loadAndRender();
        },
        tag: 'scheduler',
      });
    }

    if (firebridge.onAuth) {
      firebridge.onAuth(function () {
        const prevRole = _profile && _profile.role;
        _user = firebridge.getUser ? firebridge.getUser() : _user;
        _profile = firebridge.getProfile ? firebridge.getProfile() : _profile;
        if ((_profile && _profile.role) !== prevRole && _view === 'list') render();
      });
    }
  })();

  async function loadAndRender() {
    const data = await api.load('scheduler/list.json');
    _schedules = (data && data.schedules) || [];
    if (_view === 'list') render();
    // Editor renders eagerly via navigate('editor', id) — don't trigger
    // a re-render here; that path manages its own DOM.
  }

  /* ─── SDB layer (Firestore CRUD via firebridge.db) ─────── */
  function _suppress(ms) { if (_live) _live.suppressUntil = Date.now() + (ms || 2500); }

  function _genKey() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
  }

  const SDB = {
    async getSchedule(id) {
      const doc = await db().collection('schedules').doc(id).get();
      return doc.exists ? Object.assign({ id: doc.id }, doc.data()) : null;
    },
    async saveSchedule(data) {
      _suppress();
      const id = data.id;
      const rest = Object.assign({}, data);
      delete rest.id;
      rest.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await db().collection('schedules').doc(id).set(rest, { merge: true });
      return id;
    },
    async deleteSchedule(id) {
      _suppress();
      const parts = await SDB.getSpeakers(id);
      for (const p of parts) await db().collection('participants').doc(p.id).delete();
      await db().collection('schedules').doc(id).delete();
    },
    async getSpeakers(scheduleId) {
      const snap = await db().collection('participants')
        .where('scheduleId', '==', scheduleId).get();
      return snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    },
    async addSpeaker(data) {
      const key = _genKey();
      const payload = Object.assign({}, data, {
        key,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      await db().collection('participants').doc(key).set(payload);
      return key;
    },
    async updateSpeaker(id, data) {
      const payload = Object.assign({}, data, {
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      await db().collection('participants').doc(id).update(payload);
    },
    async deleteSpeaker(id) {
      await db().collection('participants').doc(id).delete();
    },
  };

  /* ─── Helpers ───────────────────────────────────────────── */
  function escHTML(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }
  // The V3.55 code lifted from /apps/scheduler/app.js calls its escaper
  // `esc` — alias it so those call sites resolve (V3.342 bug fix).
  const esc = escHTML;

  function toast(msg, kind) {
    if (typeof window !== 'undefined' && typeof window.toast === 'function' && window.toast !== toast) {
      try { window.toast(msg, kind); return; } catch (e) {}
    }
    const ex = document.querySelector('.sched-toast');
    if (ex) ex.remove();
    clearTimeout(_toastTimer);
    const el = document.createElement('div');
    el.className = 'sched-toast' + (kind === 'error' ? ' sched-toast--error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    _toastTimer = setTimeout(() => el.remove(), 2800);
  }

  function navigate(view, id) {
    _view = view;
    _editingId = id || null;
    if (view === 'editor' && id) {
      renderEditor(root, id);
    } else {
      render();
    }
  }

  /* ─── Render dispatcher (V3.55 tab bar; V3.342 relabel + Team) ── */
  const TAB_SUBTITLES = {
    myschedule: 'When are you free? Paint your weekly schedule.',
    schedulers: 'Create a link, collect availability from guests, assign slots.',
    team: 'See when lab members are free at the same time.',
  };

  function render() {
    root.innerHTML =
      '<div class="sched-tab-bar">' +
        '<button class="sched-tab' + (_currentTab === 'myschedule' ? ' active' : '') + '" data-tab="myschedule">My Availability</button>' +
        '<button class="sched-tab' + (_currentTab === 'schedulers' ? ' active' : '') + '" data-tab="schedulers">Scheduling Links</button>' +
        '<button class="sched-tab' + (_currentTab === 'team' ? ' active' : '') + '" data-tab="team">Team</button>' +
      '</div>' +
      '<p class="sched-tab-subtitle">' + escHTML(TAB_SUBTITLES[_currentTab] || '') + '</p>' +
      '<div id="sched-tab-content"></div>';

    root.querySelectorAll('.sched-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab === _currentTab) return;
        _currentTab = btn.dataset.tab;
        // Reset Schedulers' editor view when switching tabs so we don't
        // resume into a half-loaded editor on tab toggle.
        if (_currentTab === 'schedulers') _view = 'list';
        render();
      });
    });

    const content = document.getElementById('sched-tab-content');
    if (_currentTab === 'myschedule') {
      renderMyScheduleTab(content);
    } else if (_currentTab === 'team') {
      renderTeamTab(content);
    } else {
      renderSchedulersTab(content);
    }
  }

  /* ─── Schedulers tab (V3.47 — list + create + editor) ────── */
  function renderSchedulersTab(container) {
    container.innerHTML =
      '<div class="sched-home-header">' +
        '<h2 class="sched-h2">Scheduling Links</h2>' +
        '<button class="btn btn-primary" id="new-sched-btn">+ New Scheduler</button>' +
      '</div>' +
      '<div id="sched-create-area" hidden></div>' +
      '<div id="sched-list">' +
        '<p class="empty-state">Loading schedulers&hellip;</p>' +
      '</div>';

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

    paintList();
  }

  function paintList() {
    const el = document.getElementById('sched-list');
    if (!el) return;

    // Client-side filter: own (or all if admin). Sort newest first.
    const myUid = _user && _user.uid;
    const visible = isAdmin()
      ? _schedules.slice()
      : _schedules.filter(s => s.ownerUid === myUid);

    visible.sort((a, b) => {
      const ta = (a.updatedAt && a.updatedAt.toMillis && a.updatedAt.toMillis()) ||
                 (a.updatedAt && a.updatedAt.seconds && a.updatedAt.seconds * 1000) || 0;
      const tb = (b.updatedAt && b.updatedAt.toMillis && b.updatedAt.toMillis()) ||
                 (b.updatedAt && b.updatedAt.seconds && b.updatedAt.seconds * 1000) || 0;
      return tb - ta;
    });

    if (!visible.length) {
      el.innerHTML =
        '<div class="empty-state sched-howto">' +
          '<p><strong>No schedulers yet.</strong> How it works:</p>' +
          '<ol>' +
            '<li>Click <strong>+ New Scheduler</strong> and pick a mode (fixed sessions or freeform).</li>' +
            '<li>Add guests in the editor — each guest gets a personal invite link.</li>' +
            '<li>Guests paint their availability; you assign slots from the responses.</li>' +
          '</ol>' +
        '</div>';
      return;
    }

    el.innerHTML = '<div class="sched-list">' + visible.map(s => {
      const sessionHint = s.sessionBlocks && s.sessionBlocks.length
        ? ' &middot; ' + s.sessionBlocks.length + ' session(s)'
        : (s.startDate ? ' &middot; ' + escHTML(s.startDate) + (s.endDate ? ' – ' + escHTML(s.endDate) : '') : '');
      const ownerHint = isAdmin() && s.ownerUid && s.ownerUid !== myUid
        ? ' <span class="hint">(owner: ' + escHTML(s.ownerUid.slice(0, 6)) + ')</span>'
        : '';
      return (
        '<div class="sched-item" data-sched-id="' + escHTML(s.id) + '">' +
          '<div class="sched-item-info">' +
            '<strong>' + escHTML(s.title || 'Untitled') + '</strong>' + ownerHint +
            '<span class="hint">' + escHTML(s.mode || 'sessions') + sessionHint + '</span>' +
            '<span class="sched-resp-badge hint" data-resp="' + escHTML(s.id) + '">&hellip;</span>' +
          '</div>' +
          '<div class="sched-item-actions">' +
            '<button class="btn" data-links="' + escHTML(s.id) + '">&#128279; Links</button>' +
            '<button class="btn btn-primary" data-manage="' + escHTML(s.id) + '">Manage</button>' +
            '<button class="btn sched-btn-danger" data-delete="' + escHTML(s.id) + '">Delete</button>' +
          '</div>' +
          '<div class="sched-links-row" data-links-row="' + escHTML(s.id) + '" hidden></div>' +
        '</div>'
      );
    }).join('') + '</div>';

    el.querySelectorAll('[data-manage]').forEach(btn => {
      btn.addEventListener('click', () => navigate('editor', btn.dataset.manage));
    });

    // V3.342: guest-response badges + per-guest invite links, filled in
    // asynchronously (one small participants query per visible scheduler).
    const partCache = {};
    visible.forEach(async (s) => {
      let parts = [];
      try { parts = await SDB.getSpeakers(s.id); } catch (e) {}
      partCache[s.id] = parts;
      const badge = el.querySelector('[data-resp="' + CSS.escape(s.id) + '"]');
      if (!badge) return;
      if (!parts.length) { badge.innerHTML = 'No guests yet'; return; }
      const responded = parts.filter(p => (p.availability || []).length > 0).length;
      const assigned = parts.filter(p => p.assignedSlot).length;
      badge.innerHTML = responded + ' / ' + parts.length + ' responded' +
        (assigned ? ' &middot; ' + assigned + ' assigned' : '');
    });

    function inviteURL(sid, key) {
      return location.origin + '/#/schedule/' + sid + '?key=' + key;
    }

    el.querySelectorAll('[data-links]').forEach(btn => {
      btn.addEventListener('click', () => {
        const sid = btn.dataset.links;
        const row = el.querySelector('[data-links-row="' + CSS.escape(sid) + '"]');
        if (!row) return;
        if (!row.hidden) { row.hidden = true; return; }
        if (!partCache[sid]) {
          row.innerHTML = '<p class="hint" style="margin:.25rem 0;">Loading guests&hellip; try again in a moment.</p>';
          row.hidden = false;
          return;
        }
        const parts = partCache[sid];
        row.innerHTML = parts.length
          ? parts.map(p =>
              '<div class="sched-link-line">' +
                '<span>' + escHTML(p.speakerName || p.speakerEmail || 'Guest') + '</span>' +
                '<button class="btn" data-copy-key="' + escHTML(p.key || p.id) + '" data-copy-sid="' + escHTML(sid) + '">Copy link</button>' +
              '</div>').join('')
          : '<p class="hint" style="margin:.25rem 0;">No guests yet — open Manage to add guests; each gets a personal invite link.</p>';
        row.hidden = false;
        row.querySelectorAll('[data-copy-key]').forEach(cb => {
          cb.addEventListener('click', async () => {
            const url = inviteURL(cb.dataset.copySid, cb.dataset.copyKey);
            try {
              await navigator.clipboard.writeText(url);
              toast('Invite link copied');
            } catch (e) {
              prompt('Copy this invite link:', url);
            }
          });
        });
      });
    });

    el.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this scheduler and all its participants?')) return;
        try {
          btn.disabled = true;
          btn.textContent = 'Deleting…';
          await SDB.deleteSchedule(btn.dataset.delete);
          _schedules = _schedules.filter(s => s.id !== btn.dataset.delete);
          paintList();
          toast('Scheduler deleted');
        } catch (err) {
          alert('Delete failed: ' + err.message);
          btn.disabled = false;
          btn.textContent = 'Delete';
        }
      });
    });
  }

  function createFormHTML() {
    return (
      '<div class="sched-create-form">' +
        '<form id="sched-form">' +
          '<div class="form-group">' +
            '<label for="sched-title-input">Title</label>' +
            '<input type="text" id="sched-title-input" required placeholder="e.g., Lab Meeting Schedule">' +
          '</div>' +
          '<div class="form-group">' +
            '<label for="sched-desc-input">Description</label>' +
            '<textarea id="sched-desc-input" rows="2" placeholder="Brief description (optional)"></textarea>' +
          '</div>' +
          '<div class="form-group">' +
            '<label for="sched-mode-input">Mode</label>' +
            '<select id="sched-mode-input">' +
              '<option value="sessions">Sessions — fixed time windows on specific days</option>' +
              '<option value="freeform">Freeform — guests paint their own availability</option>' +
            '</select>' +
          '</div>' +
          '<div style="display:flex;gap:.5rem;">' +
            '<button type="submit" class="btn btn-primary">Create</button>' +
            '<button type="button" class="btn" id="cancel-create-btn">Cancel</button>' +
          '</div>' +
          '<div id="create-status" class="form-status" hidden></div>' +
        '</form>' +
      '</div>'
    );
  }

  function wireCreateForm() {
    document.getElementById('cancel-create-btn').addEventListener('click', () => {
      const area = document.getElementById('sched-create-area');
      area.hidden = true;
      area.innerHTML = '';
    });

    document.getElementById('sched-form').addEventListener('submit', async (e) => {
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
          ownerUid: _user.uid,
        });
        st.textContent = 'Scheduler created!';
        st.className = 'form-status success';
        st.hidden = false;
        document.getElementById('sched-form').reset();
        // Refresh the list — surgical write path bypassed api.save's
        // cache invalidation, so we manually reload.
        await loadAndRender();
        setTimeout(() => {
          const area = document.getElementById('sched-create-area');
          if (area) { area.hidden = true; area.innerHTML = ''; }
        }, 800);
      } catch (err) {
        st.textContent = 'Error: ' + err.message;
        st.className = 'form-status error';
        st.hidden = false;
      }
    });
  }

  /* ─── Editor view (engine mount) ────────────────────────── */
  async function renderEditor(container, scheduleId) {
    const Sched = McgheeLab.Scheduler;
    if (!Sched) {
      container.innerHTML = '<div class="empty-state">Scheduler engine not loaded.</div>';
      return;
    }

    container.innerHTML =
      '<div class="sched-editor-header">' +
        '<button class="sched-back-link" id="sched-back-btn">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>' +
          ' All Schedulers' +
        '</button>' +
        '<h2 id="sched-editor-title" class="sched-h2">Loading&hellip;</h2>' +
      '</div>' +
      '<p class="muted-text" id="sched-editor-subtitle"></p>' +
      '<div id="scheduler-editor-content">' +
        '<p class="empty-state">Loading&hellip;</p>' +
      '</div>';

    document.getElementById('sched-back-btn').addEventListener('click', () => navigate('list'));

    let schedule = await SDB.getSchedule(scheduleId);
    if (!schedule) {
      document.getElementById('scheduler-editor-content').innerHTML =
        '<p class="empty-state">Scheduler not found.</p>';
      return;
    }

    if (schedule.ownerUid !== _user.uid && !isAdmin()) {
      document.getElementById('scheduler-editor-content').innerHTML =
        '<p class="empty-state">Access denied — only the scheduler owner or an admin can edit.</p>';
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
        // Invite URL — guest sign-up at #/schedule/{id}?key={participantKey}
        // is served by the public-site SPA at /. Always strip /rm/... off
        // location.pathname so the link points at the public root.
        buildInviteURL: (sid, key) => {
          const base = location.origin + '/';
          return base + '#/schedule/' + sid + '?key=' + key;
        },
        onSaveSpeaker: async (id, data) => { await SDB.updateSpeaker(id, data); },
        onSaveSchedule: async (data) => { await SDB.saveSchedule(data); },
        onAddSpeaker:   async (data) => { await SDB.addSpeaker(data); },
        onDeleteSpeaker: async (id) => { await SDB.deleteSpeaker(id); },
        onRefresh: async () => {
          schedule = await SDB.getSchedule(scheduleId);
          speakers = await SDB.getSpeakers(scheduleId);
          if (titleEl) titleEl.textContent = schedule.title || 'Scheduler';
          if (subtitleEl) subtitleEl.textContent = schedule.description || '';
          edContainer.innerHTML = Sched.render(buildConfig());
          Sched.wire('scheduler-editor-content', buildConfig());
        },
        onSwitchView: (mode, idx) => {
          _adminViewMode = mode;
          _previewSpeakerIdx = idx || 0;
          edContainer.innerHTML = Sched.render(buildConfig());
          Sched.wire('scheduler-editor-content', buildConfig());
        },
      };
    }

    edContainer.innerHTML = Sched.render(buildConfig());
    Sched.wire('scheduler-editor-content', buildConfig());
  }

  /* ═══════════════════════════════════════════════════════════
     TEAM TAB (V3.342) — read-only overlap of lab members' free
     time. Reuses ScheduleService's collection-wide template +
     override subscriptions (the same data Huddle reads); no new
     Firestore paths.
     ═══════════════════════════════════════════════════════════ */
  let _teamSelected = null; // Set of uids; null until first render

  function renderTeamTab(container) {
    const s = SS();
    const su = SU();
    if (!s || !su) {
      container.innerHTML = '<p class="empty-state">Schedule service not loaded.</p>';
      return;
    }
    container.innerHTML = renderTeamHTML();
    wireTeamTab(container);
  }

  function renderTeamContent() {
    const content = document.getElementById('sched-tab-content');
    if (!content || _currentTab !== 'team') return;
    content.innerHTML = renderTeamHTML();
    wireTeamTab(content);
  }

  /* Minute-interval helpers for N-way overlap */
  function _toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
  function _fromMin(n) {
    return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  }
  function _mergeIvs(ivs) {
    const sorted = ivs.slice().sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const iv of sorted) {
      if (out.length && iv[0] <= out[out.length - 1][1]) {
        out[out.length - 1][1] = Math.max(out[out.length - 1][1], iv[1]);
      } else out.push([iv[0], iv[1]]);
    }
    return out;
  }
  function _intersectIvs(a, b) {
    const out = [];
    for (const [as, ae] of a) for (const [bs, be] of b) {
      const s0 = Math.max(as, bs), e0 = Math.min(ae, be);
      if (s0 < e0) out.push([s0, e0]);
    }
    return _mergeIvs(out);
  }

  /* A user's free minutes on a date: available blocks minus every
     unavailable block (template, override, calendar, custom). */
  function _freeIvsFor(uid, dateStr) {
    const s = SS();
    const sched = s.resolveScheduleForUser(uid, dateStr);
    let free = _mergeIvs(sched.filter(b => b.type === 'available')
      .map(b => [_toMin(b.startTime), _toMin(b.endTime)]));
    for (const b of sched) {
      if (b.type !== 'unavailable') continue;
      const bs = _toMin(b.startTime), be = _toMin(b.endTime);
      free = free.flatMap(([a, z]) => {
        if (be <= a || bs >= z) return [[a, z]];
        const out = [];
        if (bs > a) out.push([a, bs]);
        if (be < z) out.push([be, z]);
        return out;
      });
    }
    return free;
  }

  function renderTeamHTML() {
    const s = SS();
    const su = SU();
    const templates = s.getAllTemplates()
      .filter(t => t.blocks && t.blocks.length)
      .sort((a, b) => (a.ownerName || '').localeCompare(b.ownerName || ''));

    if (_teamSelected === null) {
      _teamSelected = new Set();
      if (_user && templates.some(t => t.id === _user.uid)) _teamSelected.add(_user.uid);
    }

    if (!templates.length) {
      return '<p class="empty-state">No lab members have set availability yet. Paint yours in the <strong>My Availability</strong> tab first.</p>';
    }

    const chips = templates.map(t => {
      const sel = _teamSelected.has(t.id);
      const isMe = _user && t.id === _user.uid;
      return `<button class="ms-mode-btn team-chip${sel ? ' active' : ''}" data-team-uid="${escHTML(t.id)}" style="--mode-color:${su.getUserColor(t.id)}">
        <span class="ms-mode-dot" style="background:${su.getUserColor(t.id)}"></span>${escHTML(t.ownerName || 'Member')}${isMe ? ' (you)' : ''}
      </button>`;
    }).join('');

    const uids = [...(_teamSelected || [])];
    let daysHTML = '';
    if (uids.length < 2) {
      daysHTML = '<p class="empty-state">Pick two or more people to see when everyone is free.</p>';
    } else {
      const days = su.getWeekDays(_weekOffset);
      const today = su.todayStr();
      daysHTML = '<div class="team-days">' + days.map(d => {
        let acc = null;
        for (const uid of uids) {
          const ivs = _freeIvsFor(uid, d.date);
          acc = acc === null ? ivs : _intersectIvs(acc, ivs);
          if (!acc.length) break;
        }
        const windows = (acc || []).filter(([a, z]) => z - a >= 30); // ≥30 min
        const chipsHTML = windows.length
          ? windows.map(([a, z]) => `<span class="team-window">${su.fmtTime(_fromMin(a))} – ${su.fmtTime(_fromMin(z))}</span>`).join('')
          : '<span class="team-none">No common time</span>';
        return `<div class="team-day${d.date === today ? ' team-day--today' : ''}">
          <div class="team-day-label">${d.dayShort} <span class="hint">${d.monthDay}</span></div>
          <div class="team-day-windows">${chipsHTML}</div>
        </div>`;
      }).join('') + '</div>';
    }

    return `<div class="team-layout">
      <div class="ms-week-nav">
        <button class="ms-nav-btn" id="team-week-prev">&lsaquo;</button>
        <span class="ms-week-label">${su.getWeekLabel(_weekOffset)}</span>
        <button class="ms-nav-btn" id="team-week-next">&rsaquo;</button>
        ${_weekOffset !== 0 ? '<button class="ms-nav-today" id="team-week-today">Today</button>' : ''}
      </div>
      <div class="team-chips">${chips}</div>
      ${daysHTML}
    </div>`;
  }

  function wireTeamTab(container) {
    const s = SS();
    container.querySelectorAll('[data-team-uid]').forEach(chip => {
      chip.addEventListener('click', () => {
        const uid = chip.dataset.teamUid;
        if (_teamSelected.has(uid)) _teamSelected.delete(uid);
        else _teamSelected.add(uid);
        renderTeamContent();
      });
    });
    document.getElementById('team-week-prev')?.addEventListener('click', () => {
      _weekOffset--; s.setWeekOffset(_weekOffset); renderTeamContent();
    });
    document.getElementById('team-week-next')?.addEventListener('click', () => {
      _weekOffset++; s.setWeekOffset(_weekOffset); renderTeamContent();
    });
    document.getElementById('team-week-today')?.addEventListener('click', () => {
      _weekOffset = 0; s.setWeekOffset(0); renderTeamContent();
    });
  }

  /* ═══════════════════════════════════════════════════════════
     MY SCHEDULE TAB (V3.55 — lifted from /apps/scheduler/app.js
     lines 191-908 via git history; `appEl` references swapped
     to `root`; service aliases SS/SU/CS already defined above)
     ═══════════════════════════════════════════════════════════ */
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

    const days = msVisibleDays();
    const bounds = { startHour: 0, endHour: 24 };
    const slots = su.timeLabels(bounds.startHour, bounds.endHour);
    const slotH = su.ZOOM_LEVELS[_schedZoomIdx];
    const totalRows = slots.length;
    const today = su.todayStr();
    const layerCfg = s.getLayerConfig();

    // First-run hint — disappears once the user has any block anywhere
    const _tmpl = s.getMyTemplate();
    const msFirstRun = !(_tmpl && _tmpl.blocks && _tmpl.blocks.length) &&
      !s.getAllOverrides().some(o => o.ownerUid === (_user && _user.uid));

    // Week label — on narrow screens show the visible 3-day span instead
    const weekLabel = msIsNarrow() && days.length
      ? days[0].monthDay + ' – ' + days[days.length - 1].monthDay
      : su.getWeekLabel(_weekOffset);

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
        cellsHTML += `<div class="ms-cell${si % 2 === 0 ? ' ms-cell--hour' : ''}${days[di].date === today ? ' ms-cell--today' : ''}" data-day="${di}" data-slot="${si}" data-date="${days[di].date}" style="grid-column:${di + 2}; grid-row:${si + 2};"></div>`;
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

        blocksHTML += `<div class="ms-block${rigidClass}${flexClass}${calClass}${customClass}${busyAvailClass}" data-block-id="${block.id}" data-date="${dateStr}" data-day="${di}" data-source="${block.source || ''}" data-mode="${block.mode || ''}" data-cal-status="${block.calStatus || ''}" style="grid-column:${di + 2}; grid-row:${startSlot + 2}/span ${span}; border-left-color:${color}; background:${color}${isBusyAvail ? '33' : '22'}; color:${color};">
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
          <button class="app-btn app-btn--secondary" id="ms-add-block" style="font-size:.72rem;padding:.2rem .5rem;">+ Block</button>
          <button class="app-btn app-btn--secondary" id="ms-copy-mon" style="font-size:.72rem;padding:.2rem .5rem;">Copy Mon &rarr; Weekdays</button>
          <button class="app-btn app-btn--secondary" id="ms-add-custom" style="font-size:.72rem;padding:.2rem .5rem;">+ Custom Event</button>
          ${zoomHTML}
        </div>
        ${layerPanel}
        ${msFirstRun ? `<div class="ms-firstrun">Paint your weekly availability: pick a mode above, then tap or drag on the grid below.</div>` : ''}
        <p style="color:var(--muted);font-size:.75rem;margin:.25rem 0 0;">Tap or drag to paint in the selected mode. Tap a block to edit it${msIsNarrow() ? '' : '; drag across a block to erase'}.</p>
      </div>
      <div class="ms-body">
        <div class="ms-scroll-area">
          <div class="ms-grid-wrap" id="ms-grid-wrap" data-slot-h="${slotH}">
            <div class="ms-grid" data-mode="${_schedMode}" style="grid-template-columns:${msIsNarrow() ? 48 : 60}px repeat(${days.length}, 1fr); grid-template-rows:auto repeat(${totalRows}, ${slotH}px);">
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

    // Week navigation — on narrow screens the arrows shift the 3-day
    // window (rolling into adjacent weeks); on desktop they change weeks.
    document.getElementById('ms-week-prev')?.addEventListener('click', () => {
      if (msIsNarrow()) { msShiftDays(-3); return; }
      _weekOffset--;
      s.setWeekOffset(_weekOffset);
      renderMyScheduleContent();
    });
    document.getElementById('ms-week-next')?.addEventListener('click', () => {
      if (msIsNarrow()) { msShiftDays(3); return; }
      _weekOffset++;
      s.setWeekOffset(_weekOffset);
      renderMyScheduleContent();
    });
    document.getElementById('ms-week-today')?.addEventListener('click', () => {
      _weekOffset = 0;
      _dayWindowStart = 0;
      s.setWeekOffset(0);
      renderMyScheduleContent();
    });

    // Mode selector
    root.querySelectorAll('.ms-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _schedMode = btn.dataset.mode;
        root.querySelectorAll('.ms-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === _schedMode));
        const grid = root.querySelector('.ms-grid');
        if (grid) grid.dataset.mode = _schedMode;
      });
    });

    // Layer toggles
    root.querySelectorAll('[data-layer]').forEach(cb => {
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

    // Precision entry — the old modal path, for exact times / recurring
    // unavailability (paint always creates the mode's default block type)
    document.getElementById('ms-add-block')?.addEventListener('click', () => {
      showNewScheduleBlockModal(su.todayStr(), '09:00', '10:00', _schedMode);
    });

    // Click block to edit or dismiss
    root.querySelectorAll('.ms-block').forEach(block => {
      block.addEventListener('click', (e) => {
        if (_paintDidDrag) return; // a paint/erase drag ended here — not a tap
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
    root.querySelectorAll('.ms-block-dismiss').forEach(btn => {
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
    root.querySelectorAll('.ms-block-status-toggle').forEach(btn => {
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

    // V3.342: paint-to-create / drag-to-erase on the grid
    wirePaintGrid();
  }

  /* ─── Paint interaction (V3.342) ─────────────────────────────
     Mouse: drag on empty cells paints a block in the current mode;
     drag starting on a template/override block erases across it.
     Touch: a tap on an empty cell adds one 30-min block (merging
     with adjacent same-type blocks, so repeated taps grow a block);
     vertical swipes scroll (touch-action: pan-y in scheduler.css);
     a horizontal swipe shifts the 3-day window on narrow screens.
     Committed blocks persist via ScheduleService; the Firestore
     snapshot listener re-renders the grid. */
  let _paintDidDrag = false;

  function wirePaintGrid() {
    const s = SS();
    const su = SU();
    const grid = root.querySelector('.ms-grid');
    if (!s || !su || !grid) return;

    const slotCount = su.timeLabels(0, 24).length;
    let sess = null; // active pointer session

    function geom() {
      const c0 = grid.querySelector('.ms-cell[data-day="0"][data-slot="0"]');
      if (!c0) return null;
      const r = c0.getBoundingClientRect();
      return { x0: r.left, y0: r.top, w: r.width, h: r.height };
    }
    const clampSlot = (n) => Math.max(0, Math.min(slotCount - 1, n));
    const slotAt = (g, y) => clampSlot(Math.floor((y - g.y0) / g.h));

    function setPreview(dayIdx, a, b, cls) {
      grid.querySelectorAll('.ms-cell--paint, .ms-cell--erase').forEach(c =>
        c.classList.remove('ms-cell--paint', 'ms-cell--erase'));
      const lo = Math.min(a, b), hi = Math.max(a, b);
      for (let si = lo; si <= hi; si++) {
        grid.querySelector(`.ms-cell[data-day="${dayIdx}"][data-slot="${si}"]`)?.classList.add(cls);
      }
    }
    function clearPreview() {
      grid.querySelectorAll('.ms-cell--paint, .ms-cell--erase').forEach(c =>
        c.classList.remove('ms-cell--paint', 'ms-cell--erase'));
    }

    grid.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const g = geom();
      if (!g) return;

      const blockEl = e.target.closest('.ms-block');
      const cellEl = e.target.closest('.ms-cell');
      let op = null, mode = _schedMode, dayIdx, date;

      if (blockEl) {
        // Calendar/custom blocks keep their tap behaviors; template and
        // override blocks arm an erase drag (a plain tap still edits).
        if (e.target.closest('.ms-block-dismiss') || e.target.closest('.ms-block-status-toggle')) return;
        const src = blockEl.dataset.source;
        if (src !== 'template' && src !== 'override') return;
        op = 'erase';
        mode = blockEl.dataset.mode || (src === 'template' ? 'recurring' : 'blackout');
        dayIdx = +blockEl.dataset.day;
        date = blockEl.dataset.date;
      } else if (cellEl) {
        op = 'add';
        dayIdx = +cellEl.dataset.day;
        date = cellEl.dataset.date;
      } else {
        return;
      }

      const anchor = slotAt(g, e.clientY);
      sess = {
        id: e.pointerId, type: e.pointerType || 'mouse',
        op, mode, dayIdx, date,
        anchor, last: anchor,
        startX: e.clientX, startY: e.clientY,
        armed: op === 'add' && (e.pointerType || 'mouse') === 'mouse',
        fromBlock: !!blockEl,
        blockId: blockEl ? blockEl.dataset.blockId : null,
      };
      _paintDidDrag = false;
      try { grid.setPointerCapture(e.pointerId); } catch (err) {}
      if (sess.armed) setPreview(dayIdx, anchor, anchor, 'ms-cell--paint');
    });

    grid.addEventListener('pointermove', (e) => {
      if (!sess || e.pointerId !== sess.id) return;
      const g = geom();
      if (!g) return;
      const slot = slotAt(g, e.clientY);
      const moved = Math.abs(e.clientX - sess.startX) > 6 || Math.abs(e.clientY - sess.startY) > 6;

      // Mouse: any movement into another slot arms erase drags too.
      if (sess.type === 'mouse') {
        if (sess.fromBlock && !sess.armed && slot !== sess.anchor) sess.armed = true;
        if (sess.armed && slot !== sess.last) {
          sess.last = slot;
          _paintDidDrag = true;
          setPreview(sess.dayIdx, sess.anchor, slot, sess.op === 'add' ? 'ms-cell--paint' : 'ms-cell--erase');
        }
      } else if (moved) {
        // Touch: movement means scroll or swipe — this is not a tap.
        sess.moved = true;
      }
    });

    async function finish(e, cancelled) {
      if (!sess || e.pointerId !== sess.id) return;
      const done = sess;
      sess = null;
      clearPreview();

      // Pointer capture retargets the ensuing click to the grid, so a
      // plain tap on a captured block must open its editor from here.
      const tapBlock = () => {
        if (done.fromBlock && done.blockId) {
          _paintDidDrag = true; // suppress a duplicate click on the block itself
          showScheduleBlockEditor(done.blockId, done.date);
        }
      };

      if (done.type === 'mouse') {
        if (done.armed && (done.op === 'add' || _paintDidDrag)) {
          const lo = Math.min(done.anchor, done.last);
          const hi = Math.max(done.anchor, done.last) + 1;
          await commitPaint(done.date, done.mode, done.op, lo, hi);
        } else if (done.fromBlock && !_paintDidDrag) {
          tapBlock();
        }
        return;
      }

      // Touch / pen
      if (cancelled) return; // browser took the gesture (scroll)
      const dx = e.clientX - done.startX;
      const dy = e.clientY - done.startY;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (msIsNarrow()) msShiftDays(dx < 0 ? 1 : -1);
        return;
      }
      if (done.moved) return;
      if (done.op === 'add') {
        _paintDidDrag = true; // suppress any synthetic click on re-render
        await commitPaint(done.date, done.mode, 'add', done.anchor, done.anchor + 1);
      } else {
        tapBlock();
      }
    }

    grid.addEventListener('pointerup', (e) => { finish(e, false); });
    grid.addEventListener('pointercancel', (e) => { finish(e, true); });
    // Reset the click-suppression flag after the click phase has passed.
    grid.addEventListener('click', () => { setTimeout(() => { _paintDidDrag = false; }, 0); }, true);
  }

  /* Interval helpers — slots are half-hour indices, ranges half-open */
  function _slotRange(su, b) {
    return [su.timeToSlot(b.startTime, 0), su.timeToSlot(b.endTime, 0)];
  }
  function _subtractIv(ivs, bs, be) {
    return ivs.flatMap(([a, z]) => {
      if (be <= a || bs >= z) return [[a, z]];
      const out = [];
      if (bs > a) out.push([a, bs]);
      if (be < z) out.push([be, z]);
      return out;
    });
  }

  /* Persist a painted range. op 'add' unions with same-type blocks in
     the same layer (and clips against opposite-type ones); op 'erase'
     deletes / trims / splits the layer's blocks under the range. */
  async function commitPaint(dateStr, mode, op, s0, s1) {
    const s = SS();
    const su = SU();
    if (!s || !su || s1 <= s0) return;
    const dow = new Date(dateStr + 'T00:00:00').getDay();

    try {
      if (mode === 'recurring') {
        const tmpl = s.getMyTemplate();
        const blocks = tmpl && tmpl.blocks ? [...tmpl.blocks] : [];
        const out = [];
        if (op === 'add') {
          let ns = s0, ne = s1;
          const others = [];
          for (const b of blocks) {
            if (b.dayOfWeek !== dow) { out.push(b); continue; }
            const [bs, be] = _slotRange(su, b);
            if ((b.type || 'available') === 'available' && be >= ns && bs <= ne) {
              ns = Math.min(ns, bs); ne = Math.max(ne, be); // absorb into union
            } else {
              others.push(b); out.push(b);
            }
          }
          let ivs = [[ns, ne]];
          for (const b of others) {
            if ((b.type || 'available') !== 'unavailable') continue;
            const [bs, be] = _slotRange(su, b);
            ivs = _subtractIv(ivs, bs, be);
          }
          for (const [a, z] of ivs) {
            if (z <= a) continue;
            out.push({
              id: s.genBlockId(), dayOfWeek: dow,
              startTime: su.slotToTime(a, 0), endTime: su.slotToTime(z, 0),
              type: 'available', reason: null, rigidity: 'flexible', mode: 'recurring',
            });
          }
        } else {
          for (const b of blocks) {
            if (b.dayOfWeek !== dow) { out.push(b); continue; }
            const [bs, be] = _slotRange(su, b);
            if (be <= s0 || bs >= s1) { out.push(b); continue; }
            if (bs < s0) out.push({ ...b, endTime: su.slotToTime(s0, 0) });
            if (be > s1) out.push({ ...b, id: bs < s0 ? s.genBlockId() : b.id, startTime: su.slotToTime(s1, 0) });
          }
        }
        await s.saveScheduleTemplate(out);
      } else {
        const type = mode === 'special' ? 'available' : 'unavailable';
        const mine = s.getAllOverrides().filter(o =>
          o.ownerUid === _user.uid && o.date === dateStr && o.action === 'add' && o.block &&
          (o.block.mode || (o.block.type === 'available' ? 'special' : 'blackout')) === mode);

        if (op === 'add') {
          let ns = s0, ne = s1;
          const absorbed = [];
          for (const o of mine) {
            const [bs, be] = _slotRange(su, o.block);
            if (be >= ns && bs <= ne) { ns = Math.min(ns, bs); ne = Math.max(ne, be); absorbed.push(o.id); }
          }
          for (const id of absorbed) await s.deleteScheduleOverride(id);
          await s.addScheduleOverride({
            date: dateStr, action: 'add', blockId: null,
            block: {
              startTime: su.slotToTime(ns, 0), endTime: su.slotToTime(ne, 0),
              type, reason: type === 'unavailable' ? 'Other' : null,
              rigidity: type === 'unavailable' ? 'rigid' : 'flexible', mode,
            },
          });
        } else {
          for (const o of mine) {
            const [bs, be] = _slotRange(su, o.block);
            if (be <= s0 || bs >= s1) continue;
            await s.deleteScheduleOverride(o.id);
            if (bs < s0) await s.addScheduleOverride({ date: dateStr, action: 'add', blockId: null, block: { ...o.block, endTime: su.slotToTime(s0, 0) } });
            if (be > s1) await s.addScheduleOverride({ date: dateStr, action: 'add', blockId: null, block: { ...o.block, startTime: su.slotToTime(s1, 0) } });
          }
        }
      }
    } catch (err) {
      console.warn('[scheduler] paint commit failed:', err);
      toast('Error saving — try again', 'error');
    }
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

})();
