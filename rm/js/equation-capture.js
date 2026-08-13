/* equation-capture.js — capture SINGLE equations while reading a paper
 * (E3 of Paper Builder III).
 *
 * Flow: select the equation region in the reader (GEOM_SELECTION) → the
 * annotation toolbar's "ƒ" action calls EQUATION_CAPTURE.open({anchors})
 * → the region is SNIPPED from the rendered page canvas → a
 * transcription modal (snip on top; MathLive <math-field> + LaTeX tab
 * below; name + note) → saved as a REGULAR reader annotation
 * (papers/{paperId}/annotations via ANNOTATION_SYNC) with extra fields:
 *
 *   kind: 'equation', annotation_type: 'equation',
 *   latex, name, snip_data_uri (≤600px JPEG, inline — no Storage),
 *   comment (the note), target: {pages: anchors}
 *
 * It therefore inherits anchoring, the notes/comment thread, lab/private
 * visibility, and the type-filter pills for free. The paper BUILDER's
 * equation picker lists these captures (E4) for insertion as blocks.
 *
 * Public API (window.EQUATION_CAPTURE):
 *   init({paperId, viewer})        — per-paper wiring (reader tab attach)
 *   open({anchors})                — create flow from a selection
 *   openForAnnotation(ann)         — edit an existing capture
 *   renderStatic(latex, el)        — static MathLive markup into el
 */
(function () {
  'use strict';

  var _paperId = null;
  var _viewer = null;
  var _cssInjected = false;

  /* V3.461 — ✨ Auto-read: the snip goes to the equationOcr Cloud
   * Function (vision model → LaTeX) so the user verifies instead of
   * typing. Health-probed once per page load: the button only appears
   * (and fresh captures only auto-read) after the function answers, so
   * this client ships safely before the `firebase deploy
   * --only functions:equationOcr` gate. */
  var OCR_URL = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/equationOcr';
  var _ocrHealth = null;
  function _ocrAvailable() {
    if (_ocrHealth) return _ocrHealth;
    _ocrHealth = fetch(OCR_URL, { method: 'GET' })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
    return _ocrHealth;
  }
  function _ocrTranscribe(snipDataUri) {
    var user = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
    return Promise.resolve(user ? user.getIdToken() : null).then(function (tok) {
      return fetch(OCR_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (tok || ''),
        },
        body: JSON.stringify({ image: snipDataUri }),
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.latex) throw new Error(j.error || ('transcription failed (' + r.status + ')'));
        return String(j.latex).trim();
      });
    });
  }

  function init(opts) {
    _paperId = opts.paperId || null;
    _viewer = opts.viewer || null;
  }

  /* Static rendering needs MathLive's stylesheet + fonts css (vendored);
   * injected once on first use. */
  function _injectStaticCss() {
    if (_cssInjected) return;
    _cssInjected = true;
    ['/rm/vendor/mathlive/mathlive-static.css', '/rm/vendor/mathlive/mathlive-fonts.css']
      .forEach(function (href) {
        if (document.querySelector('link[href="' + href + '"]')) return;
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);
      });
  }

  function renderStatic(latex, el) {
    if (!latex || !el || !window.ensureMathlive) return;
    window.ensureMathlive().then(function (ML) {
      _injectStaticCss();
      try {
        el.innerHTML = ML.convertLatexToMarkup(latex, { mathstyle: 'displaystyle' });
      } catch (e) {
        el.textContent = latex;
      }
    }).catch(function () { el.textContent = latex; });
  }

  /* Crop the selection's union rect from the rendered page canvas.
   * Anchors carry page-wrap-local CSS px; the canvas backing store is
   * scaled, so multiply by canvas.width / wrap CSS width. Downscaled to
   * ≤600 px wide JPEG (~40-80 KB) so it inlines in the Firestore doc. */
  function _snipFromAnchors(anchors) {
    try {
      var a = anchors && anchors[0];
      if (!a || !a.rects || !a.rects.length || !_viewer || !_viewer.getPageNode) return null;
      var node = _viewer.getPageNode(a.page);
      if (!node || !node.canvas || !node.wrap) return null;
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      a.rects.forEach(function (r) {
        x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
        x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height);
      });
      var pad = 6;
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
      x1 += pad; y1 += pad;
      var cssW = node.wrap.clientWidth || 1;
      var k = node.canvas.width / cssW;
      var sx = x0 * k, sy = y0 * k, sw = (x1 - x0) * k, sh = (y1 - y0) * k;
      sw = Math.min(sw, node.canvas.width - sx);
      sh = Math.min(sh, node.canvas.height - sy);
      if (sw <= 2 || sh <= 2) return null;
      var outW = Math.min(600, Math.round(sw));
      var outH = Math.round(sh * (outW / sw));
      var off = document.createElement('canvas');
      off.width = outW; off.height = outH;
      var ctx = off.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(node.canvas, sx, sy, sw, sh, 0, 0, outW, outH);
      return off.toDataURL('image/jpeg', 0.85);
    } catch (e) {
      console.warn('[eq-capture] snip failed:', e);
      return null;
    }
  }

  function open(opts) {
    _openModal({ anchors: (opts && opts.anchors) || [], existing: null });
  }
  function openForAnnotation(ann) {
    if (!ann) return;
    _openModal({ anchors: (ann.target && ann.target.pages) || [], existing: ann });
  }

  function _openModal(ctx) {
    var existing = ctx.existing;
    var snip = existing ? (existing.snip_data_uri || null) : _snipFromAnchors(ctx.anchors);

    var old = document.getElementById('eqcap-overlay');
    if (old) old.remove();
    var overlay = document.createElement('div');
    overlay.className = 'eqcap-overlay';
    overlay.id = 'eqcap-overlay';
    var card = document.createElement('div');
    card.className = 'eqcap-card';
    overlay.appendChild(card);

    var head = document.createElement('div');
    head.className = 'eqcap-head';
    head.textContent = existing ? 'Edit captured equation' : 'Capture equation';
    card.appendChild(head);

    if (snip) {
      var snipWrap = document.createElement('div');
      snipWrap.className = 'eqcap-snip';
      var img = document.createElement('img');
      img.src = snip;
      img.alt = 'Snipped equation from the paper';
      snipWrap.appendChild(img);
      card.appendChild(snipWrap);
    }

    var nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.className = 'eqcap-name';
    nameIn.placeholder = 'Name (e.g. Hertzian contact force)';
    nameIn.value = existing ? (existing.name || '') : '';
    card.appendChild(nameIn);

    /* Transcription: Visual (math-field) ⇄ LaTeX tabs. */
    var tabRow = document.createElement('div');
    tabRow.className = 'eqcap-tabs';
    var tabVisual = document.createElement('button');
    tabVisual.type = 'button'; tabVisual.textContent = 'Visual'; tabVisual.className = 'active';
    var tabLatex = document.createElement('button');
    tabLatex.type = 'button'; tabLatex.textContent = 'LaTeX';
    tabRow.appendChild(tabVisual);
    tabRow.appendChild(tabLatex);
    /* V3.461 — ✨ Auto-read (hidden until the OCR function's health
     * probe answers; see the gate after showVisual() below). */
    var ocrBtn = document.createElement('button');
    ocrBtn.type = 'button';
    ocrBtn.className = 'eqcap-ocr-btn';
    ocrBtn.textContent = '✨ Auto-read';
    ocrBtn.title = 'Parse the snipped image to LaTeX automatically (overwrites the field)';
    ocrBtn.style.display = 'none';
    tabRow.appendChild(ocrBtn);
    card.appendChild(tabRow);
    var ocrNote = document.createElement('div');
    ocrNote.className = 'eqcap-ocr-note';
    ocrNote.hidden = true;
    card.appendChild(ocrNote);

    var edHost = document.createElement('div');
    edHost.className = 'eqcap-edhost';
    card.appendChild(edHost);
    var ta = document.createElement('textarea');
    ta.className = 'eqcap-latex';
    ta.rows = 3;
    ta.placeholder = 'Transcribe the equation — e.g. F = \\frac{4}{3} E^* \\sqrt{R}\\, \\delta^{3/2}';
    ta.value = existing ? (existing.latex || '') : '';
    ta.style.display = 'none';
    card.appendChild(ta);

    var mf = null;
    function currentLatex() {
      if (tabVisual.classList.contains('active') && mf) {
        return mf.getValue ? mf.getValue('latex') : mf.value;
      }
      return ta.value;
    }
    function showVisual() {
      tabVisual.classList.add('active'); tabLatex.classList.remove('active');
      ta.style.display = 'none';
      edHost.style.display = '';
      if (!window.ensureMathlive) { showLatex(); return; }
      window.ensureMathlive().then(function () {
        if (!mf) {
          mf = document.createElement('math-field');
          mf.className = 'eqcap-mathfield';
          edHost.textContent = '';
          /* V3.458 — shared accents/matrix/operator snippet bar. */
          if (window.mathliveSnippetBar) edHost.appendChild(window.mathliveSnippetBar(mf));
          edHost.appendChild(mf);
        }
        mf.value = ta.value;
        try { mf.focus(); } catch (e) {}
      }).catch(function () { showLatex(); });
    }
    function showLatex() {
      if (mf) ta.value = mf.getValue ? mf.getValue('latex') : mf.value;
      tabLatex.classList.add('active'); tabVisual.classList.remove('active');
      edHost.style.display = 'none';
      ta.style.display = '';
      ta.focus();
    }
    tabVisual.addEventListener('click', showVisual);
    tabLatex.addEventListener('click', showLatex);

    var noteIn = document.createElement('textarea');
    noteIn.className = 'eqcap-note';
    noteIn.rows = 2;
    noteIn.placeholder = 'Notes — what it means, where it applies… (behaves like any highlight comment)';
    noteIn.value = existing ? (existing.comment || '') : '';
    card.appendChild(noteIn);

    var actions = document.createElement('div');
    actions.className = 'eqcap-actions';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn btn-sm'; cancel.textContent = 'Cancel';
    var save = document.createElement('button');
    save.type = 'button'; save.className = 'btn btn-sm btn-primary';
    save.textContent = existing ? 'Save' : 'Capture';
    actions.appendChild(cancel);
    actions.appendChild(save);
    card.appendChild(actions);

    function close() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    function onKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } }
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', close);
    overlay.addEventListener('mousedown', function (ev) { if (ev.target === overlay) close(); });

    save.addEventListener('click', function () {
      var latex = (currentLatex() || '').trim();
      if (!latex) { alert('Transcribe the equation first (Visual or LaTeX).'); return; }
      if (!window.ANNOTATION_SYNC || !_paperId) { alert('Annotation sync unavailable.'); return; }
      save.disabled = true;
      var p;
      if (existing) {
        p = window.ANNOTATION_SYNC.update(_paperId, existing.id, {
          latex: latex,
          name: nameIn.value.trim(),
          comment: noteIn.value,
        });
      } else {
        var vis = (window.ANNOTATION_PANEL && window.ANNOTATION_PANEL.getDefaultVisibility &&
                   window.ANNOTATION_PANEL.getDefaultVisibility()) || 'lab';
        p = window.ANNOTATION_SYNC.create(_paperId, {
          kind: 'equation',
          annotation_type: 'equation',
          color_id: 'green',
          visibility: vis,
          latex: latex,
          name: nameIn.value.trim(),
          snip_data_uri: snip || null,
          comment: noteIn.value,
          target: { pages: ctx.anchors },
        });
      }
      Promise.resolve(p).then(function () {
        close();
        if (window.GEOM_SELECTION) window.GEOM_SELECTION.clear();
      }).catch(function (e) {
        save.disabled = false;
        alert('Could not save the capture: ' + (e.message || e));
      });
    });

    document.body.appendChild(overlay);
    showVisual();

    /* V3.461 — auto-read gate. Fresh captures (empty field) transcribe
     * themselves as soon as the modal opens; the ✨ button re-runs on
     * demand (e.g. after re-editing). Everything degrades to the manual
     * flow: pre-deploy the probe fails and nothing appears. */
    function runOcr(auto) {
      if (!snip) return;
      ocrBtn.disabled = true;
      ocrNote.hidden = false;
      ocrNote.className = 'eqcap-ocr-note';
      ocrNote.textContent = '✨ Reading the equation from the snip…';
      _ocrTranscribe(snip).then(function (latex) {
        ocrBtn.disabled = false;
        if (auto === true && (currentLatex() || '').trim()) {
          /* The user started typing while the auto-read was in flight —
           * never clobber their work. (The ✨ button always applies.) */
          ocrNote.hidden = true;
          return;
        }
        ta.value = latex;
        if (mf) mf.value = latex;   // Visual tab mounts copy ta.value themselves
        ocrNote.className = 'eqcap-ocr-note eqcap-ocr-ok';
        ocrNote.textContent = '✓ Parsed from the image — check it against the snip before saving.';
      }).catch(function (e) {
        ocrBtn.disabled = false;
        ocrNote.className = 'eqcap-ocr-note eqcap-ocr-err';
        ocrNote.textContent = '⚠ Auto-read failed: ' + (e.message || e) + ' — transcribe manually.';
      });
    }
    if (snip) {
      _ocrAvailable().then(function (ok) {
        if (!ok || !document.body.contains(card)) return;
        ocrBtn.style.display = '';
        ocrBtn.addEventListener('click', function () { runOcr(false); });
        if (!(currentLatex() || '').trim()) runOcr(true);
      });
    }
  }

  window.EQUATION_CAPTURE = {
    init: init,
    open: open,
    openForAnnotation: openForAnnotation,
    renderStatic: renderStatic,
  };
})();
