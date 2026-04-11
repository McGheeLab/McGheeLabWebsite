/* ================================================================
   mobile-shell.js — Shared mobile navigation shell for lab apps
   Injects top bar (hamburger + user icon) and bottom bar (app nav
   + back arrow) on screens ≤700px. Each app can customize via
   McgheeLab.MobileShell.configure().
   ================================================================ */

window.McgheeLab = window.McgheeLab || {};

McgheeLab.MobileShell = (() => {
  'use strict';

  const APPS = [
    { id: 'chat',             name: 'Chat',      icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' },
    { id: 'meetings',         name: 'Meetings',   icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' },
    { id: 'equipment',        name: 'Equipment',  icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' },
    { id: 'activity-tracker',  name: 'Activity',   icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>' },
    { id: 'huddle',           name: 'Huddle',     icon: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="10" y1="19" x2="14" y2="19"/></svg>' }
  ];

  const SVG_MENU = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
  const SVG_BACK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>';
  const SVG_X    = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  let _config = {
    appId: null,
    title: '',
    showBack: false,
    onBack: null,
    onFilter: null,
    filterLabel: null
  };

  let _hamburgerOpen = false;
  let _timeScrollEl = null;  // current time-scroll widget element
  let _timeScrollTarget = null; // the scrollable grid element

  function isMobile() {
    return window.innerWidth <= 700;
  }

  /* ─── Hand preference (localStorage) ───────────────── */
  function getHandPreference() {
    return localStorage.getItem('mcgheelab-hand-preference') || 'right';
  }
  function setHandPreference(val) {
    localStorage.setItem('mcgheelab-hand-preference', val);
    document.body.dataset.hand = val;
  }
  function applyHandPreference() {
    document.body.dataset.hand = getHandPreference();
  }

  function escHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function getInitials(name) {
    if (!name) return '?';
    return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  }

  function configure(opts) {
    Object.assign(_config, opts);
    inject();
  }

  function setBackVisible(visible) {
    _config.showBack = visible;
    const btn = document.getElementById('mshell-back-btn');
    if (btn) btn.classList.toggle('mobile-back-btn--hidden', !visible);
  }

  function inject() {
    if (!_config.appId) return;
    applyHandPreference();
    if (!isMobile()) {
      cleanup();
      return;
    }

    // Top bar
    let topBar = document.getElementById('mshell-top-bar');
    if (!topBar) {
      topBar = document.createElement('div');
      topBar.id = 'mshell-top-bar';
      topBar.className = 'mobile-top-bar';
      topBar.style.display = 'flex';
      document.body.insertBefore(topBar, document.body.firstChild);
    }

    const bridge = McgheeLab.AppBridge;
    const profile = bridge ? bridge.getProfile() : null;
    const user = bridge ? bridge.getUser() : null;
    const photoUrl = profile?.photo?.thumb;
    const name = profile?.name || user?.displayName || user?.email || '';

    topBar.innerHTML = `
      <div class="mobile-top-left"></div>
      <div class="mobile-top-center">${escHTML(_config.title)}</div>
      <div class="mobile-top-right">
        ${photoUrl
          ? `<button class="mobile-user-btn" id="mshell-user-btn"><img src="${escHTML(photoUrl)}" alt="" /></button>`
          : `<button class="mobile-user-btn" id="mshell-user-btn">${getInitials(name)}</button>`}
        <button class="mobile-hamburger-btn" id="mshell-hamburger-btn">${SVG_MENU}</button>
      </div>
    `;

    // Bottom bar — skip when embedded in parent iframe (parent provides nav)
    const isEmbedded = window.parent !== window;
    if (!isEmbedded) {
      let bottomBar = document.getElementById('mshell-bottom-bar');
      if (!bottomBar) {
        bottomBar = document.createElement('div');
        bottomBar.id = 'mshell-bottom-bar';
        bottomBar.className = 'mobile-bottom-bar';
        bottomBar.style.display = 'flex';
        document.body.appendChild(bottomBar);
      }

      bottomBar.innerHTML = `
        <div class="mobile-bottom-apps">
          ${APPS.map(a => `<a class="mobile-bottom-app${a.id === _config.appId ? ' mobile-bottom-app--active' : ''}"
            href="../${a.id}/index.html" data-mshell-app="${a.id}">
            ${a.icon}<span>${a.name}</span>
          </a>`).join('')}
        </div>
        <button class="mobile-back-btn${_config.showBack ? '' : ' mobile-back-btn--hidden'}" id="mshell-back-btn" title="Back">
          ${SVG_BACK}
        </button>
      `;
    } else {
      // Remove stale bottom bar if previously injected
      const staleBot = document.getElementById('mshell-bottom-bar');
      if (staleBot) staleBot.remove();
    }

    wireShell();
  }

  function cleanup() {
    const top = document.getElementById('mshell-top-bar');
    if (top) top.remove();
    const bot = document.getElementById('mshell-bottom-bar');
    if (bot) bot.remove();
    const hmenu = document.getElementById('mshell-hamburger-menu');
    if (hmenu) hmenu.remove();
    const hoverlay = document.getElementById('mshell-hamburger-overlay');
    if (hoverlay) hoverlay.remove();
  }

  function wireShell() {
    const hamburgerBtn = document.getElementById('mshell-hamburger-btn');
    if (hamburgerBtn) hamburgerBtn.addEventListener('click', openHamburger);

    const backBtn = document.getElementById('mshell-back-btn');
    if (backBtn && _config.onBack) backBtn.addEventListener('click', _config.onBack);

    // App navigation — links with href, no extra wiring needed
    // But for same-app click, prevent navigation
    document.querySelectorAll('[data-mshell-app]').forEach(el => {
      if (el.dataset.mshellApp === _config.appId) {
        el.addEventListener('click', (e) => e.preventDefault());
      }
    });
  }

  function openHamburger() {
    _hamburgerOpen = true;

    // Overlay
    let overlay = document.getElementById('mshell-hamburger-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'mshell-hamburger-overlay';
      overlay.className = 'mobile-hamburger-overlay';
      document.body.appendChild(overlay);
    }
    overlay.classList.add('mobile-hamburger-overlay--open');
    overlay.addEventListener('click', closeHamburger);

    // Menu
    let menu = document.getElementById('mshell-hamburger-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'mshell-hamburger-menu';
      menu.className = 'mobile-hamburger-menu';
      document.body.appendChild(menu);
    }

    const hand = getHandPreference();
    menu.innerHTML = `
      <div class="mobile-hamburger-menu-header">
        <span style="font-weight:700;font-size:.95rem">Lab Apps</span>
        <button class="chat-icon-btn" id="mshell-hamburger-close">${SVG_X}</button>
      </div>
      ${APPS.map(a => {
        const active = a.id === _config.appId ? ' mobile-bottom-app--active' : '';
        const href = isEmbedded ? '#' : `../${a.id}/index.html`;
        return `<a class="mobile-hamburger-menu-item${active}" href="${href}" data-mshell-nav="${a.id}">
          ${a.icon} ${a.name}
        </a>`;
      }).join('')}
      <div style="margin-top:auto;border-top:1px solid var(--border);padding:.75rem 1rem">
        <div style="font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:.5rem">Preferred Hand</div>
        <div style="display:flex;gap:.5rem">
          <button class="app-btn app-btn--${hand === 'left' ? 'primary' : 'secondary'}" id="mshell-hand-left" style="flex:1;justify-content:center">Left</button>
          <button class="app-btn app-btn--${hand === 'right' ? 'primary' : 'secondary'}" id="mshell-hand-right" style="flex:1;justify-content:center">Right</button>
        </div>
      </div>
      <a class="mobile-hamburger-menu-item" href="${isEmbedded ? '#' : '../../#/apps'}" ${isEmbedded ? 'data-mshell-nav="hub"' : ''} style="border-top:1px solid var(--border)">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
        All Lab Apps
      </a>
    `;
    requestAnimationFrame(() => menu.classList.add('mobile-hamburger-menu--open'));

    const closeBtn = document.getElementById('mshell-hamburger-close');
    if (closeBtn) closeBtn.addEventListener('click', closeHamburger);

    // Hand preference buttons
    const leftBtn = document.getElementById('mshell-hand-left');
    const rightBtn = document.getElementById('mshell-hand-right');
    if (leftBtn) leftBtn.addEventListener('click', () => { setHandPreference('left'); closeHamburger(); inject(); });
    if (rightBtn) rightBtn.addEventListener('click', () => { setHandPreference('right'); closeHamburger(); inject(); });

    // When embedded, navigate the parent frame instead of the iframe
    if (isEmbedded) {
      document.querySelectorAll('[data-mshell-nav]').forEach(el => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          const target = el.dataset.mshellNav;
          closeHamburger();
          if (target === 'hub') {
            window.parent.location.hash = '#/apps';
          } else if (target !== _config.appId) {
            window.parent.location.hash = `#/apps/${target}`;
          }
        });
      });
    }
  }

  function closeHamburger() {
    _hamburgerOpen = false;
    const overlay = document.getElementById('mshell-hamburger-overlay');
    if (overlay) overlay.classList.remove('mobile-hamburger-overlay--open');
    const menu = document.getElementById('mshell-hamburger-menu');
    if (menu) menu.classList.remove('mobile-hamburger-menu--open');
  }

  /* ─── Center active tab in scrollable tab bar ─────────── */
  // Track scroll positions by container ID so we can restore after DOM rebuild
  const _tabScrollCache = {};

  function saveTabScroll(containerId) {
    const el = document.getElementById(containerId);
    if (el) _tabScrollCache[containerId] = el.scrollLeft;
  }

  function centerActiveTab(containerEl, activeSelector) {
    if (!containerEl) return;
    const active = containerEl.querySelector(activeSelector || '.active');
    if (!active) return;

    // Restore previous scroll position instantly (prevents jump from 0)
    const id = containerEl.id;
    if (id && _tabScrollCache[id] !== undefined) {
      containerEl.scrollLeft = _tabScrollCache[id];
    }

    const containerW = containerEl.offsetWidth;
    const activeLeft = active.offsetLeft;
    const activeW = active.offsetWidth;
    const idealScroll = activeLeft - (containerW / 2) + (activeW / 2);
    const maxScroll = containerEl.scrollWidth - containerW;
    const target = Math.max(0, Math.min(idealScroll, maxScroll));

    // Only animate if there's actually a change
    if (Math.abs(containerEl.scrollLeft - target) > 2) {
      containerEl.scrollTo({ left: target, behavior: 'smooth' });
    }

    // Cache for next render
    if (id) _tabScrollCache[id] = target;
  }

  /* ─── Tab swipe: long horizontal swipe changes section ── */
  let _tabSections = [];   // [{id, label},...] set by app via enableTabSwipe
  let _tabCurrentFn = null; // () => currentSectionId
  let _tabChangeFn = null;  // (sectionId) => void

  function enableTabSwipe(sections, getCurrentFn, onChangeFn) {
    _tabSections = sections;
    _tabCurrentFn = getCurrentFn;
    _tabChangeFn = onChangeFn;
  }

  let _swStartX = 0, _swStartY = 0, _swStartT = 0;

  document.addEventListener('touchstart', (e) => {
    _swStartX = e.touches[0].clientX;
    _swStartY = e.touches[0].clientY;
    _swStartT = Date.now();
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!isMobile() || _tabSections.length === 0 || !_tabCurrentFn || !_tabChangeFn) return;
    const dx = e.changedTouches[0].clientX - _swStartX;
    const dy = e.changedTouches[0].clientY - _swStartY;
    const dt = Date.now() - _swStartT;

    // Long swipe only: >140px horizontal, <500ms, mostly horizontal
    if (dt > 500 || Math.abs(dx) < 140 || Math.abs(dy) > Math.abs(dx) * 0.5) return;

    // Don't fire if the swipe started inside a scrollable container
    const startEl = document.elementFromPoint(_swStartX, _swStartY);
    if (startEl && startEl.closest('[data-no-tab-swipe], .chat-feed, .chat-thread-feed, canvas')) return;

    const currentId = _tabCurrentFn();
    const idx = _tabSections.findIndex(s => s.id === currentId);
    if (idx < 0) return;

    let targetIdx;
    if (dx < 0) targetIdx = Math.min(idx + 1, _tabSections.length - 1);
    else targetIdx = Math.max(idx - 1, 0);

    if (targetIdx !== idx) {
      _tabChangeFn(_tabSections[targetIdx].id);
    }
  }, { passive: true });

  /* ─── Time-scale scroll handle for calendar grids ─────── */
  function enableTimeScroll(scrollableEl) {
    if (!scrollableEl) return;
    _timeScrollTarget = scrollableEl;

    // Remove old widget
    if (_timeScrollEl) _timeScrollEl.remove();

    const el = document.createElement('div');
    el.className = 'mshell-time-scroll mshell-time-scroll--active';
    el.innerHTML = `
      <div class="mshell-time-scroll-track"></div>
      <div class="mshell-time-scroll-thumb" id="mshell-ts-thumb"></div>
    `;
    document.body.appendChild(el);
    _timeScrollEl = el;

    const thumb = document.getElementById('mshell-ts-thumb');
    if (!thumb) return;

    function syncThumb() {
      const max = scrollableEl.scrollHeight - scrollableEl.clientHeight;
      if (max <= 0) return;
      const ratio = scrollableEl.scrollTop / max;
      const trackH = el.clientHeight - 16; // 8px padding top+bottom
      const thumbH = thumb.offsetHeight;
      thumb.style.top = (8 + ratio * (trackH - thumbH)) + 'px';
    }

    scrollableEl.addEventListener('scroll', syncThumb);
    requestAnimationFrame(syncThumb);

    // Touch drag on the scroll handle
    let dragging = false;
    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      moveToY(e.touches[0].clientY);
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      moveToY(e.touches[0].clientY);
    }, { passive: false });

    el.addEventListener('touchend', () => { dragging = false; });
    el.addEventListener('touchcancel', () => { dragging = false; });

    // Also support mouse
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      moveToY(e.clientY);
      const onMove = (ev) => { if (dragging) moveToY(ev.clientY); };
      const onUp = () => { dragging = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    function moveToY(clientY) {
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top - 8) / (rect.height - 16)));
      const max = scrollableEl.scrollHeight - scrollableEl.clientHeight;
      scrollableEl.scrollTop = ratio * max;
    }
  }

  function disableTimeScroll() {
    if (_timeScrollEl) { _timeScrollEl.remove(); _timeScrollEl = null; }
    _timeScrollTarget = null;
  }

  // Prevent pinch-to-zoom on iOS (Safari ignores viewport meta)
  document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
  document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

  // Auto-inject on resize
  window.addEventListener('resize', () => {
    if (isMobile()) inject();
    else { cleanup(); disableTimeScroll(); }
  });

  // Apply hand preference on load
  applyHandPreference();

  return { configure, inject, setBackVisible, isMobile, enableTabSwipe,
           saveTabScroll, centerActiveTab,
           getHandPreference, setHandPreference, enableTimeScroll, disableTimeScroll };
})();
