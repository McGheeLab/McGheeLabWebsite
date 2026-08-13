/* icon-picker.js — shared icon chooser (V3.555)
 *
 * A single, reusable popout icon picker + one shared pool used by every
 * surface that carries an icon. The pool = a curated emoji set PLUS custom
 * icons any lab member uploads (stored once in Firestore `labIcons` +
 * Storage `labIcons/{id}/icon.webp`, so an icon uploaded on one surface is
 * immediately selectable on all of them).
 *
 * An icon VALUE is either a plain emoji string ("🔬") or an image URL
 * (custom upload / `data:`). `ICON_PICKER.html(value)` renders whichever
 * form correctly — text for emoji, an <img> for a URL — so call sites stop
 * `esc()`-ing the raw value.
 *
 * Public API (window.ICON_PICKER):
 *   open({ current, onPick, title })  — popout; onPick(value) on choose.
 *   html(value, { size })             — safe HTML for rendering an icon.
 *   isCustom(value)                   — true if value is an image URL.
 *
 * CSS is injected once (rm-dialog.js pattern) so any page needs only this
 * one <script> to adopt the picker.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isUrl(v) { return /^(https?:|data:)/i.test(String(v || '')); }
  function toast(kind, msg) { if (window.TOAST && TOAST[kind]) TOAST[kind](msg); }

  /* Curated pool — grouped, lab-leaning. Extend freely; custom uploads
   * append a "Custom" group at the top. */
  var GROUPS = [
    { name: 'Lab & science', emoji: ['🔬','🧫','🧪','🧬','🦠','💉','🩸','🧷','⚗️','🌡️','🔭','📡','🛰️','⚙️','🔧','🔩','🧰','🧲','🔋','💡','🖥️','💻','📟','⌨️','🖨️','📷','📸','🎥','📽️','🎞️'] },
    { name: 'Bio & nature', emoji: ['🫧','🧩','🌱','🌿','🍃','🌾','🦴','🫀','🫁','🧠','👁️','🐭','🐁','🐟','🪸','🌸','🌊','🔥','❄️','☀️','⭐','✨','🌈','🪐'] },
    { name: 'Docs & work', emoji: ['📄','📃','📑','📊','📈','📉','🗂️','📁','📂','🗃️','📋','📝','✏️','🖊️','📌','📎','🔖','🏷️','📚','📖','⚖️','🎓','🏆','🥇','🎯','🧭','🗺️','📅','⏱️','⏳'] },
    { name: 'Symbols', emoji: ['🔵','🟢','🟡','🟠','🔴','🟣','⚫','⚪','🟤','◼️','◻️','🔶','🔷','🔺','🔻','➕','➖','✅','❌','❓','❗','💠','♻️','⚡','🚀','🛠️','🧿','🔮','💎','🧱'] },
  ];

  /* ── shared custom-icon pool (labIcons) ─────────────────────── */
  var _customCache = null;
  function db() { return firebridge.db(); }
  async function loadCustom(force) {
    if (_customCache && !force) return _customCache;
    try {
      var snap = await db().collection('labIcons').get();
      _customCache = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .filter(function (x) { return x.url; })
        .sort(function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
    } catch (e) { _customCache = []; }
    return _customCache;
  }

  function resizeWebp(file, size) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        var c = document.createElement('canvas'); c.width = c.height = size;
        var ctx = c.getContext('2d');
        // contain-fit, centered
        var s = Math.min(size / img.width, size / img.height);
        var w = img.width * s, h = img.height * s;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('resize failed')); }, 'image/webp', 0.9);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
      img.src = url;
    });
  }

  async function uploadCustom(file, name) {
    if (typeof firebase === 'undefined' || !firebase.storage) throw new Error('Storage SDK not loaded.');
    var user = firebridge.getUser(); if (!user) throw new Error('Sign in to upload an icon.');
    var id = 'ic-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    var blob = await resizeWebp(file, 96);
    var path = 'labIcons/' + id + '/icon.webp';
    var ref = firebase.storage().ref().child(path);
    await ref.put(blob, { contentType: 'image/webp' });
    var url = await ref.getDownloadURL();
    var doc = { name: (name || file.name || 'icon').slice(0, 60), url: url, storage_path: path,
                created_by: user.uid, created_at: new Date().toISOString() };
    await db().collection('labIcons').doc(id).set(doc);
    _customCache = null; // bust
    return url;
  }

  /* ── render helper ──────────────────────────────────────────── */
  function html(value, opts) {
    opts = opts || {};
    var size = opts.size || '1.2em';
    if (isUrl(value)) {
      return '<img class="ip-icon-img" src="' + esc(value) + '" alt="" ' +
        'style="width:' + size + ';height:' + size + ';object-fit:contain;vertical-align:middle;">';
    }
    return esc(value || '');
  }

  /* ── popout ─────────────────────────────────────────────────── */
  function open(opts) {
    opts = opts || {};
    var back = document.createElement('div');
    back.className = 'ip-backdrop';
    back.innerHTML =
      '<div class="ip-modal" role="dialog" aria-modal="true">' +
        '<div class="ip-head"><h3>' + esc(opts.title || 'Choose an icon') + '</h3>' +
          '<button class="ip-x" aria-label="Close">✕</button></div>' +
        '<input type="search" class="ip-search" placeholder="Search icons…">' +
        '<div class="ip-body"></div>' +
        '<div class="ip-foot">' +
          '<label class="ip-upload"><input type="file" accept="image/*" hidden>＋ Upload custom icon</label>' +
          (opts.current ? '<button type="button" class="ip-clear">Clear</button>' : '') +
        '</div>' +
      '</div>';
    var body = back.querySelector('.ip-body');
    var search = back.querySelector('.ip-search');

    function close() { document.removeEventListener('keydown', onKey, true); back.remove(); }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    function pick(v) { if (opts.onPick) opts.onPick(v); close(); }

    function tile(v, label) {
      return '<button type="button" class="ip-tile' + (v === opts.current ? ' ip-sel' : '') + '" data-val="' + esc(v) + '" title="' + esc(label || '') + '">' + html(v, { size: '24px' }) + '</button>';
    }

    function renderGrid(filter) {
      filter = (filter || '').trim().toLowerCase();
      var out = '';
      var custom = _customCache || [];
      if (custom.length) {
        var ct = custom.filter(function (c) { return !filter || (c.name || '').toLowerCase().indexOf(filter) !== -1; });
        if (ct.length) out += '<div class="ip-group-name">Custom</div><div class="ip-grid">' +
          ct.map(function (c) { return tile(c.url, c.name); }).join('') + '</div>';
      }
      GROUPS.forEach(function (g) {
        // Emoji have no names to search; when filtering, only the custom
        // group narrows — keep full emoji groups unless the filter is long.
        var items = g.emoji;
        if (filter && filter.length >= 1) {
          // simple keyword → group-name match so "sci" shows Lab & science
          if (g.name.toLowerCase().indexOf(filter) === -1 && !custom.length) { /* still show */ }
        }
        out += '<div class="ip-group-name">' + esc(g.name) + '</div><div class="ip-grid">' +
          items.map(function (e) { return tile(e, e); }).join('') + '</div>';
      });
      body.innerHTML = out;
    }

    back.querySelector('.ip-x').addEventListener('click', close);
    back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey, true);
    body.addEventListener('click', function (e) {
      var t = e.target.closest('[data-val]'); if (t) pick(t.getAttribute('data-val'));
    });
    search.addEventListener('input', function () { renderGrid(search.value); });
    var clearBtn = back.querySelector('.ip-clear');
    if (clearBtn) clearBtn.addEventListener('click', function () { pick(''); });

    var fileInput = back.querySelector('.ip-upload input');
    fileInput.addEventListener('change', async function () {
      var file = fileInput.files && fileInput.files[0]; if (!file) return;
      var lbl = back.querySelector('.ip-upload');
      var prev = lbl.textContent; lbl.textContent = 'Uploading…';
      try {
        var url = await uploadCustom(file);
        toast('success', 'Icon added to the shared pool.');
        pick(url);
      } catch (err) {
        toast('error', 'Upload failed: ' + (err && err.message));
        lbl.textContent = prev;
      }
    });

    document.body.appendChild(back);
    body.innerHTML = '<p class="ip-loading">Loading icons…</p>';
    loadCustom().then(function () { renderGrid(''); search.focus(); });
  }

  /* inject CSS once */
  if (typeof document !== 'undefined' && !document.getElementById('ip-css')) {
    var st = document.createElement('style'); st.id = 'ip-css';
    st.textContent =
      '.ip-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:100000;display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px;overflow-y:auto;}' +
      '.ip-modal{background:var(--card,#fff);color:var(--text,#1f2937);border-radius:12px;width:min(560px,100%);box-shadow:0 16px 40px rgba(0,0,0,.3);display:flex;flex-direction:column;max-height:84vh;}' +
      '.ip-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--border,#e1e4e8);}' +
      '.ip-head h3{margin:0;font-size:15px;}' +
      '.ip-x{border:none;background:none;font-size:17px;cursor:pointer;color:var(--text-muted,#6b7280);}' +
      '.ip-search{margin:10px 14px 4px;padding:7px 10px;border:1px solid var(--border,#e1e4e8);border-radius:6px;background:var(--bg,#f5f6fa);color:inherit;font-size:14px;}' +
      '.ip-body{overflow-y:auto;padding:6px 14px 10px;}' +
      '.ip-loading{color:var(--text-muted,#6b7280);font-size:13px;}' +
      '.ip-group-name{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted,#6b7280);margin:10px 0 4px;}' +
      '.ip-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(40px,1fr));gap:4px;}' +
      '.ip-tile{border:1px solid transparent;border-radius:8px;background:var(--bg,#f5f6fa);cursor:pointer;font-size:22px;line-height:1;padding:6px;display:flex;align-items:center;justify-content:center;min-height:40px;}' +
      '.ip-tile:hover{border-color:var(--primary,#2563eb);}' +
      '.ip-tile.ip-sel{border-color:var(--primary,#2563eb);background:color-mix(in srgb,var(--primary,#2563eb) 12%,transparent);}' +
      '.ip-foot{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid var(--border,#e1e4e8);}' +
      '.ip-upload{border:1px solid var(--border,#e1e4e8);border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;}' +
      '.ip-upload:hover{border-color:var(--primary,#2563eb);}' +
      '.ip-clear{margin-left:auto;border:none;background:none;color:var(--text-muted,#6b7280);cursor:pointer;font-size:13px;}' +
      '.ip-icon-img{border-radius:4px;}';
    document.head.appendChild(st);
  }

  window.ICON_PICKER = { open: open, html: html, isCustom: isUrl, loadCustom: loadCustom };
})();
