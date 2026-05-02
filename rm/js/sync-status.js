/* sync-status.js — Phase 8: small "synced X min ago" pill in the top nav.
 *
 * Shows the freshest of {gmailCredential, calendarCredential, outlookCalendar}
 * lastSyncAt timestamps. Click → /pages/settings.html#connections. Hides
 * itself entirely when the user has no credentials yet (don't badger people
 * who haven't connected anything).
 *
 * Lives in the top-nav DOM next to the profile chip (firebase-bridge.js
 * renders #fb-profile-wrap there). We append #sync-status-chip just before
 * the profile wrap.
 *
 * State coloring:
 *   green  — most recent sync within 30 min
 *   amber  — 30 min – 24 hr
 *   red    — > 24 hr  OR  any provider has lastSyncError
 *   gray   — at least one provider connected but never synced
 *
 * Don't render at all when:
 *   - No signed-in user
 *   - No credentials in any of the three private/* docs
 *
 * Uses live onSnapshot listeners so the chip updates as soon as a sync
 * completes (whether scheduled or via the Settings → Sync now button).
 */
(function () {
  if (typeof window === 'undefined') return;
  // Don't run on the public library/share page (no auth wired in there).
  if (typeof firebridge === 'undefined') return;

  const PROVIDERS = [
    { key: 'gmail',    doc: 'gmailCredential',    label: 'Gmail' },
    { key: 'calendar', doc: 'calendarCredential', label: 'Calendar' },
    { key: 'outlook',  doc: 'outlookCalendar',    label: 'Outlook' },
  ];

  const FRESH_MS = 30 * 60 * 1000;          // 30 min
  const STALE_MS = 24 * 60 * 60 * 1000;     // 24 hr
  const TICK_MS  = 60 * 1000;               // re-render every minute so "5m ago" stays accurate

  const state = { creds: {}, unsubs: [], tickTimer: null, mounted: false };

  function _toMs(v) {
    if (!v) return 0;
    if (typeof v === 'object' && v.seconds) return v.seconds * 1000;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    return 0;
  }

  function _summary() {
    let mostRecent = 0;
    let hasError = false;
    let connectedCount = 0;
    PROVIDERS.forEach(p => {
      const c = state.creds[p.key];
      if (!c) return;
      connectedCount++;
      if (c.lastSyncError) hasError = true;
      const t = _toMs(c.lastSyncAt);
      if (t > mostRecent) mostRecent = t;
    });
    return { mostRecent, hasError, connectedCount };
  }

  function _ago(ms) {
    if (!ms) return 'never';
    const dt = Date.now() - ms;
    if (dt < 60_000) return 'just now';
    if (dt < 60 * 60_000) return Math.floor(dt / 60_000) + 'm ago';
    if (dt < 24 * 60 * 60_000) return Math.floor(dt / (60 * 60_000)) + 'h ago';
    return Math.floor(dt / (24 * 60 * 60_000)) + 'd ago';
  }

  function _render() {
    const chip = document.getElementById('sync-status-chip');
    if (!chip) return;

    const { mostRecent, hasError, connectedCount } = _summary();
    if (connectedCount === 0) {
      chip.style.display = 'none';
      return;
    }

    let dotColor, label;
    const dt = mostRecent ? Date.now() - mostRecent : Infinity;
    if (hasError) {
      dotColor = '#dc2626';
      label = 'Sync error';
    } else if (!mostRecent) {
      dotColor = '#9ca3af';
      label = 'Sync queued';
    } else if (dt < FRESH_MS) {
      dotColor = '#059669';
      label = 'Synced ' + _ago(mostRecent);
    } else if (dt < STALE_MS) {
      dotColor = '#d97706';
      label = 'Synced ' + _ago(mostRecent);
    } else {
      dotColor = '#dc2626';
      label = 'Stale ' + _ago(mostRecent);
    }

    chip.style.display = 'inline-flex';
    chip.title = PROVIDERS
      .map(p => state.creds[p.key]
        ? `${p.label}: ${state.creds[p.key].lastSyncAt ? _ago(_toMs(state.creds[p.key].lastSyncAt)) : 'never'}` +
            (state.creds[p.key].lastSyncError ? ` (error: ${state.creds[p.key].lastSyncError})` : '')
        : `${p.label}: not connected`)
      .join('\n');
    chip.innerHTML =
      '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + dotColor + ';margin-right:6px;"></span>' +
      '<span>' + label + '</span>';
  }

  function _mount() {
    if (state.mounted) return;
    const nav = document.querySelector('.top-nav');
    if (!nav) return;
    const profileWrap = document.getElementById('fb-profile-wrap');
    const chip = document.createElement('a');
    chip.id = 'sync-status-chip';
    chip.href = '/rm/pages/settings.html#connections';
    chip.style.cssText =
      'display:none;align-items:center;font-size:12px;color:#374151;' +
      'background:#fff;border:1px solid #e5e7eb;padding:4px 10px;border-radius:999px;' +
      'text-decoration:none;margin-right:8px;cursor:pointer;line-height:1;height:24px;' +
      'white-space:nowrap;';
    if (profileWrap) {
      nav.insertBefore(chip, profileWrap);
    } else {
      nav.appendChild(chip);
    }
    state.mounted = true;
  }

  // Phase H: lazy listener attach. Pre-fix: 3 always-on onSnapshot listeners
  // ran on every page load even when the user had no credentials connected.
  // Now: one-shot getDoc check per provider, onSnapshot only for the providers
  // where the credential doc actually exists. Net cost per page boot:
  //   - 0 creds connected: 3 cheap doc reads, 0 listeners (was 3 listeners)
  //   - 1 cred connected:  3 cheap doc reads, 1 listener (was 3)
  //   - all 3 connected:   3 cheap doc reads, 3 listeners (was 3 — no change)
  // Newly-connecting providers show up on the next page nav (acceptable).
  async function _attachListeners() {
    const me = firebridge.getUser && firebridge.getUser();
    if (!me) return;
    state.unsubs.forEach(u => { try { u(); } catch {} });
    state.unsubs = [];
    state.creds = {};
    const db = firebridge.db();
    await Promise.all(PROVIDERS.map(async (p) => {
      try {
        const ref = db.collection('userData').doc(me.uid)
          .collection('private').doc(p.doc);
        const snap = await ref.get();
        if (!snap.exists) {
          // No credential for this provider — skip the listener entirely.
          state.creds[p.key] = null;
          return;
        }
        state.creds[p.key] = snap.data();
        const unsub = ref.onSnapshot(s => {
          state.creds[p.key] = s.exists ? s.data() : null;
          _render();
        }, () => {
          state.creds[p.key] = null;
          _render();
        });
        state.unsubs.push(unsub);
      } catch (err) {
        // Ignore — most likely user not signed in yet.
      }
    }));
    _render();
  }

  function _start() {
    _mount();
    _render();
    _attachListeners();
    if (!state.tickTimer) {
      // Every minute, re-render so the "Xm ago" label stays accurate even
      // when no Firestore snapshot fires.
      state.tickTimer = setInterval(_render, TICK_MS);
    }
  }

  // Boot — wait for nav (built by nav.js on DOMContentLoaded) and auth.
  function _boot() {
    // The top-nav DOM is created by nav.js; firebase-bridge injects its
    // profile chip after that. Wait one tick so we can append AFTER both.
    setTimeout(() => {
      if (firebridge.whenAuthResolved) {
        firebridge.whenAuthResolved().then(_start, () => _start());
      } else {
        _start();
      }
    }, 50);

    // Re-attach listeners on auth state change (sign in / sign out).
    if (firebridge.onAuth) {
      firebridge.onAuth(() => {
        if (firebridge.getUser && firebridge.getUser()) {
          _start();
        } else {
          // Signed out — clear chip + listeners.
          state.unsubs.forEach(u => { try { u(); } catch {} });
          state.unsubs = [];
          state.creds = {};
          _render();
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _boot);
  } else {
    _boot();
  }
})();
