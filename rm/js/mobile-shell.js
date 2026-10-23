/* mobile-shell.js — Ourlab app bottom bar (V3.565, m-v0.1).
 *
 * V3.847 — the bar is ONE round ☰ button. Tap it and the person's quick links
 * fan out around it: Scan a label first (fixed), then the pages they chose
 * (More → Customize quick links, up to MAX_TABS), then More (fixed). There is
 * no row of tabs any more and nothing is "active". Alex: "the bottom of the
 * page tool button should replace all of the quick page links… a hamburger
 * icon… all of the pages the user has selected as quick links should fan out."
 *
 * Runs ONLY inside the Capacitor shell (the OurlabMobile sibling repo bundles
 * rm/ into its webDir and injects this script into every page at build time;
 * the production website never references it, and even if it did, the gate
 * below makes it a no-op in ordinary browsers). Dev preview in a normal
 * browser: append ?mobileShell=1 (persists for the session via sessionStorage).
 *
 * The choice of quick links lives in localStorage (read synchronously at mount)
 * and is mirrored to userData/{uid}/prefs/mobileTabs so it follows the person
 * across phones. A page with a native webview (TabKey in TabRoute.swift)
 * switches with OurlabTabs.switchTo; any other opens in the shell's misc
 * webview via OurlabTabs.open.
 *
 * Deliberately framework-free and dependency-free (loads before/without
 * firebridge): links are plain page navigations — state lives in Firestore,
 * exactly like the web app. Self-injecting CSS follows the icon-picker.js
 * pattern.
 */
(function () {
  'use strict';

  /* ── every page the app can offer as a quick link ─────────────────────
   * `native: true` = one of the warm top-level webviews in TabRoute.swift
   * (KEEP THOSE SIX IN LOCKSTEP with TabRoute.swift + tab-lifecycle.js
   * selfCheck); the rest open in the shell's misc webview. */
  var CATALOG = [
    // V3.638 — my-day.html was renamed my-week.html; the match covers both so
    // the retired path's redirect stub still resolves.
    { key: 'myday',       icon: 'sun',                     label: 'My Week',   href: '/rm/pages/my-week.html',        match: /\/my-(day|week)\.html$/,      native: true },
    { key: 'focus',       icon: 'target',                  label: 'Focus',     href: '/rm/pages/team-focus.html',     match: /\/team-focus\.html$/,         native: true },
    { key: 'chat',        icon: 'chat-bubble-left-right',  label: 'Chat',      href: '/rm/pages/chat.html',           match: /\/chat\.html$/,               native: true },
    { key: 'tasks',       icon: 'check-circle',            label: 'Tasks',     href: '/rm/pages/tasks.html',          match: /\/tasks[a-z-]*\.html$/,       native: true },
    // V3.613 — the whole library* family (the mobile reader included).
    { key: 'library',     icon: 'books',                   label: 'Library',   href: '/rm/pages/library-mobile.html', match: /\/library[a-z-]*\.html$/,     native: true },
    // V3.835 — Inventory: QR labels on every item; V3.840 scan → dial.
    { key: 'inventory',   icon: 'archive-box',             label: 'Inventory', href: '/rm/pages/inventory.html',      match: /\/inventory[a-z-]*\.html$/,   native: true },
    // V3.844 — the scan tool and the person's actions are pages too
    { key: 'scan',        icon: 'camera',                  label: 'Scan',      href: '/rm/pages/scan.html',           match: /\/scan\.html$/ },
    { key: 'actions',     icon: 'bolt',                    label: 'Actions',   href: '/rm/pages/actions.html',        match: /\/actions\.html$/ },
    { key: 'notebook',    icon: 'book-open',               label: 'Notebook',  href: '/rm/pages/notebook.html',       match: /\/notebook[a-z-]*\.html$/ },
    { key: 'scheduler',   icon: 'calendar-days',           label: 'Scheduler', href: '/rm/pages/scheduler.html',      match: /\/scheduler\.html$/ },
    { key: 'research',    icon: 'microscope',              label: 'Research',  href: '/rm/pages/research.html',       match: /\/research\.html$/ },
    { key: 'meetings',    icon: 'user-group',              label: 'Meetings',  href: '/rm/pages/meetings.html',       match: /\/meetings\.html$/ },
    { key: 'protocols',   icon: 'clipboard-document-list', label: 'Protocols', href: '/rm/pages/protocols.html',      match: /\/protocols[a-z-]*\.html$/ },
    { key: 'procurement', icon: 'shopping-cart',           label: 'Buying',    href: '/rm/pages/procurement.html',    match: /\/procurement\.html$/ },
    { key: 'equipment',   icon: 'beaker',                  label: 'Equipment', href: '/rm/pages/equipment.html',      match: /\/equipment[a-z-]*\.html$/ },
    { key: 'pmr',         icon: 'clipboard-document-list', label: 'PMR',       href: '/rm/pages/pmr.html',            match: /\/pmr\.html$/ },
    { key: 'settings',    icon: 'cog-6-tooth',             label: 'Settings',  href: '/rm/pages/settings.html',       match: /\/settings\.html$/ },
  ];
  // V3.847 — up to eight quick links; the fan also carries Scan and More (fixed), ten at most.
  var DEFAULT_KEYS = ['myday', 'focus', 'chat', 'tasks', 'library', 'inventory'];
  var MAX_TABS = 8;
  var SCAN_TOOL = { key: 'scan', icon: 'camera', label: 'Scan a label', href: '/rm/pages/scan.html', fresh: true, fixed: true };
  var MORE_TOOL = { key: 'more', icon: 'ellipsis-horizontal', label: 'More', more: true, fixed: true };
  function catalogByKey(k) { for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i].key === k) return CATALOG[i]; return null; }
  /** A saved list → a valid one: known keys only, no repeats, at most MAX_TABS; empty → the default. */
  function normalizeKeys(keys) {
    var out = [];
    (Array.isArray(keys) ? keys : []).forEach(function (k) {
      if (k !== 'scan' && catalogByKey(k) && out.indexOf(k) < 0 && out.length < MAX_TABS) out.push(k);   // Scan is always in the fan
    });
    return out.length ? out : DEFAULT_KEYS.slice();
  }
  /** What the ☰ fans out: Scan, the chosen pages (a chosen Scan is not doubled), More. */
  function fanItems(keys) {
    var pages = normalizeKeys(keys).map(catalogByKey).filter(Boolean);
    return [SCAN_TOOL].concat(pages).concat([MORE_TOOL]);
  }
  /**
   * Where n items go: [{ ring, deg }] — one arc (160° → 20°) up to four items,
   * two arcs beyond that (the first four inner, the rest outer, 150° → 30°).
   */
  function ringLayout(n) {
    var out = [];
    if (!(n > 0)) return out;
    var inner = n <= 4 ? n : 4, outer = n - inner;
    var spread = function (count, from, to, ring) {
      for (var i = 0; i < count; i++) out.push({ ring: ring, deg: count === 1 ? 90 : from - i * ((from - to) / (count - 1)) });
    };
    spread(inner, 160, 20, 1);
    if (outer > 0) spread(outer, 150, 30, 2);
    return out;
  }
  var TABS_CORE = { CATALOG: CATALOG, DEFAULT_KEYS: DEFAULT_KEYS, MAX_TABS: MAX_TABS, SCAN_TOOL: SCAN_TOOL, MORE_TOOL: MORE_TOOL,
                    normalizeKeys: normalizeKeys, byKey: catalogByKey, fanItems: fanItems, ringLayout: ringLayout };
  if (typeof module !== 'undefined' && module.exports) module.exports = TABS_CORE;

  function isApp() {
    try {
      if (window.Capacitor && typeof Capacitor.isNativePlatform === 'function'
          && Capacitor.isNativePlatform()) return true;
      if (/[?&]mobileShell=1/.test(location.search)) {
        sessionStorage.setItem('ourlab-shell-preview', '1');
        return true;
      }
      if (sessionStorage.getItem('ourlab-shell-preview') === '1') return true;
      // Hosted as a tab INSIDE the Ourlab app shell (app-shell.html). window
      // .Capacitor is NOT injected into iframes, so a tab page can't see the
      // native platform directly — detect the same-origin shell parent instead
      // (its <body data-app-shell="1">). Without this, mobile-shell would treat
      // the iframe as a plain web page (nav not hidden, app UX off).
      if (window.parent && window.parent !== window && window.parent.document
          && window.parent.document.body
          && window.parent.document.body.getAttribute('data-app-shell') === '1') return true;
      return false;
    } catch (e) { return false; }
  }
  if (!isApp()) return;

  /* V3.586 — m-v0.3 multi-WebView shell plugin (OurlabTabs). Present only in
   * the native iOS app when the TabShellViewController registered it; null on
   * web, Android, and the ?mobileShell=1 browser preview (gated on
   * isNativePlatform, NOT isApp(), so the preview keeps plain anchor
   * navigation). Every call site falls back to normal navigation. */
  function tabsPlugin() {
    try {
      return (window.Capacitor && typeof Capacitor.isNativePlatform === 'function'
        && Capacitor.isNativePlatform()
        && Capacitor.Plugins && Capacitor.Plugins.OurlabTabs) || null;
    } catch (e) { return null; }
  }

  // EMBED mode: when this page is a tab hosted inside the persistent app
  // shell (app-shell.html) — i.e. we're in an iframe or carry ?embed=1 /
  // window.name rm-embed|rm-shell — the shell owns ALL app chrome (top bar,
  // bottom bar, auth gate). nav.js already hides the page's own top-nav
  // in embed mode; mobile-shell must add NOTHING here, or every tab iframe
  // would render its own duplicate bar + auth gate. Bail out early.
  function isEmbedded() {
    try {
      if (window.top !== window.self) return true;
      if (/[?&]embed=1/.test(location.search)) return true;
      if (typeof window.name === 'string' && /^rm-(embed|shell)/.test(window.name)) return true;
    } catch (e) { /* cross-origin top access → we're framed */ return true; }
    return false;
  }
  if (isEmbedded()) {
    // A tab hosted in the app shell. The shell owns the top bar + bar +
    // auth gate, so render NONE of that here. We only need to (a) hide the
    // page's own top nav / sync indicator + drop its top padding, and (b) mark
    // the page as running in the app so its app-gated UX (My Week composer FAB,
    // Tasks/Team-Focus/Task-Market fold-ups, Chat app layout — the V3.567–571
    // work) turns on. We deliberately do this with CSS + a body class rather
    // than ?embed=1 / window.name, because the pages' split-view "embed" mode
    // SUPPRESSES features (e.g. chat stops loading messages, scheduler breaks)
    // — that mode is for narrow preview panes, not a full-screen app tab.
    try {
      var es = document.createElement('style');
      es.textContent =
        '.top-nav,.workflow-strip,#firebridge-indicator{display:none !important;}' +
        'body{padding-top:0 !important;}';
      (document.head || document.documentElement).appendChild(es);
    } catch (e) { /* head not ready — rare */ }
    var _addApp = function () { try { document.body.classList.add('ourlab-app'); } catch (e) {} };
    if (document.body) _addApp(); else document.addEventListener('DOMContentLoaded', _addApp);
    return;
  }

  /* ── V3.840 — the person's quick-link list ───────────────────────────
   * localStorage is the synchronous source; the cloud doc follows them across
   * phones. `dirty` = saved here but not yet in the cloud (offline, or saved
   * before auth resolved) — pushed on the next onAuth; otherwise a differing
   * cloud list is adopted. The app's warm webviews share localStorage, so a
   * change made in one reaches the others the next time their fan opens. */
  var PREFS_KEY = 'ourlab-tabs.v1';
  function readPrefs() {
    try {
      var o = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
      if (o && Array.isArray(o.keys)) return { keys: normalizeKeys(o.keys), dirty: !!o.dirty, at: o.at || 0, saved: true };
    } catch (e) {}
    return { keys: DEFAULT_KEYS.slice(), dirty: false, at: 0, saved: false };
  }
  function writePrefs(keys, dirty) {
    var p = { keys: normalizeKeys(keys), dirty: !!dirty, at: Date.now() };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {}
    return p;
  }
  var _keys = readPrefs().keys;   // the quick links
  function tabs() { return _keys.map(catalogByKey).filter(Boolean); }
  function moreLinks() { return CATALOG.filter(function (t) { return _keys.indexOf(t.key) < 0 && t.key !== 'scan'; }); }

  function cloudRef() {
    // firebridge is a lexical const (bare global) — window.firebridge is
    // ALWAYS undefined (window.firebridge dead-checks memory).
    var fb = (typeof firebridge !== 'undefined') ? firebridge : null;
    var u = fb && fb.getUser && fb.getUser();
    if (!u || !fb.db) return null;
    try { return fb.db().collection('userData').doc(u.uid).collection('prefs').doc('mobileTabs'); } catch (e) { return null; }
  }
  function pushCloud(keys) {
    var ref = cloudRef(); if (!ref) return Promise.resolve(false);
    return ref.set({ keys: keys, updatedAt: new Date().toISOString() }, { merge: true })
      .then(function () { writePrefs(keys, false); return true; })
      .catch(function () { return false; });
  }
  function syncCloud() {
    var ref = cloudRef(); if (!ref) return;
    var local = readPrefs();
    if (local.dirty) { pushCloud(local.keys); return; }
    ref.get().then(function (snap) {
      if (!snap || !snap.exists) return;
      var cloud = normalizeKeys((snap.data() || {}).keys);
      if (cloud.join(',') !== local.keys.join(',')) { writePrefs(cloud, false); applyKeys(cloud); }
    }).catch(function () {});
  }
  function savePrefs(keys) {
    var p = writePrefs(keys, true);
    applyKeys(p.keys);
    pushCloud(p.keys);
    return p.keys;
  }
  function applyKeys(keys) {
    _keys = normalizeKeys(keys);
    closeFan();
  }

  var CSS =
    '.ourlab-tabbar{position:fixed;left:0;right:0;bottom:0;z-index:9000;' +
      'display:flex;justify-content:center;align-items:center;height:64px;background:var(--card,#fff);border-top:1px solid var(--border,#e2e8f0);' +
      'padding-bottom:env(safe-area-inset-bottom,0px);box-sizing:content-box;' +
      'box-shadow:0 -2px 12px rgba(0,0,0,.06);}' +
    /* V3.847 — the one button: a neutral ☰ that becomes an × while the fan is out */
    '.ourlab-menu{width:56px;height:56px;border-radius:50%;border:1px solid var(--border,#e2e8f0);background:var(--card,#fff);' +
      'color:var(--text,#0f172a);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.14);-webkit-tap-highlight-color:transparent;transition:transform .15s ease;}' +
    '.ourlab-menu:active{transform:scale(.94);}' +
    '.ourlab-menu svg{width:28px;height:28px;display:block;}' +
    '.ourlab-menu .om-x{display:none;}' +
    '.ourlab-menu.on .om-bars{display:none;}.ourlab-menu.on .om-x{display:block;}' +
    '.ourlab-menu.on{background:var(--text,#0f172a);color:#fff;border-color:var(--text,#0f172a);}' +
    /* the fan */
    '.ourlab-fan-back{position:fixed;inset:0;z-index:9400;background:rgba(15,23,42,.42);}' +
    '.ourlab-fan-tool{position:fixed;z-index:9401;width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;' +
      'background:var(--card,#fff);color:var(--primary,#2563eb);display:flex;align-items:center;justify-content:center;' +
      'box-shadow:0 6px 18px rgba(0,0,0,.28);animation:ourlab-fan-in .18s ease-out backwards;-webkit-tap-highlight-color:transparent;}' +
    '.ourlab-fan-tool svg{width:28px;height:28px;}' +
    '.ourlab-fan-tool.is-fixed{color:var(--text,#0f172a);}' +
    '.ourlab-fan-tool:active{transform:scale(.94);}' +
    '.ourlab-fan-lbl{position:fixed;z-index:9401;width:90px;margin-left:-15px;text-align:center;font-size:11px;font-weight:700;color:#fff;' +
      'text-shadow:0 1px 2px rgba(0,0,0,.6);pointer-events:none;animation:ourlab-fan-in .18s ease-out backwards;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '@keyframes ourlab-fan-in{from{opacity:0;transform:scale(.5);}to{opacity:1;transform:none;}}' +
    /* More sheet */
    '.ourlab-sheet-back{position:fixed;inset:0;z-index:9500;background:rgba(15,23,42,.45);' +
      'display:flex;flex-direction:column;justify-content:flex-end;}' +
    '.ourlab-sheet{background:var(--card,#fff);border-radius:18px 18px 0 0;' +
      'padding:8px 0 calc(12px + env(safe-area-inset-bottom,0px));' +
      'max-height:80vh;overflow-y:auto;animation:ourlab-sheet-up .2s ease;}' +
    '@keyframes ourlab-sheet-up{from{transform:translateY(100%);}to{transform:translateY(0);}}' +
    '.ourlab-sheet-grip{width:38px;height:4px;border-radius:2px;background:var(--border,#e2e8f0);' +
      'margin:6px auto 4px;}' +
    '.ourlab-sheet-user{display:flex;align-items:center;gap:12px;padding:10px 20px 14px;' +
      'border-bottom:1px solid var(--border,#e2e8f0);margin-bottom:6px;}' +
    '.ourlab-sheet-av{width:40px;height:40px;border-radius:50%;background:var(--primary,#2563eb);' +
      'color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;}' +
    '.ourlab-sheet-name{font-weight:700;color:var(--text,#0f172a);}' +
    '.ourlab-sheet-email{font-size:12px;color:var(--text-muted,#64748b);}' +
    '.ourlab-sheet-item{display:flex;align-items:center;gap:14px;width:100%;text-align:left;' +
      'padding:14px 20px;border:none;background:transparent;cursor:pointer;text-decoration:none;' +
      'font-size:16px;color:var(--text,#0f172a);}' +
    '.ourlab-sheet-item:active{background:var(--bg,#f1f5f9);}' +
    '.ourlab-sheet-item .osi-icon{font-size:22px;width:26px;display:inline-flex;align-items:center;justify-content:center;}' +
    '.ourlab-sheet-customize{border-top:1px solid var(--border,#e2e8f0);margin-top:6px;color:var(--primary,#2563eb);font-weight:600;}' +
    '.ourlab-sheet-signout{color:#dc2626;font-weight:600;border-top:1px solid var(--border,#e2e8f0);margin-top:6px;}' +
    /* V3.840 — Customize quick links sheet */
    '.ourlab-cz{padding-left:16px;padding-right:16px;}' +
    '.ourlab-cz-head{display:flex;align-items:center;justify-content:space-between;padding:6px 4px 2px;font-size:16px;color:var(--text,#0f172a);}' +
    '.ourlab-cz-count{font-size:13px;color:var(--text-muted,#64748b);font-weight:600;}' +
    '.ourlab-cz-hint{font-size:12.5px;color:var(--text-muted,#64748b);padding:0 4px 10px;}' +
    '.ourlab-cz-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 4px;border-top:1px solid var(--border,#e2e8f0);}' +
    '.ourlab-cz-row.on{background:transparent;}' +
    '.ourlab-cz-main{display:flex;align-items:center;gap:12px;flex:1;min-width:0;font-size:16px;color:var(--text,#0f172a);cursor:pointer;}' +
    '.ourlab-cz-main input{width:22px;height:22px;margin:0;flex:0 0 22px;}' +
    '.ourlab-cz-main .osi-icon{width:26px;display:inline-flex;justify-content:center;font-size:20px;}' +
    '.ourlab-cz-order{display:flex;gap:4px;}' +
    '.ourlab-cz-order button{width:38px;height:34px;border-radius:8px;border:1px solid var(--border,#e2e8f0);background:var(--bg,#f1f5f9);color:var(--text,#0f172a);font-size:13px;cursor:pointer;}' +
    '.ourlab-cz-order button:disabled{opacity:.35;}' +
    '.ourlab-cz-sep{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted,#64748b);padding:12px 4px 4px;}' +
    '.ourlab-cz-actions{display:flex;gap:10px;justify-content:flex-end;padding:14px 4px 4px;}' +
    '.ourlab-cz-actions button{min-height:44px;padding:0 18px;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;}' +
    '.ourlab-cz-reset{border:1px solid var(--border,#e2e8f0);background:var(--bg,#f1f5f9);color:var(--text,#0f172a);}' +
    '.ourlab-cz-save{border:none;background:var(--primary,#2563eb);color:#fff;}' +
    '.ourlab-cz-save:disabled{opacity:.4;}' +
    /* app-wide: drop the RM nav's Workflows / All Pages / Split / My
       Workflows buttons — the ☰ is the nav in the app */
    'body.ourlab-app .nav-app-hide{display:none !important;}' +
    'body.ourlab-app{padding-bottom:calc(72px + env(safe-area-inset-bottom,0px)) !important;}' +
    /* pages with their own bottom-fixed chrome (My Week composer) sit above the bar */
    'body.ourlab-app .md-composer{bottom:calc(64px + env(safe-area-inset-bottom,0px));}' +
    /* voice-call panel (V3.584) floats above the bar, not under it */
    'body.ourlab-app #vc-panel{bottom:calc(80px + env(safe-area-inset-bottom,0px));}' +
    /* The RM top nav (McGhee Lab · sync status · avatar) is pinned FIXED to
       the very top on every app page — always in place, content scrolls
       under it (like the bottom bar). Its background fills the status
       bar / Dynamic Island inset; content sits below the notch. */
    'body.ourlab-app .top-nav,body.ourlab-app .workflow-strip{' +
      'position:fixed;top:0;left:0;right:0;z-index:8000;}' +
    'body.ourlab-app .top-nav{height:auto;min-height:56px;padding-top:env(safe-area-inset-top,0px);}' +
    'body.ourlab-app .workflow-strip{padding-top:calc(10px + env(safe-area-inset-top,0px));}' +
    /* reserve space so page content clears the fixed nav (added by the
       poll below only when a nav is actually present + visible). */
    'body.ourlab-app.ourlab-has-nav{padding-top:calc(56px + env(safe-area-inset-top,0px));}' +
    /* tighten the page header: .page-title and .page-header each carry a
       20px bottom margin that doubles into a big gap before the page's own
       tabs (e.g. My Week Day/Week/Month) — collapse to one small gap. */
    'body.ourlab-app .page-header{margin-bottom:8px;}' +
    'body.ourlab-app .page-title{margin-bottom:0;}' +
    'body.ourlab-app.ourlab-no-nav{padding-top:env(safe-area-inset-top,0px);}' +
    /* full-screen sign-in / loading overlay — the app shows NOTHING but
       this until a user is authenticated (covers the bar + any page's
       own sign-in card). */
    /* brand "Deep Well" navy gradient — matches the native splash screen
       (assets/logo.png on #0A1730) so cold-launch → sign-in is seamless. */
    '.ourlab-auth{position:fixed;inset:0;z-index:99998;' +
      'background:linear-gradient(160deg,#123058 0%,#0A1730 100%);' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'padding:32px;padding-top:calc(32px + env(safe-area-inset-top,0px));' +
      'padding-bottom:calc(32px + env(safe-area-inset-bottom,0px));}' +
    '.ourlab-auth-inner{width:100%;max-width:360px;text-align:center;color:#fff;}' +
    '.ourlab-auth-logo{line-height:0;margin-bottom:16px;}' +
    '.ourlab-mark{width:76px;height:76px;display:block;margin:0 auto;}' +
    '.ourlab-auth-title{font-size:26px;font-weight:800;margin:0 0 6px;letter-spacing:-.01em;}' +
    '.ourlab-auth-sub{font-size:15px;color:rgba(255,255,255,.82);margin:0 0 26px;}' +
    '.ourlab-auth-field{display:block;text-align:left;margin:0 0 16px;}' +
    '.ourlab-auth-flabel{display:block;font-size:11px;font-weight:700;text-transform:uppercase;' +
      'letter-spacing:.06em;color:rgba(255,255,255,.66);margin:0 0 6px;}' +
    '.ourlab-auth-field input{width:100%;box-sizing:border-box;padding:14px 16px;border:1px solid rgba(255,255,255,.16);' +
      'border-radius:12px;font-size:16px;background:rgba(255,255,255,.12);color:#fff;}' +
    '.ourlab-auth-field input::placeholder{color:rgba(255,255,255,.45);}' +
    '.ourlab-auth-field input:focus{outline:none;border-color:rgba(61,125,246,.9);background:rgba(255,255,255,.16);}' +
    '.ourlab-auth-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;' +
      'padding:15px 18px;border:none;border-radius:12px;background:#fff;color:#1f2937;' +
      'font-size:16px;font-weight:700;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.25);}' +
    '.ourlab-auth-btn:active{transform:scale(.98);}' +
    '.ourlab-auth-btn:disabled{opacity:.6;}' +
    '.ourlab-auth-g{width:20px;height:20px;flex:0 0 20px;}' +
    '.ourlab-auth-status{margin-top:16px;font-size:13px;color:rgba(255,255,255,.78);min-height:18px;}' +
    '.ourlab-auth-spinner{width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.3);' +
      'border-top-color:#fff;animation:ourlab-spin .8s linear infinite;margin:0 auto 4px;}' +
    '@keyframes ourlab-spin{to{transform:rotate(360deg);}}';

  // icons.js has no hamburger; the two marks are inline.
  var BARS_SVG = '<svg class="om-bars" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  var X_SVG = '<svg class="om-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  /** The catalog page this webview is showing, if any (kept for callers; nothing is highlighted). */
  function activeKey() {
    var p = location.pathname;
    for (var i = 0; i < CATALOG.length; i++) {
      if (CATALOG[i].match.test(p)) return CATALOG[i].key;
    }
    return '';
  }

  function barHtml() {
    return '<button type="button" class="ourlab-menu" data-menu="1" aria-label="Menu" aria-haspopup="true" aria-expanded="false">' + BARS_SVG + X_SVG + '</button>';
  }

  /** Go to a catalog page the app way: native webview swap, misc webview, or a plain navigation. */
  function goTo(t) {
    var href = t.fresh ? t.href + '?t=' + Date.now().toString(36) : t.href;
    var T = tabsPlugin();
    if (!T) { location.href = href; return; }
    var p = (t.native && !t.fresh) ? T.switchTo({ key: t.key }) : T.open({ href: href });
    p.catch(function () { location.href = href; });
  }

  /* ── V3.847 — the fan: Scan, the quick links, More — on one or two arcs above the ☰ ── */
  function closeFan() {
    document.querySelectorAll('.ourlab-fan-back,.ourlab-fan-tool,.ourlab-fan-lbl').forEach(function (n) { n.remove(); });
    var b = document.querySelector('.ourlab-menu');
    if (b) { b.classList.remove('on'); b.setAttribute('aria-expanded', 'false'); }
  }
  function openFan() {
    if (document.querySelector('.ourlab-fan-back')) { closeFan(); return; }
    var btn = document.querySelector('.ourlab-menu'); if (!btn) return;
    _keys = readPrefs().keys;   // another webview may have saved a new list
    var items = fanItems(_keys);
    var r = btn.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var back = document.createElement('div'); back.className = 'ourlab-fan-back';
    back.addEventListener('click', closeFan);
    document.body.appendChild(back);
    // radii scaled so the outer arc's ends stay inside a narrow phone (60 px circles)
    var scale = Math.min(1, (window.innerWidth / 2 - 42) / (182 * Math.cos(30 * Math.PI / 180)));
    var R = { 1: Math.round(96 * scale), 2: Math.round(182 * scale) };
    var spots = ringLayout(items.length);
    items.forEach(function (t, i) {
      var s = spots[i], a = s.deg * Math.PI / 180;
      var x = cx + R[s.ring] * Math.cos(a), y = cy - R[s.ring] * Math.sin(a) - 22;
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ourlab-fan-tool' + (t.fixed ? ' is-fixed' : ''); b.setAttribute('data-tool', t.key); b.setAttribute('aria-label', t.label);
      b.style.left = Math.round(x - 30) + 'px'; b.style.top = Math.round(y - 30) + 'px'; b.style.animationDelay = (i * 25) + 'ms';
      b.innerHTML = ICON.svg(t.icon, { variant: 'outline' });
      b.addEventListener('click', function (ev) {
        ev.preventDefault(); closeFan();
        if (t.more) openMoreSheet(); else goTo(t);
      });
      var l = document.createElement('div'); l.className = 'ourlab-fan-lbl'; l.textContent = t.label;
      l.style.left = Math.round(x - 30) + 'px'; l.style.top = Math.round(y + 34) + 'px'; l.style.animationDelay = (i * 25) + 'ms';
      document.body.appendChild(b); document.body.appendChild(l);
    });
    btn.classList.add('on'); btn.setAttribute('aria-expanded', 'true');
  }

  function mount() {
    if (document.querySelector('.ourlab-tabbar')) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // env(safe-area-inset-*) is 0 unless the viewport declares
    // viewport-fit=cover — patch the meta in place (WKWebView re-evaluates).
    var vp = document.querySelector('meta[name="viewport"]');
    if (vp && vp.content.indexOf('viewport-fit') < 0) {
      vp.content += ', viewport-fit=cover';
    }
    // Top safe-area handling. The fixed top nav (.top-nav, prepended by
    // nav.js after firebridge auth resolves, or the .workflow-strip in shell
    // mode) is taken out of flow, so the body must reserve space for it via
    // `ourlab-has-nav`. nav.js mounts the nav LATER than a single snapshot,
    // so poll until it appears + is visible (a chat-style page hides its
    // .top-nav with display:none — getClientRects()==0 — and manages its own
    // top chrome, so it must NOT get the reserve). Fall back to just the
    // status-bar inset if no nav shows up after ~3s.
    function _navVisible() {
      var els = document.querySelectorAll('.top-nav, .workflow-strip');
      for (var i = 0; i < els.length; i++) {
        if (els[i].getClientRects().length > 0) return true;
      }
      return false;
    }
    var _navTries = 0;
    (function pollNav() {
      if (_navVisible()) {
        document.body.classList.add('ourlab-has-nav');
        document.body.classList.remove('ourlab-no-nav');
        return;
      }
      if (_navTries++ > 30) { document.body.classList.add('ourlab-no-nav'); return; }
      setTimeout(pollNav, 100);
    })();

    var bar = document.createElement('nav');
    bar.className = 'ourlab-tabbar';
    bar.setAttribute('aria-label', 'App menu');
    bar.innerHTML = barHtml();

    bar.addEventListener('click', function (ev) {
      // haptic tick
      try {
        var H = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Haptics;
        if (H && H.impact) H.impact({ style: 'LIGHT' });
      } catch (e) { /* haptics are garnish */ }
      if (ev.target.closest('[data-menu]')) { ev.preventDefault(); openFan(); }
    });

    document.body.classList.add('ourlab-app');
    document.body.appendChild(bar);

    // Another webview may have saved a new list (shared localStorage); the fan
    // re-reads it when it opens. Close a stale fan when this view comes back.
    document.addEventListener('ourlab:tab-visible', function () { _keys = readPrefs().keys; closeFan(); });

    // Hide the iOS keyboard accessory bar (the ⌃ ⌄ ✓ toolbar above the
    // keyboard) — we provide our own composer controls instead.
    try {
      var K = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Keyboard;
      if (K && K.setAccessoryBarVisible) K.setAccessoryBarVisible({ isVisible: false });
    } catch (e) { /* plugin optional */ }

    // Gate the whole app behind auth: show nothing but a full-screen
    // sign-in / loading overlay until a user is signed in.
    ensureAuthGate();
  }

  /* ── Full-screen auth gate ──
   * The phone app never shows page chrome to a signed-out user — a
   * loading splash covers everything on boot, swaps to a Google sign-in
   * screen if auth resolves to signed-out, and is removed the moment a
   * user is present. Guests (signed in, not yet a lab member) fall through
   * to firebridge's own pending-access overlay (z-index 99999, above this
   * one). */
  // The Ourlab mark (brand/ourlab-mark.svg) — the O drawn as a microwell,
  // turned 90° CCW so the well opens downward and the microfluidic inlet reads
  // as an "L": the channel is the L's stem rising into the amber sample
  // droplet, with a short foot at the base. Inlined (transparent) so the
  // sign-in screen matches the native splash / app icon. Keep in sync with
  // brand/ourlab-mark.svg (OurlabMobile) + brand/ourlab-icon.svg.
  var OURLAB_MARK_SVG =
    '<svg class="ourlab-mark" viewBox="0 0 240 240" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
      '<defs><linearGradient id="ourlab-flow" gradientUnits="userSpaceOnUse" x1="120" y1="194" x2="162" y2="57">' +
        '<stop offset="0" stop-color="#3D7DF6"/><stop offset="1" stop-color="#2CD4F0"/></linearGradient></defs>' +
      '<g fill="none" stroke="url(#ourlab-flow)" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M152 199 H116 V113"/><path d="M153 143 A58 58 0 1 0 78 143"/></g>' +
      '<circle cx="116" cy="95" r="23" fill="#FFB547"/>' +
    '</svg>';

  var GOOGLE_G_SVG =
    '<svg class="ourlab-auth-g" viewBox="0 0 48 48" aria-hidden="true">' +
      '<path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/>' +
      '<path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>' +
      '<path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"/>' +
      '<path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"/>' +
    '</svg>';

  function showAuthOverlay(mode) {
    var ov = document.getElementById('ourlab-auth');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'ourlab-auth';
      ov.className = 'ourlab-auth';
      document.body.appendChild(ov);
    }
    if (mode === 'loading') {
      ov.innerHTML =
        '<div class="ourlab-auth-inner">' +
          '<div class="ourlab-auth-logo">' + OURLAB_MARK_SVG + '</div>' +
          '<div class="ourlab-auth-spinner"></div>' +
          '<div class="ourlab-auth-status">Loading…</div>' +
        '</div>';
      return;
    }
    // Each lab is a separate Ourlab workspace; McGheeLab is the first. The
    // login captures which lab group the user is signing in to (remembered).
    var labgroup = getLabGroup();
    ov.innerHTML =
      '<div class="ourlab-auth-inner">' +
        '<div class="ourlab-auth-logo">' + OURLAB_MARK_SVG + '</div>' +
        '<h1 class="ourlab-auth-title">Ourlab</h1>' +
        '<p class="ourlab-auth-sub">Sign in to your lab workspace</p>' +
        '<label class="ourlab-auth-field">' +
          '<span class="ourlab-auth-flabel">Lab group</span>' +
          '<input id="ourlab-auth-labgroup" type="text" autocapitalize="none" autocorrect="off" ' +
            'spellcheck="false" value="' + esc(labgroup) + '" placeholder="e.g. McGheeLab">' +
        '</label>' +
        '<button type="button" class="ourlab-auth-btn" id="ourlab-auth-google">' +
          GOOGLE_G_SVG + '<span>Sign in with Google</span>' +
        '</button>' +
        '<div class="ourlab-auth-status" id="ourlab-auth-status"></div>' +
      '</div>';
    var btn = document.getElementById('ourlab-auth-google');
    if (btn) btn.onclick = function () {
      var st = document.getElementById('ourlab-auth-status');
      // Capture + remember the lab group the user is joining before auth.
      var lgEl = document.getElementById('ourlab-auth-labgroup');
      var lg = (lgEl && lgEl.value || '').trim();
      if (!lg) { if (st) st.textContent = 'Enter your lab group.'; if (lgEl) lgEl.focus(); return; }
      setLabGroup(lg);
      btn.disabled = true;
      if (st) st.textContent = 'Opening Google…';
      try {
        // NOTE: firebridge is a lexical const (bare global), NOT
        // window.firebridge (which is always undefined — see the
        // window.firebridge dead-checks memory).
        var p = (typeof firebridge !== 'undefined') && firebridge.signInWithGoogle && firebridge.signInWithGoogle();
        if (p && p.then) {
          p.then(function () {
            // onAuth removes this webview's overlay on success. V3.586 —
            // m-v0.3: the OTHER warm webviews can't see the new session
            // (auth doesn't broadcast across webviews) — reload them so they
            // boot against the shared, now-signed-in auth IndexedDB. Called
            // ONLY here and in the sign-out path (never from onAuth) — no
            // reload loops.
            var T = tabsPlugin();
            if (T) T.reloadAll().catch(function () {});
          })
           .catch(function (err) {
             btn.disabled = false;
             if (st) st.textContent = (err && err.message) ? err.message : 'Sign-in failed — try again.';
           });
        } else {
          btn.disabled = false;
        }
      } catch (e) {
        btn.disabled = false;
        if (st) st.textContent = 'Sign-in failed — try again.';
      }
    };
  }

  function hideAuthOverlay() {
    var ov = document.getElementById('ourlab-auth');
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  }

  /* Which lab workspace this device is signing in to. Each lab is a separate
   * Ourlab instance; McGheeLab is the first. Remembered across launches. */
  var DEFAULT_LAB_GROUP = 'McGheeLab';
  function getLabGroup() {
    try { return localStorage.getItem('ourlab-labgroup') || DEFAULT_LAB_GROUP; }
    catch (e) { return DEFAULT_LAB_GROUP; }
  }
  function setLabGroup(v) {
    try { localStorage.setItem('ourlab-labgroup', v); } catch (e) {}
  }

  function ensureAuthGate() {
    // SEAMLESS NAV: a returning (already-signed-in) user must NOT see the
    // loading splash on every tab tap. The 'ourlab-authed' hint is written by
    // firebase-bridge on the first onAuth(user) and cleared on sign-out /
    // signed-out resolution — a synchronous, app-owned signal that a session
    // very likely exists (Firebase's own restore is async via IndexedDB, so
    // there is no synchronous SDK signal). It is a PAINT hint only, never an
    // auth/security boundary — firestore.rules is the real gate and page
    // renderers still await firebridge before any user-scoped read.
    //  - likely signed-in → show NOTHING; the page paints immediately and
    //    auth silently reconfirms (if it resolves to null — expired session —
    //    the onAuth handler below swaps in the sign-in screen).
    //  - not likely (cold / signed-out) → cover content with the loading
    //    splash right away so no page chrome flashes before the sign-in screen.
    var likelyAuthed = false;
    try { likelyAuthed = localStorage.getItem('ourlab-authed') === '1'; } catch (e) {}
    if (!likelyAuthed && !document.getElementById('ourlab-auth')) showAuthOverlay('loading');
    // firebridge is a lexical const (bare global) — window.firebridge is
    // ALWAYS undefined (window.firebridge dead-checks memory). Poll the bare
    // name until firebase-bridge.js has executed.
    if (typeof firebridge === 'undefined' || !firebridge.onAuth) { setTimeout(ensureAuthGate, 80); return; }
    firebridge.onAuth(function (user) {
      if (user) { hideAuthOverlay(); syncCloud(); }   // V3.840 — the quick links follow the person
      else showAuthOverlay('signin');
    });
  }

  /* ── the "More" sheet: the catalog pages not among the quick links + Customize + account ── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function openMoreSheet() {
    if (document.querySelector('.ourlab-sheet-back')) return;

    // firebridge is the bare global const — window.firebridge is always
    // undefined (window.firebridge dead-checks memory).
    var fb = (typeof firebridge !== 'undefined') ? firebridge : null;
    var prof = (fb && fb.getProfile && fb.getProfile()) || {};
    var user = (fb && fb.getUser && fb.getUser()) || {};
    var name = prof.name || user.displayName || 'Signed in';
    var email = user.email || '';
    var initials = name.split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();

    var links = moreLinks().map(function (l) {
      return '<a class="ourlab-sheet-item" data-key="' + l.key + '" href="' + l.href + '">' +
        '<span class="osi-icon">' + ICON.svg(l.icon) + '</span>' + esc(l.label) + '</a>';
    }).join('');

    var back = document.createElement('div');
    back.className = 'ourlab-sheet-back';
    back.innerHTML =
      '<div class="ourlab-sheet" role="dialog" aria-label="More">' +
        '<div class="ourlab-sheet-grip"></div>' +
        '<div class="ourlab-sheet-user">' +
          '<div class="ourlab-sheet-av">' + (initials ? esc(initials) : ICON.svg('user-circle')) + '</div>' +
          '<div><div class="ourlab-sheet-name">' + esc(name) + '</div>' +
            (email ? '<div class="ourlab-sheet-email">' + esc(email) + '</div>' : '') + '</div>' +
        '</div>' +
        links +
        '<button type="button" class="ourlab-sheet-item ourlab-sheet-customize" data-customize="1">' +
          '<span class="osi-icon">' + ICON.svg('adjustments-horizontal') + '</span>Customize quick links</button>' +
        '<button type="button" class="ourlab-sheet-item ourlab-sheet-signout" data-signout="1">' +
          '<span class="osi-icon">' + ICON.svg('arrow-right-start-on-rectangle') + '</span>Sign out</button>' +
      '</div>';

    back.addEventListener('click', function (ev) {
      if (ev.target === back) { back.remove(); return; }
      if (ev.target.closest('[data-customize]')) { ev.preventDefault(); back.remove(); openCustomizeSheet(); return; }
      // V3.586 — m-v0.3: More-sheet pages open in the shell's misc webview so
      // the tab webviews never navigate away from their page (a page that has
      // a native webview switches to it). Fallback: plain navigation
      // (web / Android / plugin rejection).
      var link = ev.target.closest('a.ourlab-sheet-item');
      var t = link && catalogByKey(link.getAttribute('data-key'));
      if (t && tabsPlugin()) {
        ev.preventDefault();
        back.remove();
        goTo(t);
        return;
      }
      if (ev.target.closest('[data-signout]')) {
        ev.preventDefault();
        back.remove();
        if (typeof firebridge !== 'undefined' && firebridge.signOut) {
          firebridge.signOut().then(function () {
            // V3.586 — m-v0.3: auth state does NOT propagate across the
            // shell's webviews (no cross-webview storage events), so reset
            // the OTHERS natively, then reload SELF to this webview's OWN
            // tab page (navigating to my-week.html here would put My Week
            // inside e.g. the Chat webview — webview identity is fixed).
            // reloadAll is called ONLY from this sign-out path and the
            // auth-gate sign-in success path — never from onAuth callbacks —
            // so reloaded webviews can't loop.
            var T = tabsPlugin();
            if (T) {
              T.reloadAll().catch(function () {});
              location.reload();
            } else {
              location.href = '/rm/pages/my-week.html';
            }
          });
        }
      }
    });
    document.body.appendChild(back);
  }

  /* ── V3.840 — Customize quick links: tick up to MAX_TABS catalog pages, order them ── */
  function openCustomizeSheet() {
    if (document.querySelector('.ourlab-sheet-back')) return;
    var sel = _keys.slice();
    var back = document.createElement('div');
    back.className = 'ourlab-sheet-back';

    function rowHtml(t, i) {
      var on = i >= 0;
      var full = !on && sel.length >= MAX_TABS;
      return '<div class="ourlab-cz-row' + (on ? ' on' : '') + '" data-key="' + t.key + '">' +
        '<label class="ourlab-cz-main"><input type="checkbox" data-pick="' + t.key + '"' + (on ? ' checked' : '') + (full ? ' disabled' : '') + '>' +
          '<span class="osi-icon">' + ICON.svg(t.icon) + '</span><span>' + esc(t.label) + '</span></label>' +
        (on ? '<span class="ourlab-cz-order">' +
          '<button type="button" data-move="' + t.key + '" data-dir="-1" aria-label="Move ' + esc(t.label) + ' up"' + (i === 0 ? ' disabled' : '') + '>▲</button>' +
          '<button type="button" data-move="' + t.key + '" data-dir="1" aria-label="Move ' + esc(t.label) + ' down"' + (i === sel.length - 1 ? ' disabled' : '') + '>▼</button></span>' : '') +
      '</div>';
    }
    function render() {
      var chosen = sel.map(catalogByKey).filter(Boolean).map(function (t) { return rowHtml(t, sel.indexOf(t.key)); }).join('');
      var rest = CATALOG.filter(function (t) { return sel.indexOf(t.key) < 0 && t.key !== 'scan'; }).map(function (t) { return rowHtml(t, -1); }).join('');
      back.innerHTML =
        '<div class="ourlab-sheet ourlab-cz" role="dialog" aria-label="Customize quick links">' +
          '<div class="ourlab-sheet-grip"></div>' +
          '<div class="ourlab-cz-head"><strong>Your quick links</strong><span class="ourlab-cz-count">' + sel.length + ' of ' + MAX_TABS + '</span></div>' +
          '<div class="ourlab-cz-hint">Tick up to ' + MAX_TABS + ' pages for the ☰ menu; ▲ ▼ sets their order. Scan a label and More are always there; everything else stays under More.</div>' +
          '<div class="ourlab-cz-list">' + chosen + (rest ? '<div class="ourlab-cz-sep">Also available</div>' + rest : '') + '</div>' +
          '<div class="ourlab-cz-actions">' +
            '<button type="button" class="ourlab-cz-reset" data-reset="1">Reset</button>' +
            '<button type="button" class="ourlab-cz-save" data-save="1"' + (sel.length ? '' : ' disabled') + '>Save</button>' +
          '</div>' +
        '</div>';
    }
    back.addEventListener('click', function (ev) {
      if (ev.target === back) { back.remove(); return; }
      var mv = ev.target.closest('[data-move]');
      if (mv) {
        var k = mv.getAttribute('data-move'), d = parseInt(mv.getAttribute('data-dir'), 10);
        var i = sel.indexOf(k), j = i + d;
        if (i >= 0 && j >= 0 && j < sel.length) { sel.splice(i, 1); sel.splice(j, 0, k); render(); }
        return;
      }
      if (ev.target.closest('[data-reset]')) { sel = DEFAULT_KEYS.slice(); render(); return; }
      if (ev.target.closest('[data-save]')) { if (sel.length) { savePrefs(sel); back.remove(); } return; }
    });
    back.addEventListener('change', function (ev) {
      var cb = ev.target.closest('[data-pick]'); if (!cb) return;
      var k = cb.getAttribute('data-pick');
      if (cb.checked) { if (sel.indexOf(k) < 0 && sel.length < MAX_TABS) sel.push(k); }
      else sel = sel.filter(function (x) { return x !== k; });
      render();
    });
    render();
    document.body.appendChild(back);
  }

  // Expose a small surface so the persistent app shell (app-shell.js) can
  // reuse the same list / More sheet instead of duplicating them.
  window.OURLAB_SHELL = {
    CATALOG: CATALOG,
    DEFAULT_KEYS: DEFAULT_KEYS,
    MAX_TABS: MAX_TABS,
    tabs: tabs,
    keys: function () { return _keys.slice(); },
    setTabs: savePrefs,
    fanItems: function () { return fanItems(_keys); },
    moreLinks: moreLinks,
    activeKey: activeKey,
    openMore: openMoreSheet,
    openCustomize: openCustomizeSheet,
    openFan: openFan,
    closeFan: closeFan,
    getLabGroup: getLabGroup,
  };
  // V3.586-era readers took these as arrays; keep live snapshots.
  Object.defineProperty(window.OURLAB_SHELL, 'TABS', { get: tabs });
  Object.defineProperty(window.OURLAB_SHELL, 'MORE_LINKS', { get: moreLinks });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
