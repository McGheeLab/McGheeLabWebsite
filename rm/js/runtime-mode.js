/* runtime-mode.js — distinguishes the two RM runtimes:
 *
 *   "local"  — running via `python3 server.py` on localhost. Has access to
 *              /api/parse-receipts, /api/upload-sds, /api/calendar/outlook-events,
 *              /api/suggest-tasks, /api/category-explorer etc.
 *   "deploy" — static-served at mcgheelab.com/rm/. No /api/ endpoints exist.
 *              Features that depend on server.py must hide themselves; data
 *              still flows via Firestore through the api adapter.
 *
 * Sets <body data-runtime="local|deploy"> as early as possible. Pages can
 * use the CSS hook `body[data-runtime=deploy] .local-only { display: none }`
 * (already in css/style.css) to hide buttons that depend on server.py.
 *
 * Also exposes window.RM_RUNTIME = { mode, isLocal, isDeploy } so JS can
 * branch on it (e.g. don't even try to fetch /api/X when isDeploy).
 */
(function () {
  function detect() {
    if (typeof window === 'undefined') return 'local';
    var host = (window.location && window.location.hostname) || '';
    // localhost / 127.0.0.1 / 0.0.0.0 / *.local — treat as local server.py.
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return 'local';
    if (host.endsWith('.local')) return 'local';
    // Anything else (mcgheelab.com, github.io, custom domain) is the static deploy.
    return 'deploy';
  }

  var mode = detect();
  window.RM_RUNTIME = {
    mode: mode,
    isLocal: mode === 'local',
    isDeploy: mode === 'deploy',
  };

  function apply() {
    if (document.body) document.body.setAttribute('data-runtime', mode);
  }
  if (document.body) apply();
  else document.addEventListener('DOMContentLoaded', apply, { once: true });
})();
