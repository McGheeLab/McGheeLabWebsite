/* V3.226 — page-time-tracker.js (V3.228: per-page mode config;
 * V3.319: hours are dead — writes lightweight presence EVENTS)
 *
 * Silent 10-minute-window page activity tracker — RM's presence signal.
 * Any user activity (keydown, click, input, change, scroll, touch) on
 * any RM page silently marks the current 10-min window as "active" for
 * this page. As of V3.319 the doc is a lightweight event (kind:'work',
 * no status / duration / hours) — nothing asks the user to confirm.
 *
 * The day is divided into 144 ten-minute windows indexed 0..143 from
 * local midnight. The current window's index is logged once onto the
 * doc's `logged_windows` field (kept purely for cross-tab idempotency);
 * the doc carries one entry per page-slug per date with deterministic id
 *   trackerEntries/{uid}/entries/auto-pagetime-<slug>-<date>
 *
 * V3.228 — admin can configure each page's tracking mode in
 *   /rm/pages/admin-permissions.html?tab=tracking
 * which writes labConfig/pageTracking.modes (Map<slug, mode>):
 *   - 'tracked' (default): per-page entry as above
 *   - 'never':              no write; activity on this page is invisible
 *   - 'admin':              activity rolls into ONE shared "Admin work"
 *                           entry per day instead of a per-page entry.
 *                           Doc id: auto-pagetime-admin-work-<date>.
 * The page-time-tracker reads this doc once after auth; missing slugs
 * default to 'tracked'. SKIP_SLUGS still hard-skips activity-overview
 * regardless of stored mode (the tracker UI itself shouldn't write).
 *
 * Once the user confirms or dismisses the entry on the activity tracker
 * page (status != 'pending'), the writer freezes — further activity in
 * the same date won't overwrite the confirmed hours.
 *
 * Page slug: derived from window.location.pathname (e.g. "lab-notebook"
 * from "/rm/pages/lab-notebook.html"). The dashboard at "/rm/index.html"
 * maps to "dashboard". This becomes the entry's text + source_ref.id.
 *
 * Globals: window.PageTimeTracker (for manual flush / debug only).
 * Depends on: firebridge (firebase-bridge.js), firebase compat SDK.
 *
 * Self-installing IIFE — pages just need to load this script after
 * activity-signals.js.
 */
(function () {
  'use strict';

  // Hard-skip slugs — these are NEVER tracked regardless of admin config.
  // Activity Overview is the tracker UI itself: logging time spent
  // confirming entries would be circular. Empty slug catches unknown URL
  // shapes (no /rm/pages/ match).
  var SKIP_SLUGS = {
    'activity-overview': true,
    '':                  true,
  };

  // Page display labels — pretty names that show up in the tracker entry
  // text. Unknown slugs fall through to a Title-Cased version of the slug.
  var PAGE_LABELS = {
    'index':              'Dashboard',
    'dashboard':          'Dashboard',
    'lab-notebook':       'Lab Notebook',
    'protocols':          'Protocols',
    'meetings':           'Meetings',
    'tasks':              'Tasks',
    'calendar':           'Calendar',
    'library':            'Library',
    'library-paper':      'Paper Reader',
    'paper-builder':      'Paper Builder',
    'projects':           'Projects',
    'funding':            'Funding',
    'people':             'People',
    'equipment':          'Equipment',
    'procurement':        'Procurement',
    'inventory':          'Inventory',
    'training':           'Training',
    'sharing':            'Sharing',
    'cv':                 'CV Builder',
    'cv-overview':        'CV Overview',
    'links':              'Links',
    'chat':               'Chat',
    'pmr':                'PMR',
    'compliance':         'Compliance',
    'split-view':         'Split View',
    'explorer':           'Data Explorer',
  };

  function slugFromPath() {
    try {
      var p = String(window.location.pathname || '');
      // /rm/index.html or /rm/  →  dashboard
      if (/\/rm\/(index\.html)?$/.test(p) || /\/rm\/?$/.test(p)) return 'dashboard';
      // /rm/pages/<slug>.html  →  slug
      var m = p.match(/\/rm\/pages\/([^\/]+?)(?:\.html)?$/);
      if (m && m[1]) return m[1].toLowerCase();
      return '';
    } catch (e) { return ''; }
  }

  function labelFor(slug) {
    if (PAGE_LABELS[slug]) return PAGE_LABELS[slug];
    if (!slug) return 'Unknown page';
    return slug.split(/[-_]/).map(function (w) {
      return w ? w.charAt(0).toUpperCase() + w.slice(1) : '';
    }).join(' ');
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  // Local-midnight window index 0..143.
  function currentWindowIdx() {
    var d = new Date();
    return Math.floor((d.getHours() * 60 + d.getMinutes()) / 10);
  }

  function getDb() {
    return (typeof firebridge !== 'undefined' && firebridge.db) ? firebridge.db() : null;
  }
  function getUid() {
    if (typeof firebridge === 'undefined' || !firebridge.getUser) return null;
    var u = firebridge.getUser();
    return u && u.uid ? u.uid : null;
  }

  var _slug = slugFromPath();
  var _pageName = labelFor(_slug);
  var _lastLoggedWindow = -1;     // last window index this tab has written
  var _lastLoggedDate = '';       // resets when date rolls over
  var _writeInFlight = false;
  var _frozenForDate = '';        // date for which the entry is confirmed/dismissed → stop writing
  // V3.228 — current page's tracking mode. Set after labConfig/pageTracking
  // fetch resolves. Default 'tracked' for any slug not in the config.
  var _mode = 'tracked';
  var _configLoaded = false;

  /* Fetch the per-page tracking config once after auth resolves. We don't
   * subscribe to changes — a stale mode for the duration of one page
   * session is acceptable. */
  async function loadModeForSlug() {
    if (_configLoaded) return;
    var db = getDb();
    if (!db) return;
    try {
      var snap = await db.collection('labConfig').doc('pageTracking').get();
      _configLoaded = true;
      if (!snap.exists) return;
      var data = snap.data() || {};
      var modes = data.modes || {};
      var m = modes[_slug];
      if (m === 'never' || m === 'admin' || m === 'tracked') _mode = m;
    } catch (err) {
      console.warn('[page-time-tracker] pageTracking read failed:', err && err.message);
      _configLoaded = true;
    }
  }

  function shouldTrack() {
    if (SKIP_SLUGS[_slug]) return false;
    if (_mode === 'never') return false;
    if (typeof document === 'undefined') return false;
    if (document.hidden) return false;
    if (!getUid() || !getDb()) return false;
    return true;
  }

  /* Returns the (slug, label) pair this tab actually writes under. In
   * 'admin' mode the per-page slug is collapsed into the shared
   * 'admin-work' bucket so all admin-work pages aggregate into one
   * tracker entry per day. */
  function effectiveTarget() {
    if (_mode === 'admin') return { slug: 'admin-work', name: 'Admin work', kind: 'admin-work' };
    return { slug: _slug, name: _pageName, kind: 'page-time' };
  }

  /* Idempotent: arrayUnion on logged_windows dedupes if another tab beat
   * us to this window. Status stays 'pending' on first write; if user has
   * already confirmed/dismissed (status != 'pending') we leave the doc
   * untouched and remember not to write again today.
   *
   * V3.228 — write target depends on mode: 'admin' aggregates every
   * admin-marked page into one daily "Admin work" entry; 'tracked'
   * (default) writes per-page as before. */
  async function logActiveWindow(windowIdx, dateStr) {
    if (_writeInFlight) return;
    _writeInFlight = true;
    try {
      var uid = getUid();
      var db = getDb();
      if (!uid || !db) return;

      var target = effectiveTarget();
      var docId = 'auto-pagetime-' + target.slug + '-' + dateStr;
      var ref = db.collection('trackerEntries').doc(uid).collection('entries').doc(docId);

      // Read first to decide pending-vs-frozen + to recompute duration.
      var snap = await ref.get();
      var data = snap.exists ? snap.data() : null;

      if (data && data.status && data.status !== 'pending') {
        // User has confirmed or dismissed this entry — freeze for the day.
        _frozenForDate = dateStr;
        return;
      }

      var windows = (data && Array.isArray(data.logged_windows))
        ? data.logged_windows.slice() : [];
      if (windows.indexOf(windowIdx) >= 0) {
        // Already counted by another tab / another admin-work page.
        return;
      }
      windows.push(windowIdx);
      windows.sort(function (a, b) { return a - b; });

      // V3.319 — lightweight presence event: no status, no duration, no
      // hours estimate. logged_windows is kept only for cross-tab
      // window-level idempotency.
      var update = {
        date: dateStr,
        text: (target.kind === 'admin-work' ? 'Admin work' : 'Active on ' + target.name),
        categoryPath: (data && Array.isArray(data.categoryPath) && data.categoryPath.length)
          ? data.categoryPath : (target.kind === 'admin-work' ? ['admin'] : []),
        kind: 'work',
        source: 'rm-page-time',
        source_ref: {
          kind: target.kind,
          id:   target.slug,
          path: window.location.pathname,
        },
        scheduled_for: null,
        logged_windows: windows,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      if (data && data.status === 'pending') {
        // Upgrade a legacy pending doc in place — strip the hours-era
        // fields so old docs stop looking like they await confirmation.
        update.status = firebase.firestore.FieldValue.delete();
        update.duration = firebase.firestore.FieldValue.delete();
        update.auto_hours_estimate = firebase.firestore.FieldValue.delete();
        update.milestone = firebase.firestore.FieldValue.delete();
      }
      if (!snap.exists) {
        update.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      }
      await ref.set(update, { merge: true });
    } catch (err) {
      console.warn('[page-time-tracker] write failed:', err && err.message);
    } finally {
      _writeInFlight = false;
    }
  }

  function onActivity() {
    if (!shouldTrack()) return;
    var dateStr = todayStr();
    if (_frozenForDate && _frozenForDate === dateStr) return;

    var wi = currentWindowIdx();
    // Date rollover or new window: re-check freeze state via Firestore on write.
    if (dateStr !== _lastLoggedDate || wi !== _lastLoggedWindow) {
      _lastLoggedDate = dateStr;
      _lastLoggedWindow = wi;
      logActiveWindow(wi, dateStr);
    }
  }

  /* Throttle: collapse rapid events (typing, scrolling) into at most one
   * onActivity check per second. Cheap on the keyboard path; the real
   * dedupe happens at the (window-idx, doc) level. */
  var _throttleTimer = null;
  function throttledActivity() {
    if (_throttleTimer) return;
    _throttleTimer = setTimeout(function () {
      _throttleTimer = null;
      onActivity();
    }, 1000);
  }

  function installListeners() {
    if (SKIP_SLUGS[_slug]) return;
    // 'input' covers typing in contentEditable + form fields.
    // 'change' covers selects/checkboxes.
    // 'mousedown' + 'touchstart' cover clicks/taps.
    // 'wheel' covers scroll-reading (papers etc.) on desktop.
    // 'keydown' is a backstop for keyboard-only interactions.
    ['keydown', 'mousedown', 'touchstart', 'input', 'change', 'wheel']
      .forEach(function (evt) {
        document.addEventListener(evt, throttledActivity, { passive: true, capture: true });
      });

    // Visibilitychange: when the user comes back from another tab,
    // re-check immediately so we log the new window without waiting for
    // the next event.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) throttledActivity();
    });
  }

  function start() {
    if (SKIP_SLUGS[_slug]) return;
    if (typeof firebridge === 'undefined' || !firebridge.onAuth) {
      // Firebridge not loaded — skip silently.
      return;
    }
    installListeners();
    firebridge.onAuth(function (user, profile) {
      // Lab-member gate: only track for non-guest signed-in users. The
      // firestore.rules write is uid-scoped anyway; this check just
      // avoids guest reads being denied.
      if (!user || !user.uid) return;
      if (firebridge.isLabMember && !firebridge.isLabMember()) return;
      // V3.228 — fetch the admin's per-page tracking config once. If the
      // user races the fetch by interacting with the page, the first
      // events log under the default 'tracked' mode and any subsequent
      // events under the configured mode. We accept the brief seam over
      // adding a fetch-then-listen race.
      loadModeForSlug().then(function () {
        // Drive an onActivity tick so the current window logs as soon
        // as auth + config are settled, even with no user input yet.
        throttledActivity();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Public API (mainly for debugging from console).
  window.PageTimeTracker = {
    slug:           function () { return _slug; },
    pageName:       function () { return _pageName; },
    mode:           function () { return _mode; },
    currentWindow:  currentWindowIdx,
    flush:          throttledActivity,
  };
})();
