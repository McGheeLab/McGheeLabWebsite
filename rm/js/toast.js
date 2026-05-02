/* toast.js — minimal corner-of-screen notifications for optimistic-UI
 * save failures and other transient feedback.
 *
 * Usage:
 *   TOAST.error('Save failed', { detail: err.message, retry: () => save() });
 *   TOAST.info('Migrated 12 records');
 *   TOAST.success('Saved');
 *
 * Each toast auto-dismisses after ~5s; errors persist until clicked or
 * the optional retry button is used. Stack up to 5 toasts; older ones
 * slide off as new ones arrive.
 */

(function () {
  var STACK_LIMIT = 5;
  var DEFAULT_TTL_MS = 5000;
  var ERROR_TTL_MS = 0;        // 0 = persistent until clicked

  function _container() {
    var el = document.getElementById('toast-stack');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'toast-stack';
    el.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:99999;' +
      'display:flex;flex-direction:column-reverse;gap:8px;' +
      'pointer-events:none;max-width:380px;';
    document.body.appendChild(el);
    return el;
  }

  function _show(level, msg, opts) {
    opts = opts || {};
    var stack = _container();
    // Trim to capacity (oldest first; column-reverse means visual top is oldest).
    while (stack.children.length >= STACK_LIMIT) {
      stack.removeChild(stack.firstChild);
    }
    var bg = level === 'error' ? '#dc2626'
           : level === 'success' ? '#059669'
           : level === 'warn' ? '#d97706'
           : '#374151';
    var t = document.createElement('div');
    t.style.cssText =
      'background:' + bg + ';color:#fff;padding:10px 14px;border-radius:8px;' +
      'box-shadow:0 8px 16px rgba(0,0,0,.2);font-size:13px;line-height:1.4;' +
      'pointer-events:auto;cursor:pointer;animation:toast-slide-in 180ms ease-out;';
    var msgEl = document.createElement('div');
    msgEl.style.cssText = 'font-weight:600;';
    msgEl.textContent = msg;
    t.appendChild(msgEl);
    if (opts.detail) {
      var d = document.createElement('div');
      d.style.cssText = 'opacity:.85;font-weight:400;font-size:12px;margin-top:2px;';
      d.textContent = opts.detail;
      t.appendChild(d);
    }
    if (opts.retry) {
      var r = document.createElement('button');
      r.textContent = 'Retry';
      r.style.cssText =
        'margin-top:6px;background:rgba(255,255,255,.2);color:#fff;border:1px solid rgba(255,255,255,.35);' +
        'padding:3px 10px;border-radius:5px;font-size:12px;cursor:pointer;';
      r.addEventListener('click', function (e) {
        e.stopPropagation();
        try { opts.retry(); } catch (err) { console.error('[toast] retry threw:', err); }
        if (t.parentNode) t.parentNode.removeChild(t);
      });
      t.appendChild(r);
    }
    t.addEventListener('click', function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    });
    stack.appendChild(t);
    var ttl = opts.ttl != null ? opts.ttl : (level === 'error' ? ERROR_TTL_MS : DEFAULT_TTL_MS);
    if (ttl > 0) {
      setTimeout(function () {
        if (t.parentNode) t.parentNode.removeChild(t);
      }, ttl);
    }
    return t;
  }

  // Inject the slide-in keyframe once.
  if (typeof document !== 'undefined' && !document.getElementById('toast-css')) {
    var style = document.createElement('style');
    style.id = 'toast-css';
    style.textContent =
      '@keyframes toast-slide-in { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }';
    document.head.appendChild(style);
  }

  window.TOAST = {
    error:   function (msg, opts) { return _show('error',   msg, opts); },
    warn:    function (msg, opts) { return _show('warn',    msg, opts); },
    success: function (msg, opts) { return _show('success', msg, opts); },
    info:    function (msg, opts) { return _show('info',    msg, opts); },
  };
})();
