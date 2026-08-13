/* research-media.js — V3.546 (images + video) + V3.547 (HTML embeds)
 *
 * Media authoring + rendering for research foci cards. Uploads land under
 * Storage path researchFoci/{fociId}/{mediaId}/… and the resolved download
 * URLs are STORED on the media entry (like user-system.js story covers) so
 * both the RM detail view and the public overview render synchronously with
 * no re-resolve — and public visitors (unauthenticated) can load them.
 *
 * Media entry shapes (media[] on the focus doc):
 *   image: { id, kind:'image', storage_dir, variants:{thumb,medium,full}, mime, caption, order }
 *   video: { id, kind:'video', storage_path, url, poster_url, mime, caption, order }
 *   html:  { id, kind:'html', storage_path, url, poster_url, title, aspect, height_px, caption, order }
 *
 * HTML embeds render as a click-to-activate poster → sandboxed <iframe>
 * (sandbox="allow-scripts allow-pointer-lock allow-fullscreen", NO
 * allow-same-origin) so an uploaded sim runs JS but can never reach the
 * parent origin's Firebase auth. v1 = self-contained single-file HTML only
 * (a warn-validator flags external refs). Globals: window.RESEARCH_MEDIA.
 */
(function () {
  'use strict';

  var RD = window.RESEARCH_DATA;
  var esc = RD.esc;

  function storage() {
    if (typeof firebase === 'undefined' || !firebase.storage) throw new Error('Firebase Storage SDK not loaded.');
    return firebase.storage();
  }
  function toast(kind, msg) { if (window.TOAST && TOAST[kind]) TOAST[kind](msg); }

  function resizeToWebp(file, maxW, quality) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        var c = document.createElement('canvas'), w = img.width, h = img.height;
        if (w > maxW) { h = Math.round(h * (maxW / w)); w = maxW; }
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('Resize failed')); }, 'image/webp', quality);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
      img.src = url;
    });
  }

  async function uploadImageVariants(fociId, mediaId, file) {
    var dir = 'researchFoci/' + fociId + '/' + mediaId;
    var sizes = [{ name: 'thumb', w: 320, q: 0.8 }, { name: 'medium', w: 900, q: 0.85 }, { name: 'full', w: 1800, q: 0.9 }];
    var variants = {};
    for (var i = 0; i < sizes.length; i++) {
      var s = sizes[i];
      var blob = await resizeToWebp(file, s.w, s.q);
      var ref = storage().ref().child(dir + '/' + s.name + '.webp');
      await ref.put(blob, { contentType: 'image/webp' });
      variants[s.name] = await ref.getDownloadURL();
    }
    return { id: mediaId, kind: 'image', storage_dir: dir, variants: variants, mime: 'image/webp' };
  }

  async function uploadRaw(fociId, mediaId, file, contentType, filename) {
    var path = 'researchFoci/' + fociId + '/' + mediaId + '/' + filename;
    var ref = storage().ref().child(path);
    await ref.put(file, { contentType: contentType });
    var url = await ref.getDownloadURL();
    return { storage_path: path, url: url };
  }

  // Warn-only validator: single-file HTML has no external/relative asset refs.
  function htmlSelfContainedWarnings(text) {
    var w = [];
    if (/<link[^>]+rel=["']?stylesheet/i.test(text)) w.push('external stylesheet <link>');
    if (/<script[^>]+src=["'](?!https?:)/i.test(text) || /<script[^>]+src=["']\.?\//i.test(text)) w.push('relative <script src>');
    if (/import\s+[^;]*from\s+["']\.\.?\//i.test(text)) w.push("relative ES-module import");
    if (/(src|href)=["']\.?\.?\//i.test(text)) w.push('relative asset path');
    return w;
  }

  /* ── uploader modal ─────────────────────────────────────────── */

  function openUploader(f, onDone) {
    var m = RD.modal({ title: 'Add media — ' + f.title });
    m.body.innerHTML =
      '<div class="rf-field"><label>Type</label>' +
        '<div class="rf-level-tabs" data-type-tabs>' +
          '<button type="button" class="rf-level-tab active" data-type="image">🖼 Image</button>' +
          '<button type="button" class="rf-level-tab" data-type="video">🎬 Video</button>' +
          '<button type="button" class="rf-level-tab" data-type="html">🕹 Interactive HTML</button>' +
        '</div></div>' +
      '<div class="rf-field"><label data-file-label>Image file</label><input type="file" data-file accept="image/*"></div>' +
      '<div class="rf-field rf-html-extra" hidden><label>Title (shown on the run button)</label><input type="text" data-html-title placeholder="Interactive diffusion sim"></div>' +
      '<div class="rf-field rf-html-extra" hidden><label>Aspect ratio</label><input type="text" data-html-aspect value="16/9" placeholder="16/9"></div>' +
      '<div class="rf-field rf-html-extra" hidden><label>Poster image (optional)</label><input type="file" data-poster accept="image/*"></div>' +
      '<div class="rf-field"><label>Caption</label><input type="text" data-caption placeholder="Optional caption"></div>' +
      '<div class="rf-upload-note" hidden></div>' +
      '<div class="rf-modal-actions"><span class="rf-modal-err" hidden></span>' +
        '<button type="button" class="rf-btn" data-act="cancel">Cancel</button>' +
        '<button type="button" class="rf-btn rf-btn-primary" data-act="upload">Upload</button>' +
      '</div>';

    var type = 'image';
    var fileInput = m.body.querySelector('[data-file]');
    var errEl = m.body.querySelector('.rf-modal-err');
    var noteEl = m.body.querySelector('.rf-upload-note');
    function showErr(msg) { errEl.textContent = msg || ''; errEl.hidden = !msg; }

    m.body.addEventListener('click', function (e) {
      var tab = e.target.closest('[data-type]');
      if (tab) {
        type = tab.getAttribute('data-type');
        m.body.querySelectorAll('[data-type]').forEach(function (b) { b.classList.toggle('active', b === tab); });
        m.body.querySelector('[data-file-label]').textContent = type === 'image' ? 'Image file' : type === 'video' ? 'Video file (mp4/webm)' : 'HTML file (.html)';
        fileInput.setAttribute('accept', type === 'image' ? 'image/*' : type === 'video' ? 'video/mp4,video/webm' : 'text/html,.html,.htm');
        m.body.querySelectorAll('.rf-html-extra').forEach(function (el) { el.hidden = type !== 'html'; });
        noteEl.hidden = true;
        return;
      }
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.getAttribute('data-act') === 'cancel') { m.close(); return; }
      if (act.getAttribute('data-act') === 'upload') { doUpload(act); return; }
    });

    async function doUpload(btn) {
      showErr('');
      var file = fileInput.files && fileInput.files[0];
      if (!file) { showErr('Choose a file.'); return; }
      var caption = (m.body.querySelector('[data-caption]').value || '').trim();
      var mediaId = RD.newId('md');
      btn.disabled = true; btn.textContent = 'Uploading…';
      try {
        var entry;
        if (type === 'image') {
          entry = await uploadImageVariants(f.id, mediaId, file);
        } else if (type === 'video') {
          var vr = await uploadRaw(f.id, mediaId, file, file.type || 'video/mp4', 'clip.' + (/(webm)$/i.test(file.name) ? 'webm' : 'mp4'));
          entry = { id: mediaId, kind: 'video', storage_path: vr.storage_path, url: vr.url, mime: file.type || 'video/mp4' };
        } else {
          var text = await file.text();
          var warns = htmlSelfContainedWarnings(text);
          if (warns.length) {
            noteEl.hidden = false;
            noteEl.innerHTML = '⚠️ This HTML references ' + esc(warns.join(', ')) + '. v1 embeds must be a single self-contained file — external assets will not load. Uploading anyway.';
          }
          var hr = await uploadRaw(f.id, mediaId, new Blob([text], { type: 'text/html' }), 'text/html', 'embed.html');
          entry = {
            id: mediaId, kind: 'html', storage_path: hr.storage_path, url: hr.url,
            title: (m.body.querySelector('[data-html-title]').value || '').trim() || 'Interactive',
            aspect: (m.body.querySelector('[data-html-aspect]').value || '16/9').trim(),
          };
          var pf = m.body.querySelector('[data-poster]').files[0];
          if (pf) { var pv = await uploadImageVariants(f.id, mediaId + '-poster', pf); entry.poster_url = pv.variants.medium || pv.variants.full; }
        }
        entry.caption = caption;
        entry.order = (f.media || []).length;
        var media = (f.media || []).slice(); media.push(entry);
        await RD.update(f.id, { media: media });
        m.close();
        toast('success', 'Media added.');
        if (onDone) onDone();
      } catch (err) {
        showErr(err && err.message || 'Upload failed.');
        btn.disabled = false; btn.textContent = 'Upload';
      }
    }
  }

  /* ── rendering ──────────────────────────────────────────────── */

  function mediaFigure(md, editable) {
    var cap = md.caption ? '<figcaption>' + esc(md.caption) + '</figcaption>' : '';
    var rm = editable ? '<button class="rf-media-rm" data-media-remove="' + esc(md.id) + '" title="Remove">✕</button>' : '';
    if (md.kind === 'image') {
      var src = md.variants ? (md.variants.medium || md.variants.full || md.variants.thumb) : '';
      return '<figure class="rf-media rf-media-image">' + rm + '<img loading="lazy" src="' + esc(src) + '" alt="' + esc(md.caption || '') + '">' + cap + '</figure>';
    }
    if (md.kind === 'video') {
      return '<figure class="rf-media rf-media-video">' + rm + '<video controls preload="metadata"' + (md.poster_url ? ' poster="' + esc(md.poster_url) + '"' : '') + ' src="' + esc(md.url) + '"></video>' + cap + '</figure>';
    }
    if (md.kind === 'html') {
      return htmlEmbed(md, rm, cap);
    }
    return '';
  }

  function htmlEmbed(md, rm, cap) {
    var aspect = md.aspect || '16/9';
    var poster = md.poster_url
      ? '<img class="rf-html-poster-img" src="' + esc(md.poster_url) + '" alt="">'
      : '<span class="rf-html-poster-ph">🕹</span>';
    return '<figure class="rf-media rf-media-html" style="aspect-ratio:' + esc(aspect) + '">' + (rm || '') +
      '<div class="rf-html-shell" data-html-shell data-src="' + esc(md.url) + '">' +
        '<button class="rf-html-activate" type="button">' + poster +
          '<span class="rf-html-run">▶ Run: ' + esc(md.title || 'Interactive') + '</span>' +
        '</button>' +
        '<button class="rf-html-fs" type="button" title="Fullscreen" hidden>⛶</button>' +
      '</div>' + cap +
    '</figure>';
  }

  function renderGallery(container, f, opts) {
    opts = opts || {};
    var media = (f.media || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    if (!media.length) { container.innerHTML = '<p class="rf-empty-sm">No media yet.</p>'; return; }
    container.innerHTML = '<div class="rf-gallery">' + media.map(function (md) { return mediaFigure(md, opts.editable); }).join('') + '</div>';
    if (opts.editable) {
      container.querySelectorAll('[data-media-remove]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var id = btn.getAttribute('data-media-remove');
          if (!confirm('Remove this media item?')) return;
          var next = (f.media || []).filter(function (x) { return x.id !== id; });
          try { await RD.update(f.id, { media: next }); f.media = next; renderGallery(container, f, opts); }
          catch (e) { toast('error', 'Remove failed: ' + (e && e.message)); }
        });
      });
    }
  }

  /* Overview blocks (RM preview + reused shape for public app.js). */
  function renderOverviewBlock(block, f) {
    if (block.kind === 'text') return '<div class="rf-ov-text rf-richtext">' + RD.sanitizeHtml(block.html || '') + '</div>';
    if (block.kind === 'youtube' && block.video_id) {
      var ap = block.autoplay !== false;
      var q = ap ? '?autoplay=1&mute=1&playsinline=1&loop=1&playlist=' + encodeURIComponent(block.video_id) : '?playsinline=1';
      return '<div class="rf-ov-youtube"><iframe loading="lazy" src="https://www.youtube.com/embed/' + esc(block.video_id) + q +
        '" title="YouTube video" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>';
    }
    var md = (f.media || []).filter(function (x) { return x.id === block.media_id; })[0];
    if (!md) return '';
    return '<div class="rf-ov-media">' + mediaFigure(md, false) + '</div>';
  }

  /* Click-to-activate + fullscreen for HTML embeds (delegated once). */
  if (typeof document !== 'undefined') {
    document.addEventListener('click', function (e) {
      var act = e.target.closest('.rf-html-activate');
      if (act) {
        var shell = act.closest('[data-html-shell]');
        if (!shell || shell.querySelector('iframe')) return;
        var src = shell.getAttribute('data-src');
        var iframe = document.createElement('iframe');
        iframe.src = src;
        iframe.setAttribute('sandbox', 'allow-scripts allow-pointer-lock allow-fullscreen');
        iframe.setAttribute('loading', 'lazy');
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.setAttribute('allowfullscreen', '');
        iframe.className = 'rf-html-frame';
        act.remove();
        shell.insertBefore(iframe, shell.firstChild);
        var fs = shell.querySelector('.rf-html-fs'); if (fs) fs.hidden = false;
        return;
      }
      var fsBtn = e.target.closest('.rf-html-fs');
      if (fsBtn) {
        var fig = fsBtn.closest('.rf-media-html');
        if (fig && fig.requestFullscreen) fig.requestFullscreen();
      }
    });
  }

  window.RESEARCH_MEDIA = {
    openUploader: openUploader,
    renderGallery: renderGallery,
    renderOverviewBlock: renderOverviewBlock,
    mediaFigure: mediaFigure,
    uploadImageVariants: uploadImageVariants,
  };
})();
