/* rm-dialog.js — V3.302 promise-based replacement for window.prompt().
 *
 * Usage:
 *   const name = await RM_DIALOG.prompt({
 *     title: 'New sub-bucket', placeholder: 'Bucket name', okText: 'Create'
 *   });
 *   if (name === null) return;   // cancelled
 *
 * Resolves the trimmed value on OK/Enter; resolves null on Cancel, Esc,
 * or backdrop click. Empty input never resolves — OK just refocuses the
 * field (matching the "ignore empty" behavior every call site had).
 * Styles are injected once, keyed to the RM light-theme tokens.
 */

(function () {
  function promptDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.className = 'rm-dialog-backdrop';
      back.innerHTML =
        '<div class="rm-dialog" role="dialog" aria-modal="true">' +
        '  <h3 class="rm-dialog-title"></h3>' +
        '  <input type="text" class="rm-dialog-input">' +
        '  <div class="rm-dialog-actions">' +
        '    <button type="button" class="rm-dialog-btn rm-dialog-cancel">Cancel</button>' +
        '    <button type="button" class="rm-dialog-btn rm-dialog-ok"></button>' +
        '  </div>' +
        '</div>';
      back.querySelector('.rm-dialog-title').textContent = opts.title || 'Enter a value';
      var input = back.querySelector('.rm-dialog-input');
      input.value = opts.value || '';
      input.placeholder = opts.placeholder || '';
      back.querySelector('.rm-dialog-ok').textContent = opts.okText || 'OK';

      function done(val) {
        document.removeEventListener('keydown', onKey, true);
        back.remove();
        resolve(val);
      }
      function ok() {
        var v = input.value.trim();
        if (!v) { input.focus(); return; }
        done(v);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        else if (e.key === 'Enter' && document.activeElement === input) {
          e.stopPropagation(); e.preventDefault(); ok();
        }
      }
      back.querySelector('.rm-dialog-ok').addEventListener('click', ok);
      back.querySelector('.rm-dialog-cancel').addEventListener('click', function () { done(null); });
      back.addEventListener('mousedown', function (e) { if (e.target === back) done(null); });
      document.addEventListener('keydown', onKey, true);

      document.body.appendChild(back);
      input.focus();
      input.select();
    });
  }

  if (typeof document !== 'undefined' && !document.getElementById('rm-dialog-css')) {
    var style = document.createElement('style');
    style.id = 'rm-dialog-css';
    style.textContent =
      '.rm-dialog-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:99998;' +
      'display:flex;align-items:flex-start;justify-content:center;padding-top:18vh;}' +
      '.rm-dialog{background:var(--card,#fff);color:var(--text,#1f2937);border:1px solid var(--border,#e1e4e8);' +
      'border-radius:10px;padding:16px;width:min(420px,90vw);box-shadow:0 12px 32px rgba(0,0,0,.25);}' +
      '.rm-dialog-title{margin:0 0 10px;font-size:15px;font-weight:600;}' +
      '.rm-dialog-input{width:100%;box-sizing:border-box;padding:7px 10px;font-size:14px;' +
      'border:1px solid var(--border,#e1e4e8);border-radius:6px;background:var(--bg,#f5f6fa);color:inherit;}' +
      '.rm-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;}' +
      '.rm-dialog-btn{padding:6px 14px;border-radius:6px;font-size:13px;cursor:pointer;' +
      'border:1px solid var(--border,#e1e4e8);background:transparent;color:inherit;}' +
      '.rm-dialog-ok{background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600;}';
    document.head.appendChild(style);
  }

  window.RM_DIALOG = { prompt: promptDialog };
})();
