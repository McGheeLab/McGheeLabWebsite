/* surface-guide.js — V3.535 (My Day program R10): "which surface for what".
 *
 * A one-line dismissible banner mounted at the top of the surfaces whose
 * roles shifted under the My Day program, so students know where each
 * kind of input belongs now. Dismissal is per-page, per-browser
 * (localStorage) — this is orientation, not chrome.
 *
 * Self-mounting: detects the page from location.pathname; pages just add
 * the script tag. No dependencies (renders before auth resolves — the
 * guidance isn't sensitive).
 */
(function () {
  'use strict';

  var GUIDES = {
    'huddle': 'The Huddle is the lab’s shared board — plan your own week in <a href="/rm/pages/my-day.html">☀️ My Day</a> and it posts here automatically.',
    'activity-overview': 'The Tracker is your review/analytics view — log what you’re doing in <a href="/rm/pages/my-day.html">☀️ My Day</a> and events land here on their own.',
    'tasks': 'This is the organizing workspace — day-to-day “what am I doing today” lives in <a href="/rm/pages/my-day.html">☀️ My Day</a>.',
    'lab-notebook': 'The notebook is the canonical record of what you did — My Day plans create entry stubs here; write your results into them.',
    'pmr': 'Weekly entries can be assembled from your notebook, tracker, tasks and My Day — use “⤓ Assemble” on a week instead of retyping.',
  };

  function slug() {
    var m = location.pathname.match(/\/rm\/pages\/([a-z0-9-]+)\.html/i);
    return m ? m[1] : null;
  }

  // In the Ourlab phone app the bottom tab bar already orients the user, so
  // these "which surface for what" notes are redundant clutter (Alex: not
  // needed on the task page). window.Capacitor is absent inside the shell's
  // iframe, so also detect the same-origin app-shell parent + the app body.
  function inOurlabApp() {
    try {
      if (window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()) return true;
      if (document.body && document.body.classList.contains('ourlab-app')) return true;
      if (window.parent && window.parent !== window && window.parent.document
          && window.parent.document.body
          && window.parent.document.body.getAttribute('data-app-shell') === '1') return true;
    } catch (e) {}
    return false;
  }

  function mount() {
    if (inOurlabApp()) return;
    var s = slug();
    var text = s && GUIDES[s];
    if (!text) return;
    var key = 'sg-dismissed-' + s;
    try { if (localStorage.getItem(key)) return; } catch (_) {}

    var bar = document.createElement('div');
    bar.setAttribute('role', 'note');
    bar.style.cssText = 'display:flex;align-items:center;gap:.6rem;max-width:1100px;margin:6px auto;' +
      'padding:.45rem .9rem;border:1px solid var(--border,#e1e4e8);border-radius:10px;' +
      'font-size:.85rem;color:var(--text-muted,#6b7280);background:var(--bg,#f5f6fa)';
    var span = document.createElement('span');
    span.style.flex = '1';
    span.innerHTML = 'ℹ️ ' + text;
    var x = document.createElement('button');
    x.type = 'button';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Dismiss');
    x.style.cssText = 'border:none;background:transparent;cursor:pointer;opacity:.6;font-size:.9rem';
    x.addEventListener('click', function () {
      bar.remove();
      try { localStorage.setItem(key, '1'); } catch (_) {}
    });
    bar.appendChild(span);
    bar.appendChild(x);

    var page = document.querySelector('.page') || document.body;
    page.insertBefore(bar, page.firstChild);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
