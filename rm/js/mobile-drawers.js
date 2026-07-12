/* rm/js/mobile-drawers.js — V3.235
 *
 * Tiny helper for the reusable side-drawer pattern defined in
 * rm/css/style.css (.rm-mobile-drawer-* rules). At ≤640px, panels
 * marked `.rm-mobile-drawer-left` / `.rm-mobile-drawer-right` slide in
 * from screen edges; a backdrop covers the rest; toggle buttons + the
 * Escape key close them. At ≥641px this helper is inert.
 *
 * Usage from a page's renderer:
 *
 *   const drawers = window.MOBILE_DRAWERS.init(
 *     document.querySelector('.pe-page'),
 *     {
 *       leftToggle:  document.querySelector('#pe-mobile-left-toggle'),
 *       rightToggle: document.querySelector('#pe-mobile-right-toggle'),
 *     }
 *   );
 *   // later:
 *   drawers.open('right');     // programmatic open (e.g. on selection)
 *   drawers.close();
 *
 * The host must already carry `.rm-mobile-drawer-host` and contain
 * elements with `.rm-mobile-drawer-left` / `.rm-mobile-drawer-right`.
 */
(function () {
  'use strict';

  if (window.MOBILE_DRAWERS) return;  // already loaded

  function init(host, opts) {
    if (!host) return null;
    opts = opts || {};
    if (host._rmMobileDrawersWired) return host._rmMobileDrawersWired;

    // Inject backdrop if the page hasn't already added one.
    let backdrop = host.querySelector(':scope > .rm-mobile-drawer-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.className = 'rm-mobile-drawer-backdrop';
      // Insert as first child so z-index ordering stays predictable.
      host.insertBefore(backdrop, host.firstChild);
    }

    let savedScrollY = 0;

    function open(side) {
      if (side !== 'left' && side !== 'right') return;
      const current = host.getAttribute('data-drawer');
      if (current === side) return;
      // If switching sides, close first so the transition is clean.
      if (current) close();
      host.setAttribute('data-drawer', side);
      // Body scroll lock (iOS-friendly).
      savedScrollY = window.scrollY || 0;
      document.body.classList.add('rm-mobile-drawer-locked');
      document.body.style.top = '-' + savedScrollY + 'px';
      if (typeof opts.onOpen === 'function') opts.onOpen(side);
    }

    function close() {
      if (!host.hasAttribute('data-drawer')) return;
      const wasSide = host.getAttribute('data-drawer');
      host.removeAttribute('data-drawer');
      document.body.classList.remove('rm-mobile-drawer-locked');
      document.body.style.top = '';
      window.scrollTo(0, savedScrollY);
      if (typeof opts.onClose === 'function') opts.onClose(wasSide);
    }

    function toggle(side) {
      if (host.getAttribute('data-drawer') === side) close();
      else open(side);
    }

    backdrop.addEventListener('click', close);

    if (opts.leftToggle) {
      opts.leftToggle.addEventListener('click', function (e) {
        e.preventDefault();
        toggle('left');
      });
    }
    if (opts.rightToggle) {
      opts.rightToggle.addEventListener('click', function (e) {
        e.preventDefault();
        toggle('right');
      });
    }

    // Escape closes whichever drawer is open.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && host.hasAttribute('data-drawer')) close();
    });

    const api = { open: open, close: close, toggle: toggle, host: host };
    host._rmMobileDrawersWired = api;
    return api;
  }

  window.MOBILE_DRAWERS = { init: init };
})();
