/* icon-picker.js — shared icon chooser (V3.555)
 *
 * A single, reusable popout icon picker + one shared pool used by every
 * surface that carries an icon. The pool = a curated emoji set PLUS custom
 * icons any lab member uploads (stored once in Firestore `labIcons` +
 * Storage `labIcons/{id}/icon.webp`, so an icon uploaded on one surface is
 * immediately selectable on all of them).
 *
 * An icon VALUE is an icon name ("microscope"), an image URL (custom upload /
 * `data:`), or a legacy emoji from the V3.555 palette. `ICON_PICKER.html(value)`
 * renders every form through ICON.render() — never `esc()` the raw value, or a
 * name prints as a word.
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

  /* Curated pool — grouped, lab-leaning, icon NAMES (V3.861: Heroicons +
   * Lucide, monochrome, never colour-emoji images). Extend freely with any
   * name in scripts/icons.manifest.json; custom uploads append a "Custom"
   * group at the top. A value picked from the V3.555 emoji palette is still
   * valid: ICON.render() maps every one of those glyphs to an icon. */
  var GROUPS = [
    { name: 'Lab & science', icons: ['microscope','beaker','test-tube','flask-conical','pipette','dna','bug-ant','biohazard','syringe','droplet','thermometer','magnet','atom','radiation','telescope','satellite-dish','scale','cog-6-tooth','wrench','wrench-screwdriver','light-bulb','computer-desktop','printer','camera','video-camera','film'] },
    { name: 'Bio & nature', icons: ['sprout','leaf','wheat','brain','heart-pulse','bone','eye','rat','fish','shell','flower-2','waves','fire','snowflake','sun','star','sparkles','rainbow','orbit','globe-alt','circle-dot','puzzle-piece','cube','cube-transparent'] },
    { name: 'Docs & work', icons: ['document-text','bookmark-square','chart-bar','arrow-trending-up','arrow-trending-down','presentation-chart-bar','rectangle-stack','folder','folder-open','archive-box','clipboard-document-list','pencil-square','pencil','pen-line','pin','paper-clip','bookmark','tag','books','book-open','academic-cap','trophy','target','compass','map','calendar-days','clock','flag'] },
    { name: 'Symbols', icons: ['check-circle','x-circle','question-mark-circle','exclamation-circle','exclamation-triangle','plus','minus','arrow-path','bolt','rocket-launch','gem','diamond','brick-wall','heart','hand-thumb-up','users','home','building-library'] },
    /* colour IS the meaning here, so these stay coloured: a solid dot, not an image.
     * Stored as the glyph so older picks (V3.555 palette) keep rendering. */
    { name: 'Markers', icons: ['\u{1F534}','\u{1F7E0}','\u{1F7E1}','\u{1F7E2}','\u{1F535}','\u{1F7E3}','\u26AB'], labels: ['red','orange','yellow','green','blue','purple','black'] },  // emoji-ok: stored glyph values, ICON.render draws them as tinted dots
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
    if (!value) return '';
    if (window.ICON) {
      var px = /^\d+(\.\d+)?px$/.test(size) ? parseFloat(size) : null;
      return '<span class="ip-icon" style="font-size:' + esc(size) + '">' + ICON.render(value, px ? { size: px } : {}) + '</span>';
    }
    return esc(value);
  }

  /* ── popout ─────────────────────────────────────────────────── */
  function open(opts) {
    opts = opts || {};
    var back = document.createElement('div');
    back.className = 'ip-backdrop';
    back.innerHTML =
      '<div class="ip-modal" role="dialog" aria-modal="true">' +
        '<div class="ip-head"><h3>' + esc(opts.title || 'Choose an icon') + '</h3>' +
          '<button class="ip-x" aria-label="Close">' + (window.ICON ? ICON.svg('x-mark') : '✕') + '</button></div>' +
        '<input type="search" class="ip-search" placeholder="Search icons…">' +
        '<div class="ip-body"></div>' +
        '<div class="ip-foot">' +
          '<label class="ip-upload"><input type="file" accept="image/*" hidden><span class="ip-upload-txt">＋ Upload custom icon</span></label>' +
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
        // names are searchable: "flask", "cell", "chart" narrow the grid
        var items = g.icons.map(function (v, i) {
          return { v: v, label: (g.labels && g.labels[i]) || String(v).replace(/-/g, ' ') };
        }).filter(function (it) {
          return !filter || it.label.indexOf(filter) !== -1 || g.name.toLowerCase().indexOf(filter) !== -1;
        });
        if (!items.length) return;
        out += '<div class="ip-group-name">' + esc(g.name) + '</div><div class="ip-grid">' +
          items.map(function (it) { return tile(it.v, it.label); }).join('') + '</div>';
      });
      if (!out) out = '<p class="ip-loading">No icon matches “' + esc(filter) + '”.</p>';
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
      var lbl = back.querySelector('.ip-upload-txt');
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
      '.ip-icon-img{border-radius:4px;}' +
      '.ip-icon{display:inline-flex;align-items:center;justify-content:center;line-height:1;vertical-align:middle;}';
    document.head.appendChild(st);
  }

  window.ICON_PICKER = { open: open, html: html, isCustom: isUrl, loadCustom: loadCustom };
})();
