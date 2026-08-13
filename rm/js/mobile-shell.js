/* mobile-shell.js — Ourlab app bottom tab bar (V3.565, m-v0.1).
 *
 * Renders the phone app's persistent bottom tabs — 🌞 My Day · 💬 Chat ·
 * ✅ Tasks · ⋯ More — on every rm/ page, but ONLY when running inside the
 * Capacitor shell (the OurlabMobile sibling repo bundles rm/ into its
 * webDir and injects this script into every page at build time; the
 * production website never references it, and even if it did, the gate
 * below makes it a no-op in ordinary browsers).
 *
 * Dev preview in a normal browser: append ?mobileShell=1 (persists for
 * the session via sessionStorage).
 *
 * Deliberately framework-free and dependency-free (loads before/without
 * firebridge): tabs are plain page navigations — state lives in
 * Firestore, exactly like the web app. Self-injecting CSS follows the
 * icon-picker.js pattern.
 */
(function () {
  'use strict';

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
  // bottom tab bar, auth gate). nav.js already hides the page's own top-nav
  // in embed mode; mobile-shell must add NOTHING here, or every tab iframe
  // would render its own duplicate tab bar + auth gate. Bail out early.
  function isEmbedded() {
    try {
      if (window.top !== window.self) return true;
      if (/[?&]embed=1/.test(location.search)) return true;
      if (typeof window.name === 'string' && /^rm-(embed|shell)/.test(window.name)) return true;
    } catch (e) { /* cross-origin top access → we're framed */ return true; }
    return false;
  }
  if (isEmbedded()) {
    // A tab hosted in the app shell. The shell owns the top bar + tab bar +
    // auth gate, so render NONE of that here. We only need to (a) hide the
    // page's own top nav / sync indicator + drop its top padding, and (b) mark
    // the page as running in the app so its app-gated UX (My Day composer FAB,
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

  var TABS = [
    { key: 'myday', icon: '🌞', label: 'My Day', href: '/rm/pages/my-day.html',    match: /\/my-day\.html$/ },
    { key: 'focus', icon: '🎯', label: 'Focus',  href: '/rm/pages/team-focus.html', match: /\/team-focus\.html$/ },
    { key: 'chat',  icon: '💬', label: 'Chat',   href: '/rm/pages/chat.html',      match: /\/chat\.html$/ },
    { key: 'tasks', icon: '✅', label: 'Tasks',  href: '/rm/pages/tasks.html',     match: /\/tasks[a-z-]*\.html$/ },
    // V3.613 — Library. The match covers the whole library* family so the
    // mobile reader (library-mobile-paper.html) keeps this tab highlighted.
    // KEEP IN LOCKSTEP with TabRoute.swift + tab-lifecycle.js selfCheck.
    { key: 'library', icon: '📚', label: 'Library', href: '/rm/pages/library-mobile.html', match: /\/library[a-z-]*\.html$/ },
    // "More" is NOT a link into the rest of RM — it opens a curated sheet
    // of only the pages the app ships. Edit MORE_LINKS to add/remove.
    { key: 'more',  icon: '⋯',  label: 'More',   sheet: true,                      match: /\/more-never-matches$/ },
  ];

  /* The ONLY pages reachable from the app beyond the tabs. This is the
   * allowlist — the app never exposes the full RM nav. Add entries here.
   * (Team Focus is now a first-class bottom tab, so it's not repeated here.) */
  var MORE_LINKS = [
    { icon: '📓', label: 'Lab Notebook', href: '/rm/pages/lab-notebook.html' },
    { icon: '📅', label: 'Scheduler',    href: '/rm/pages/scheduler.html' },
    { icon: '🔬', label: 'Research',     href: '/rm/pages/research.html' },
    { icon: '⚙️', label: 'Settings',     href: '/rm/pages/settings.html' },
  ];

  var CSS =
    '.ourlab-tabbar{position:fixed;left:0;right:0;bottom:0;z-index:9000;' +
      'display:flex;background:var(--card,#fff);border-top:1px solid var(--border,#e2e8f0);' +
      'padding-bottom:env(safe-area-inset-bottom,0px);' +
      'box-shadow:0 -2px 12px rgba(0,0,0,.06);}' +
    '.ourlab-tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;' +
      'padding:8px 0 6px;border:none;background:transparent;cursor:pointer;' +
      'font-size:10px;font-weight:600;color:var(--text-muted,#64748b);text-decoration:none;' +
      '-webkit-tap-highlight-color:transparent;}' +
    '.ourlab-tab .ot-icon{font-size:22px;line-height:1;}' +
    '.ourlab-tab.ot-active{color:var(--primary,#2563eb);}' +
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
    '.ourlab-sheet-item .osi-icon{font-size:22px;width:26px;text-align:center;}' +
    '.ourlab-sheet-signout{color:#dc2626;font-weight:600;border-top:1px solid var(--border,#e2e8f0);margin-top:6px;}' +
    /* app-wide: drop the RM nav's Workflows / All Pages / Split / My
       Workflows buttons — each page's own tab bar is the nav in the app */
    'body.ourlab-app .nav-app-hide{display:none !important;}' +
    'body.ourlab-app{padding-bottom:calc(64px + env(safe-area-inset-bottom,0px)) !important;}' +
    /* pages with their own bottom-fixed chrome (My Day composer) sit above the bar */
    'body.ourlab-app .md-composer{bottom:calc(56px + env(safe-area-inset-bottom,0px));}' +
    /* voice-call panel (V3.584) floats above the tab bar, not under it */
    'body.ourlab-app #vc-panel{bottom:calc(72px + env(safe-area-inset-bottom,0px));}' +
    /* The RM top nav (McGhee Lab · sync status · avatar) is pinned FIXED to
       the very top on every app page — always in place, content scrolls
       under it (like the bottom tab bar). Its background fills the status
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
       tabs (e.g. My Day Day/Week/Month) — collapse to one small gap. */
    'body.ourlab-app .page-header{margin-bottom:8px;}' +
    'body.ourlab-app .page-title{margin-bottom:0;}' +
    'body.ourlab-app.ourlab-no-nav{padding-top:env(safe-area-inset-top,0px);}' +
    /* full-screen sign-in / loading overlay — the app shows NOTHING but
       this until a user is authenticated (covers the tab bar + any page's
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

  function activeKey() {
    var p = location.pathname;
    for (var i = 0; i < TABS.length; i++) {
      if (TABS[i].match.test(p)) return TABS[i].key;
    }
    return '';
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
    bar.setAttribute('aria-label', 'App tabs');
    var act = activeKey();
    bar.innerHTML = TABS.map(function (t) {
      var cls = 'ourlab-tab' + (t.key === act ? ' ot-active' : '');
      var inner = '<span class="ot-icon">' + t.icon + '</span>' + t.label;
      return t.sheet
        ? '<button type="button" class="' + cls + '" data-more="1">' + inner + '</button>'
        : '<a class="' + cls + '" data-key="' + t.key + '" href="' + t.href + '">' + inner + '</a>';
    }).join('');

    bar.addEventListener('click', function (ev) {
      // haptic tick
      try {
        var H = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.Haptics;
        if (H && H.impact) H.impact({ style: 'LIGHT' });
      } catch (e) { /* haptics are garnish */ }
      var moreBtn = ev.target.closest('[data-more]');
      if (moreBtn) { ev.preventDefault(); openMoreSheet(); return; }
      // V3.586 — m-v0.3 multi-WebView shell: tab taps become native webview
      // swaps instead of navigations (each tab stays warm). Falls back to the
      // anchor's normal navigation on web/Android/plugin-rejection.
      var a = ev.target.closest('a.ourlab-tab');
      var T = tabsPlugin();
      if (a && T) {
        ev.preventDefault();
        T.switchTo({ key: a.getAttribute('data-key') })
          .catch(function () { location.href = a.getAttribute('href'); });
      }
    });

    document.body.classList.add('ourlab-app');
    document.body.appendChild(bar);

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
      if (user) hideAuthOverlay();
      else showAuthOverlay('signin');
    });
  }

  /* ── the "More" sheet: curated app pages + account, nothing else ── */
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

    var links = MORE_LINKS.map(function (l) {
      return '<a class="ourlab-sheet-item" href="' + l.href + '">' +
        '<span class="osi-icon">' + l.icon + '</span>' + esc(l.label) + '</a>';
    }).join('');

    var back = document.createElement('div');
    back.className = 'ourlab-sheet-back';
    back.innerHTML =
      '<div class="ourlab-sheet" role="dialog" aria-label="More">' +
        '<div class="ourlab-sheet-grip"></div>' +
        '<div class="ourlab-sheet-user">' +
          '<div class="ourlab-sheet-av">' + esc(initials || '👤') + '</div>' +
          '<div><div class="ourlab-sheet-name">' + esc(name) + '</div>' +
            (email ? '<div class="ourlab-sheet-email">' + esc(email) + '</div>' : '') + '</div>' +
        '</div>' +
        links +
        '<button type="button" class="ourlab-sheet-item ourlab-sheet-signout" data-signout="1">' +
          '<span class="osi-icon">🚪</span>Sign out</button>' +
      '</div>';

    back.addEventListener('click', function (ev) {
      if (ev.target === back) { back.remove(); return; }
      // V3.586 — m-v0.3: More-sheet pages open in the shell's misc webview so
      // the 4 tab webviews never navigate away from their page. Fallback:
      // plain navigation (web / Android / plugin rejection).
      var link = ev.target.closest('a.ourlab-sheet-item');
      if (link && tabsPlugin()) {
        ev.preventDefault();
        back.remove();
        tabsPlugin().open({ href: link.getAttribute('href') })
          .catch(function () { location.href = link.getAttribute('href'); });
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
            // tab page (navigating to my-day.html here would put My Day
            // inside e.g. the Chat webview — webview identity is fixed).
            // reloadAll is called ONLY from this sign-out path and the
            // auth-gate sign-in success path — never from onAuth callbacks —
            // so reloaded webviews can't loop.
            var T = tabsPlugin();
            if (T) {
              T.reloadAll().catch(function () {});
              location.reload();
            } else {
              location.href = '/rm/pages/my-day.html';
            }
          });
        }
      }
    });
    document.body.appendChild(back);
  }

  // Expose a small surface so the persistent app shell (app-shell.js) can
  // reuse the same tab list / More sheet instead of duplicating them.
  window.OURLAB_SHELL = {
    TABS: TABS,
    MORE_LINKS: MORE_LINKS,
    openMore: openMoreSheet,
    getLabGroup: getLabGroup,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
