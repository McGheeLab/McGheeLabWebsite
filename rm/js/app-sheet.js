/* app-sheet.js — the app's standard fold-up input surface (V3.568).
 *
 * A reusable bottom sheet that slides up from the bottom edge, with a
 * ▾ fold-away control and a grip — the same interaction the My Day
 * composer uses. Any page that needs a form/chooser "pops up" through
 * this so inputs feel consistent across the whole app.
 *
 *   var sheet = APP_SHEET.open({
 *     title: 'Assign a focus',
 *     build: function (body, api) {
 *       body.innerHTML = '<input …><button class="go">Save</button>';
 *       body.querySelector('.go').onclick = function () { …; api.close(); };
 *     }
 *   });
 *
 *   var fab = APP_SHEET.fab({ label: 'Assign a focus', onClick: openIt });
 *   document.body.appendChild(fab);   // or drop the class into your markup
 *
 * Self-injects its CSS (icon-picker.js pattern); inputs are 16px so iOS
 * never zoom-on-focus. Framework-free.
 *
 * Global: window.APP_SHEET
 */
(function () {
  'use strict';

  var CSS =
    '.app-sheet-back{position:fixed;inset:0;z-index:9500;background:rgba(15,23,42,.45);' +
      'display:flex;flex-direction:column;justify-content:flex-end;}' +
    '.app-sheet{background:var(--card,#fff);border-radius:18px 18px 0 0;' +
      'padding:8px 16px calc(16px + env(safe-area-inset-bottom,0px));' +
      'max-height:85vh;overflow-y:auto;animation:app-sheet-up .2s ease;' +
      'box-shadow:0 -8px 30px rgba(0,0,0,.2);}' +
    '@keyframes app-sheet-up{from{transform:translateY(100%);}to{transform:translateY(0);}}' +
    '.app-sheet-grip{width:38px;height:4px;border-radius:2px;background:var(--border,#e2e8f0);margin:2px auto 8px;}' +
    '.app-sheet-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;' +
      'max-width:660px;margin-left:auto;margin-right:auto;width:100%;}' +
    '.app-sheet-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;' +
      'color:var(--text-muted,#64748b);}' +
    '.app-sheet-fold{border:1px solid var(--border,#e2e8f0);background:var(--card,#fff);border-radius:8px;' +
      'min-width:36px;min-height:32px;font-size:16px;line-height:1;cursor:pointer;color:var(--text-muted,#64748b);}' +
    '.app-sheet-body{display:flex;flex-direction:column;gap:10px;max-width:660px;margin:0 auto;width:100%;}' +
    '.app-sheet-body input,.app-sheet-body textarea,.app-sheet-body select{font-size:16px;' +
      'border:1px solid var(--border,#e2e8f0);border-radius:8px;padding:10px;' +
      'background:var(--bg,#f1f5f9);color:var(--text,#0f172a);width:100%;}' +
    '.app-sheet-body textarea{resize:none;overflow-y:auto;min-height:64px;max-height:260px;}' +
    /* the standard app FAB that opens a sheet */
    '.app-fab{position:fixed;right:16px;bottom:calc(20px + env(safe-area-inset-bottom,0px));' +
      'width:56px;height:56px;border-radius:50%;border:none;background:var(--primary,#2563eb);color:#fff;' +
      'font-size:30px;line-height:1;cursor:pointer;z-index:60;box-shadow:0 6px 18px rgba(0,0,0,.28);' +
      'display:flex;align-items:center;justify-content:center;}' +
    '.app-fab:active{transform:scale(.94);}' +
    'body.ourlab-app .app-fab{bottom:calc(80px + env(safe-area-inset-bottom,0px));}';

  var _injected = false;
  function ensureCSS() {
    if (_injected) return;
    var s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
    _injected = true;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function onKey(ev) { if (ev.key === 'Escape') close(); }

  function close() {
    var e = document.querySelector('.app-sheet-back');
    if (e) { e.remove(); document.removeEventListener('keydown', onKey); }
  }

  function open(opts) {
    opts = opts || {};
    ensureCSS();
    close(); // one sheet at a time

    var back = document.createElement('div');
    back.className = 'app-sheet-back';
    back.innerHTML =
      '<div class="app-sheet" role="dialog" aria-modal="true">' +
        '<div class="app-sheet-grip"></div>' +
        '<div class="app-sheet-head">' +
          '<span class="app-sheet-title">' + esc(opts.title || '') + '</span>' +
          '<button type="button" class="app-sheet-fold" aria-label="Fold away">▾</button>' +
        '</div>' +
        '<div class="app-sheet-body"></div>' +
      '</div>';

    back.addEventListener('click', function (ev) {
      if (ev.target === back || ev.target.classList.contains('app-sheet-fold')) {
        if (opts.onClose) { try { opts.onClose(); } catch (e) {} }
        close();
      }
    });

    var body = back.querySelector('.app-sheet-body');
    var api = { close: close, body: body, back: back };
    document.body.appendChild(back);
    document.addEventListener('keydown', onKey);

    if (opts.bodyHTML) body.innerHTML = opts.bodyHTML;
    if (typeof opts.build === 'function') opts.build(body, api);

    var first = body.querySelector('input, textarea, select');
    if (first && first.focus) setTimeout(function () { try { first.focus(); } catch (e) {} }, 60);
    return api;
  }

  function fab(opts) {
    ensureCSS();
    opts = opts || {};
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'app-fab' + (opts.className ? ' ' + opts.className : '');
    b.setAttribute('aria-label', opts.label || 'Add');
    b.textContent = opts.icon || '＋';
    if (opts.onClick) b.addEventListener('click', opts.onClick);
    return b;
  }

  window.APP_SHEET = { open: open, close: close, fab: fab, ensureStyles: ensureCSS };

  // Inject the styles eagerly so consumers can render a static
  // `<button class="app-fab">` (like Team Focus) and have it styled from
  // first paint — not only after the first sheet opens.
  if (document.head) ensureCSS();
  else document.addEventListener('DOMContentLoaded', ensureCSS);
})();
