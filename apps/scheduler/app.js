/* ================================================================
   Scheduler — McGheeLab Lab App
   Standalone scheduling app. Create schedulers, add guests,
   manage sessions/freeform availability, and share invite links.
   ================================================================ */

(() => {
  const appEl = document.getElementById('app');

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
  let _currentView = 'list';  // 'list' | 'editor'
  let _editingId = null;

  /* ─── Init ──────────────────────────────────────────────────── */
  McgheeLab.AppBridge.init();
  if (McgheeLab.MobileShell) McgheeLab.MobileShell.configure({ appId: 'scheduler', title: 'Scheduler' });
  McgheeLab.AppBridge.onReady((user, profile) => {
    _user = user;
    _profile = profile;
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

  /* ─── Router ────────────────────────────────────────────────── */
  function renderApp() {
    if (!_user) return;
    if (_currentView === 'editor' && _editingId) {
      renderEditor(_editingId);
    } else {
      renderList();
    }
  }

  function navigate(view, id) {
    _currentView = view;
    _editingId = id || null;
    renderApp();
  }

  /* ================================================================
     LIST VIEW — show all schedulers, create new ones
     ================================================================ */
  function renderList() {
    appEl.innerHTML = `
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
          id,
          title,
          subtitle: '',
          semester: '',
          description: document.getElementById('sched-desc-input').value.trim(),
          mode: document.getElementById('sched-mode-input').value,
          sessionBlocks: [],
          selectedDays: [],
          startDate: '',
          endDate: '',
          sections: ['overview', 'speakers'],
          slotDefs: [],
          guestFields: [],
          startHour: 8,
          endHour: 18,
          granularity: 30,
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
        el.innerHTML = '<p class="error-text">Failed to load schedulers: ' + esc(err.message) + '</p>';
      });
  }

  function renderListItems(el, schedules) {
    try {
      schedules.sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));

      if (!schedules.length) {
        el.innerHTML = '<p class="empty-state">No schedulers created yet. Click "+ New Scheduler" to get started.</p>';
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
      el.innerHTML = '<p class="error-text">Failed to load schedulers: ' + esc(err.message) + '</p>';
    }
  }

  /* ================================================================
     EDITOR VIEW — full scheduler editor (admin view)
     ================================================================ */
  async function renderEditor(scheduleId) {
    const Sched = McgheeLab.Scheduler;
    if (!Sched) {
      appEl.innerHTML = '<p class="error-text">Scheduler engine not loaded.</p>';
      return;
    }

    appEl.innerHTML = `
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

    // Verify ownership
    if (schedule.ownerUid !== _user.uid && _profile?.role !== 'admin') {
      document.getElementById('scheduler-editor-content').innerHTML =
        '<p class="muted-text">Access denied.</p>';
      return;
    }

    // Update header
    const titleEl = document.getElementById('sched-editor-title');
    const subtitleEl = document.getElementById('sched-editor-subtitle');
    if (titleEl) titleEl.textContent = schedule.title || 'Scheduler';
    if (subtitleEl) subtitleEl.textContent = schedule.description || '';

    let speakers = [];
    try { speakers = await SDB.getSpeakers(scheduleId); } catch (e) {}

    const container = document.getElementById('scheduler-editor-content');
    if (!container) return;

    let _adminViewMode = 'admin';
    let _previewSpeakerIdx = 0;

    function buildConfig() {
      return {
        scheduleId,
        schedule,
        speakers,
        currentSpeaker: null,
        viewType: 'admin',
        useKeyAuth: false,
        adminViewMode: _adminViewMode,
        previewSpeakerIdx: _previewSpeakerIdx,
        buildInviteURL: (sid, key) => {
          // Build invite URL pointing to main site's schedule page
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
          container.innerHTML = Sched.render(buildConfig());
          Sched.wire('scheduler-editor-content', buildConfig());
          notifyResize();
        },
        onSwitchView: (mode, idx) => {
          _adminViewMode = mode;
          _previewSpeakerIdx = idx || 0;
          container.innerHTML = Sched.render(buildConfig());
          Sched.wire('scheduler-editor-content', buildConfig());
          notifyResize();
        }
      };
    }

    container.innerHTML = Sched.render(buildConfig());
    Sched.wire('scheduler-editor-content', buildConfig());
    notifyResize();
  }

})();
