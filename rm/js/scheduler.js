/* ================================================================
   Scheduler — RM-native port (V3.47)
   ================================================================
   Subset port of /apps/scheduler/. The "My Schedulers" tab — create
   and manage shareable scheduler links (lab seminar speaker lineup,
   meeting time-poll, etc.) — moves here as a native RM page.

   The "My Schedule" tab (personal calendar layers, Google Calendar
   OAuth) is deferred to V3.51 alongside the equipment OAuth refactor.
   The standalone /apps/scheduler/ URL still resolves until then;
   nothing in this file references ScheduleService / CalendarService.

   Architecture:
     - The scheduling engine at /scheduler.js (1,382 LOC, stateless)
       is loaded by rm/pages/scheduler.html via <script src="/scheduler.js">
       and exposes McgheeLab.Scheduler. The engine emits HTML and wires
       events; it does NOT touch Firestore. Persistence is handled by
       config callbacks supplied here.
     - A small SDB wrapper layer (lifted from /apps/scheduler/app.js
       lines 39-87) does direct firebridge.db() reads/writes against
       schedules/{id} and participants/{key}. Surgical writes mirror
       the V3.41 meetings + V3.44 procurement patterns.
     - List view uses api.load + LIVE_SYNC for cache + cross-tab
       updates. Editor view does one-shot firestore reads (single
       editor at a time; engine's onRefresh callback re-loads).

   firestore.rules (already in place):
     - schedules/{id}: public read; create=any auth; update/delete=
       (owner || isAdmin).
     - participants/{id}: public read; create/update/delete with
       admin OR speakerUid match OR invite-key match (line 199-209).
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
  let _view = 'list';        // 'list' | 'editor'
  let _editingId = null;
  let _schedules = [];       // cached list (filtered client-side)
  let _live = null;
  let _toastTimer = null;

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
    firebridge.gateSignedIn();
    if (firebridge.whenAuthResolved) await firebridge.whenAuthResolved();

    _user = firebridge.getUser ? firebridge.getUser() : null;
    _profile = firebridge.getProfile ? firebridge.getProfile() : null;
    if (!_user) return;

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

  /* ─── List view ─────────────────────────────────────────── */
  function render() {
    root.innerHTML =
      '<div class="sched-home-header">' +
        '<h2 class="sched-h2">My Schedulers</h2>' +
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
      el.innerHTML = '<p class="empty-state">No schedulers yet. Click <strong>+ New Scheduler</strong> to get started.</p>';
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
        '<div class="sched-item">' +
          '<div class="sched-item-info">' +
            '<strong>' + escHTML(s.title || 'Untitled') + '</strong>' + ownerHint +
            '<span class="hint">' + escHTML(s.mode || 'sessions') + sessionHint + '</span>' +
          '</div>' +
          '<div class="sched-item-actions">' +
            '<button class="btn btn-primary" data-manage="' + escHTML(s.id) + '">Manage</button>' +
            '<button class="btn sched-btn-danger" data-delete="' + escHTML(s.id) + '">Delete</button>' +
          '</div>' +
        '</div>'
      );
    }).join('') + '</div>';

    el.querySelectorAll('[data-manage]').forEach(btn => {
      btn.addEventListener('click', () => navigate('editor', btn.dataset.manage));
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
})();
