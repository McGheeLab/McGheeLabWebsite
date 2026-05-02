/* library-paper.js — orchestrator for pages/library-paper.html.
 *
 * Reads ?id=<paper-id> from the URL, loads items.json, locates the paper
 * item, mints a Firebase signed URL for its PDF, and mounts the pdf.js
 * viewer.
 *
 * Phase 2 scope: metadata panel + viewer + page nav + zoom. No annotations
 * yet — that's Phase 3.
 */

(function () {
  let _viewer = null;
  let _item = null;
  let _allItems = [];          // full items list, kept in memory for save + tag index
  let _tagIndex = null;        // rebuilt from _allItems when needed
  let _annotations = [];
  let _colors = [];
  let _unsubscribeSync = null;
  let _fitMode = true;  // when true, layout changes re-fit to viewer width

  function _qs(key) {
    return new URLSearchParams(window.location.search).get(key);
  }

  function _setStatus(msg, kind) {
    const el = document.getElementById('lp-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'lp-status ' + (kind || '');
  }

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function _renderMetadata(item) {
    const lib = (item.meta && item.meta.library) || {};
    const titleEl = document.getElementById('lp-title');
    if (titleEl) titleEl.textContent = item.title || 'Untitled';

    const authorLine = (lib.authors || [])
      .map(a => [a.given, a.family].filter(Boolean).join(' '))
      .join('; ');
    const subEl = document.getElementById('lp-subtitle');
    if (subEl) {
      const parts = [
        authorLine,
        [lib.journal, lib.year].filter(Boolean).join(' · '),
      ].filter(Boolean);
      subEl.textContent = parts.join(' — ');
    }

    const metaEl = document.getElementById('lp-metadata');
    if (!metaEl) return;
    const rows = [
      ['Authors', authorLine],
      ['Year', lib.year],
      ['Journal', lib.journal],
      ['Volume / Issue / Pages',
        [lib.volume && `Vol ${lib.volume}`, lib.issue && `Iss ${lib.issue}`, lib.pages]
          .filter(Boolean).join(' · ')],
      ['DOI', lib.doi ? `<a href="https://doi.org/${_esc(lib.doi)}" target="_blank" rel="noopener">${_esc(lib.doi)}</a>` : ''],
      ['PMID', lib.pmid ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${_esc(lib.pmid)}/" target="_blank" rel="noopener">${_esc(lib.pmid)}</a>` : ''],
      ['arXiv', lib.arxiv_id ? `<a href="https://arxiv.org/abs/${_esc(lib.arxiv_id)}" target="_blank" rel="noopener">${_esc(lib.arxiv_id)}</a>` : ''],
      ['Citation key', lib.citation_key ? `<code>${_esc(lib.citation_key)}</code>` : ''],
      ['Source', lib.source || ''],
      ['Date added', lib.date_added || ''],
      ['Uploaded by', (lib.pdf && lib.pdf.uploaded_by) || ''],
    ].filter(([, v]) => v);

    metaEl.innerHTML = rows.map(([k, v]) =>
      `<div class="lp-meta-row"><span class="lp-meta-key">${_esc(k)}</span><span class="lp-meta-val">${v}</span></div>`
    ).join('');

    const absEl = document.getElementById('lp-abstract');
    if (absEl) {
      if (lib.abstract) {
        absEl.style.display = '';
        absEl.innerHTML = `<div class="lp-section-title">Abstract</div><div class="lp-abstract-body">${_esc(lib.abstract)}</div>`;
      } else {
        absEl.style.display = 'none';
      }
    }

    const tagEl = document.getElementById('lp-tags');
    if (tagEl) {
      const labels = (lib.labels || []).map(l => `<span class="lp-chip">${_esc(l)}</span>`).join('');
      const folders = (lib.folders || []).map(f => `<span class="lp-chip lp-chip-folder">${_esc(f)}</span>`).join('');
      // Note: lp-tags only carries the legacy folder/label chips. The new
      // multi-tag editor lives in #lp-tag-editor (rendered separately).
      tagEl.innerHTML = labels + folders;
    }
  }

  // Render the multi-category tag editor inside the side panel. Inserts
  // a new container after #lp-tags if not present yet.
  function _renderTagEditor(item) {
    const sideInner = document.querySelector('.lp-side-inner');
    if (!sideInner) return;
    let host = document.getElementById('lp-tag-editor');
    if (!host) {
      host = document.createElement('div');
      host.id = 'lp-tag-editor';
      host.style.margin = '10px 0';
      // Insert after #lp-tags (legacy chips) or near the top.
      const after = document.getElementById('lp-tags') || sideInner.firstElementChild;
      after.insertAdjacentElement('afterend', host);
    }
    const lib = (item.meta && item.meta.library) || {};
    const tags = (window.LIBRARY_TAGS ? LIBRARY_TAGS.getTags(item) : (lib.tags || []));
    host.innerHTML = `
      <div class="lp-section-title" style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#6b7280;margin-bottom:4px;">Categories</div>
      <div id="lp-tag-list" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;"></div>
      <div style="display:flex;gap:4px;align-items:center;position:relative;">
        <input type="text" id="lp-tag-input" placeholder="Add tag (e.g. research:papers:2026:GELS)" style="flex:1;padding:4px 8px;font-size:11px;border:1px solid #d1d5db;border-radius:6px;font-family:ui-monospace,monospace;">
        <button class="btn btn-sm" id="lp-tag-add" style="padding:3px 10px;font-size:11px;">Add</button>
        <div id="lp-tag-suggest" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #d1d5db;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.08);z-index:10;max-height:200px;overflow:auto;font-size:11px;"></div>
      </div>
      <div style="font-size:10px;color:#9ca3af;margin-top:4px;">Colon-delimited path. Multi-tag — same paper can carry several. <code>research:papers:2026</code> filters all 2026 papers.</div>
    `;
    _renderTagChips(tags);

    const input = document.getElementById('lp-tag-input');
    const addBtn = document.getElementById('lp-tag-add');
    const suggest = document.getElementById('lp-tag-suggest');

    const commit = async () => {
      const v = (input.value || '').trim();
      if (!v) return;
      await _tagAdd(v);
      input.value = '';
      _hideSuggest();
    };

    addBtn.addEventListener('click', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { _hideSuggest(); }
      else if (e.key === 'ArrowDown' && suggest.style.display !== 'none') {
        e.preventDefault();
        const first = suggest.querySelector('[data-suggest]');
        if (first) first.focus();
      }
    });
    input.addEventListener('input', () => _refreshSuggest(input.value));
    input.addEventListener('focus', () => _refreshSuggest(input.value));
    document.addEventListener('click', (e) => {
      if (!host.contains(e.target)) _hideSuggest();
    });
    suggest.addEventListener('click', (e) => {
      const el = e.target.closest('[data-suggest]');
      if (!el) return;
      input.value = el.getAttribute('data-suggest');
      _hideSuggest();
      commit();
    });

    document.getElementById('lp-tag-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-tag-remove]');
      if (!btn) return;
      const tag = btn.getAttribute('data-tag-remove');
      await _tagRemove(tag);
    });

    function _hideSuggest() { suggest.style.display = 'none'; suggest.innerHTML = ''; }
    function _refreshSuggest(prefix) {
      if (!window.LIBRARY_TAGS || !_tagIndex) return _hideSuggest();
      const list = LIBRARY_TAGS.suggestions(prefix, _tagIndex, 8);
      if (!list.length) return _hideSuggest();
      suggest.innerHTML = list.map(t =>
        `<div data-suggest="${_esc(t)}" tabindex="0" style="padding:5px 8px;cursor:pointer;font-family:ui-monospace,monospace;border-bottom:1px solid #f3f4f6;">${_esc(t)}</div>`
      ).join('');
      suggest.style.display = 'block';
    }
  }

  function _renderTagChips(tags) {
    const ul = document.getElementById('lp-tag-list');
    if (!ul) return;
    if (!tags || !tags.length) {
      ul.innerHTML = '<span style="font-size:11px;color:#9ca3af;font-style:italic;">No tags yet — add one below to group this paper.</span>';
      return;
    }
    ul.innerHTML = tags.map(t => `
      <span style="display:inline-flex;align-items:center;gap:4px;background:#dbeafe;color:#1e3a8a;border:1px solid #bfdbfe;border-radius:14px;padding:2px 8px;font-size:11px;font-family:ui-monospace,monospace;">
        ${_esc(t)}
        <button data-tag-remove="${_esc(t)}" title="Remove tag" style="background:transparent;border:none;color:#1e3a8a;cursor:pointer;padding:0;font-size:13px;line-height:1;">×</button>
      </span>
    `).join('');
  }

  async function _tagAdd(tagRaw) {
    if (!window.LIBRARY_TAGS) return;
    const norm = LIBRARY_TAGS.normalize(tagRaw);
    if (!norm) return;
    const lib = (_item.meta && _item.meta.library) || {};
    const cur = LIBRARY_TAGS.getTags(_item);
    if (cur.includes(norm)) return;
    const next = cur.concat(norm);
    await _saveTags(next);
  }

  async function _tagRemove(tag) {
    if (!window.LIBRARY_TAGS) return;
    const cur = LIBRARY_TAGS.getTags(_item);
    const next = cur.filter(t => t !== tag);
    await _saveTags(next);
  }

  // Render the public-share widget below the tag editor. Hidden when the
  // paper has no PDF (nothing to share) or when LIBRARY_SHARE didn't load.
  function _renderShareWidget(item) {
    const sideInner = document.querySelector('.lp-side-inner');
    if (!sideInner) return;
    let host = document.getElementById('lp-share-widget');
    if (!host) {
      host = document.createElement('div');
      host.id = 'lp-share-widget';
      host.style.margin = '10px 0';
      const after = document.getElementById('lp-tag-editor') || document.getElementById('lp-tags');
      if (after) after.insertAdjacentElement('afterend', host);
      else sideInner.appendChild(host);
    }
    if (!window.LIBRARY_SHARE) {
      host.style.display = 'none';
      return;
    }
    const lib = (item.meta && item.meta.library) || {};
    if (!lib.pdf || !lib.pdf.storage_path) {
      host.innerHTML = `<div style="font-size:11px;color:#9ca3af;font-style:italic;">No PDF attached — sharing isn't available for this paper.</div>`;
      return;
    }
    const isPublic = !!lib.public;
    const shareUrl = LIBRARY_SHARE.buildShareUrl(item);
    host.innerHTML = `
      <div class="lp-section-title" style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#6b7280;margin-bottom:4px;">Public sharing</div>
      <div style="display:flex;align-items:center;gap:6px;">
        <button id="lp-share-toggle" class="btn btn-sm" style="font-size:11px;${isPublic ? 'background:#dcfce7;color:#166534;border-color:#86efac;' : ''}">
          ${isPublic ? '✓ Public — click to revoke' : '🔗 Share publicly'}
        </button>
        <span id="lp-share-status" style="font-size:10px;color:#6b7280;flex:1;"></span>
      </div>
      ${isPublic ? `
        <div style="margin-top:6px;padding:6px 8px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;font-size:11px;">
          <div style="color:#166534;margin-bottom:4px;">Anyone with this link can read the paper:</div>
          <div style="display:flex;gap:4px;align-items:center;">
            <input id="lp-share-url" readonly value="${_esc(shareUrl)}" style="flex:1;padding:4px 6px;font-size:10px;border:1px solid #bbf7d0;border-radius:4px;font-family:ui-monospace,monospace;background:#fff;">
            <button id="lp-share-copy" class="btn btn-sm" style="font-size:10px;padding:3px 8px;">Copy</button>
          </div>
        </div>
      ` : `
        <div style="margin-top:4px;font-size:10px;color:#9ca3af;">Generates a long-lived public URL anyone can open. No sign-in required for the recipient.</div>
      `}
    `;

    document.getElementById('lp-share-toggle').addEventListener('click', async () => {
      const status = document.getElementById('lp-share-status');
      try {
        if (lib.public) {
          if (!confirm('Revoke public access?\n\nThe link will return 404 to new visitors. Note: anyone who already has the long-lived URL can still load the PDF directly until you rotate the Storage download token in Firebase console.')) return;
          status.textContent = 'Revoking…';
          await LIBRARY_SHARE.unshare(item);
          status.textContent = 'Revoked.';
          _renderShareWidget(item);
        } else {
          if (!confirm('Share this paper publicly?\n\nAnyone with the resulting URL can read the metadata and download the PDF — without signing in.')) return;
          status.textContent = 'Generating link…';
          const out = await LIBRARY_SHARE.share(item);
          status.textContent = 'Link copied!';
          _renderShareWidget(item);
        }
      } catch (e) {
        console.error('[library-paper] share toggle failed:', e);
        status.textContent = `Error: ${e.message || e}`;
        status.style.color = '#b91c1c';
      }
    });

    const copyBtn = document.getElementById('lp-share-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const input = document.getElementById('lp-share-url');
        try {
          await navigator.clipboard.writeText(input.value);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
        } catch (_) {
          input.select();
        }
      });
    }
  }

  async function _saveTags(nextTags) {
    if (!_item) return;
    _setStatus('Saving tags…');
    try {
      // Re-fetch items.json to merge with any concurrent changes (a peer
      // might have edited their own paper while we had ours open).
      const data = await api.load('items.json');
      const items = (data && data.items) || [];
      const idx = items.findIndex(it => it.id === _item.id);
      if (idx < 0) {
        _setStatus('This paper is no longer in items.json.', 'error');
        return;
      }
      items[idx].meta = items[idx].meta || {};
      items[idx].meta.library = items[idx].meta.library || {};
      items[idx].meta.library.tags = window.LIBRARY_TAGS
        ? LIBRARY_TAGS.parse(nextTags)
        : nextTags;
      await api.save('items.json', { items });
      _allItems = items;
      _item = items[idx];
      _tagIndex = LIBRARY_TAGS.buildIndex(items.filter(it => it.type === 'paper' && it.meta && it.meta.library && it.meta.library.is_library_entry));
      _renderTagChips(_item.meta.library.tags || []);
      // Re-render the share widget too — its closure captured the previous
      // lib reference, which we just replaced.
      _renderShareWidget(_item);
      _setStatus('');
    } catch (e) {
      console.error(e);
      _setStatus(`Save failed: ${e.message || e}`, 'error');
    }
  }

  // ---- Resizable / collapsible side panels ------------------------------

  const LP_LAYOUT_KEY = 'rm_lp_layout';
  const LP_LAYOUT_DEFAULTS = { leftW: 240, rightW: 300, leftCollapsed: false, rightCollapsed: false };
  const LP_LIMITS = { minW: 180, maxW: 560 };

  function _readLayout() {
    try {
      const raw = localStorage.getItem(LP_LAYOUT_KEY);
      if (!raw) return Object.assign({}, LP_LAYOUT_DEFAULTS);
      return Object.assign({}, LP_LAYOUT_DEFAULTS, JSON.parse(raw));
    } catch (_) {
      return Object.assign({}, LP_LAYOUT_DEFAULTS);
    }
  }
  function _writeLayout(state) {
    try { localStorage.setItem(LP_LAYOUT_KEY, JSON.stringify(state)); } catch (_) { /* quota — ignore */ }
  }

  function _applyLayout(state) {
    const root = document.getElementById('lp-split');
    if (!root) return;
    root.style.setProperty('--lp-left-w', state.leftCollapsed ? '32px' : `${state.leftW}px`);
    root.style.setProperty('--lp-right-w', state.rightCollapsed ? '32px' : `${state.rightW}px`);
    root.classList.toggle('lp-left-collapsed', !!state.leftCollapsed);
    root.classList.toggle('lp-right-collapsed', !!state.rightCollapsed);
    if (window.ANNOTATION_OVERLAY) window.ANNOTATION_OVERLAY.redraw();
  }

  function _wireLayout() {
    const layout = _readLayout();
    _applyLayout(layout);

    // Collapse / expand buttons
    function bindToggle(buttonId, sideKey, collapse) {
      const btn = document.getElementById(buttonId);
      if (!btn) return;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        layout[sideKey] = !!collapse;
        _writeLayout(layout);
        _applyLayout(layout);
        _maybeRefit();
      });
    }
    bindToggle('lp-collapse-left',  'leftCollapsed',  true);
    bindToggle('lp-expand-left',    'leftCollapsed',  false);
    bindToggle('lp-collapse-right', 'rightCollapsed', true);
    bindToggle('lp-expand-right',   'rightCollapsed', false);

    // Drag-to-resize handles
    function bindResize(handleId, side) {
      const handle = document.getElementById(handleId);
      if (!handle) return;
      handle.addEventListener('mousedown', (ev) => {
        // Don't start a resize if the user is clicking on a collapsed strip.
        if (side === 'left' && layout.leftCollapsed) return;
        if (side === 'right' && layout.rightCollapsed) return;
        ev.preventDefault();
        const startX = ev.clientX;
        const startW = side === 'left' ? layout.leftW : layout.rightW;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        function onMove(mev) {
          const dx = mev.clientX - startX;
          let next = side === 'left' ? startW + dx : startW - dx;
          next = Math.max(LP_LIMITS.minW, Math.min(LP_LIMITS.maxW, next));
          if (side === 'left') layout.leftW = next; else layout.rightW = next;
          _applyLayout(layout);
        }
        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          _writeLayout(layout);
          _maybeRefit();
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }
    bindResize('lp-resizer-left',  'left');
    bindResize('lp-resizer-right', 'right');
  }

  function _wireToolbar() {
    const prevBtn = document.getElementById('lp-prev');
    const nextBtn = document.getElementById('lp-next');
    const pageInput = document.getElementById('lp-page-input');
    const zoomInBtn = document.getElementById('lp-zoom-in');
    const zoomOutBtn = document.getElementById('lp-zoom-out');
    const zoomLabel = document.getElementById('lp-zoom-label');
    const fitBtn = document.getElementById('lp-fit');

    prevBtn?.addEventListener('click', () => _viewer && _viewer.prev());
    nextBtn?.addEventListener('click', () => _viewer && _viewer.next());
    pageInput?.addEventListener('change', () => {
      if (!_viewer) return;
      const n = parseInt(pageInput.value, 10);
      if (!isNaN(n)) _viewer.gotoPage(n);
    });
    zoomInBtn?.addEventListener('click', () => {
      _fitMode = false;
      _viewer && _viewer.zoomIn();
    });
    zoomOutBtn?.addEventListener('click', () => {
      _fitMode = false;
      _viewer && _viewer.zoomOut();
    });
    fitBtn?.addEventListener('click', () => {
      _fitMode = true;
      if (_viewer && _viewer.fitToWidth) {
        _viewer.fitToWidth().then(() => {
          if (window.ANNOTATION_OVERLAY) window.ANNOTATION_OVERLAY.redraw();
        });
      }
    });

    // Keyboard nav within the viewer
    document.addEventListener('keydown', (e) => {
      if (!_viewer) return;
      if (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { _viewer.next(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { _viewer.prev(); e.preventDefault(); }
      else if (e.key === '+' || (e.key === '=' && e.shiftKey)) { _fitMode = false; _viewer.zoomIn(); e.preventDefault(); }
      else if (e.key === '-') { _fitMode = false; _viewer.zoomOut(); e.preventDefault(); }
    });
  }

  function _onPageChange(p) {
    const pageInput = document.getElementById('lp-page-input');
    const total = document.getElementById('lp-page-total');
    if (pageInput) pageInput.value = String(p);
    if (total && _viewer) total.textContent = `/ ${_viewer.numPages}`;
  }

  function _onZoomChange(z) {
    const lbl = document.getElementById('lp-zoom-label');
    if (lbl) lbl.textContent = `${Math.round(z * 100)}%`;
  }

  async function _mountViewer(pdfUrl, viewerOpts = {}) {
    const container = document.getElementById('lp-viewer');
    if (!container) throw new Error('Viewer container missing');
    _viewer = await window.PDF_VIEWER.create(container, pdfUrl, {
      fitToContainer: true,                  // initial zoom = fit-to-width
      onPageChange: _onPageChange,
      onZoomChange: _onZoomChange,
      disableRange: viewerOpts.disableRange,
      disableStream: viewerOpts.disableStream,
      // Redraw the highlight overlay for each page the moment its wrap
      // resizes during a refit. Without this, fitToWidth resizes pages
      // one-by-one (canvas grows) while the overlay rects stay at the old
      // zoom — visible "highlights shrink then snap" flicker.
      onPageReady: (pageNum) => {
        if (window.ANNOTATION_OVERLAY) {
          try { window.ANNOTATION_OVERLAY.redrawPage(pageNum); } catch (_) { /* not initialized yet */ }
        }
      },
    });
    _onPageChange(1);
    _onZoomChange(_viewer.zoom);
    _setStatus('');
  }

  async function _maybeRefit() {
    if (!(_fitMode && _viewer && _viewer.fitToWidth)) return;
    await _viewer.fitToWidth();
    // pdf-viewer.fitToWidth() goes through its internal setZoom, NOT the
    // monkey-patched _viewer.setZoom that triggers ANNOTATION_OVERLAY.redraw,
    // so we have to redraw highlights here. Otherwise resizing or
    // collapsing a side panel re-renders the PDF at a new zoom while the
    // overlay rects stay scaled to the old zoom — visible offsets.
    if (window.ANNOTATION_OVERLAY) window.ANNOTATION_OVERLAY.redraw();
  }

  // ---- Annotation wiring -------------------------------------------------

  async function _loadColors() {
    try {
      const data = await api.load('library/highlight_colors.json');
      _colors = (data && data.colors) || [];
    } catch (e) {
      console.warn('[library-paper] could not load highlight_colors.json', e);
      _colors = [
        { id: 'yellow', name: 'Note', hex: '#facc15', meaning: 'General note', auto_flags: [] },
      ];
    }
  }

  async function _mountAnnotations() {
    if (!_item || !_viewer) return;
    const paperId = _item.id;
    const user = firebase.auth().currentUser;
    // Render the annotation list into the inner scroll container. Toolbar
    // and collapse buttons are siblings of #lp-annotations-inner inside
    // #lp-annotations, so they survive the inner div's re-render.
    const panelEl = document.getElementById('lp-annotations-inner')
                 || document.getElementById('lp-annotations');
    const viewerEl = document.getElementById('lp-viewer');

    function _applyFilter() {
      const fn = window.ANNOTATION_PANEL.getFilterFn();
      window.ANNOTATION_OVERLAY.setFilter(fn);
    }

    window.ANNOTATION_OVERLAY.init({
      viewer: _viewer,
      container: viewerEl,
      getColors: () => _colors,
      onCreate: async ({ anchors, colorId }) => {
        const color = _colors.find(c => c.id === colorId);
        const autoFlags = (color && color.auto_flags) || [];
        const visibility = window.ANNOTATION_PANEL.getDefaultVisibility() || 'lab';
        try {
          await window.ANNOTATION_SYNC.create(paperId, {
            color_id: colorId,
            visibility,
            target: { pages: anchors },
            marked_for_investigation: autoFlags.includes('marked_for_investigation'),
          });
        } catch (e) {
          alert(`Could not save highlight: ${e.message}`);
        }
      },
      onSelect: (annId) => {
        window.ANNOTATION_OVERLAY.focus(annId);
      },
    });

    // Geometric selection — replaces browser-native Range walking. Drives
    // the create-toolbar via ANNOTATION_OVERLAY.onSelectionCommit.
    window.GEOM_SELECTION.init({
      viewer: _viewer,
      viewerEl,
      onCommit: (anchors) => window.ANNOTATION_OVERLAY.onSelectionCommit(anchors),
    });

    // Cmd+C / Ctrl+C → write the geometric-selection's text to the clipboard.
    // Native browser selection is disabled on the text layer, so we do this
    // ourselves to keep copy-paste working.
    document.addEventListener('copy', (ev) => {
      if (!window.GEOM_SELECTION) return;
      const text = window.GEOM_SELECTION.selectedText();
      if (!text) return;
      ev.preventDefault();
      ev.clipboardData.setData('text/plain', text);
    });

    // Load draft list (paper items that aren't library entries) + lab-
    // shared annotation groups, both used by the per-card UI.
    let _drafts = [];
    try {
      const itemsData = await api.load('items.json');
      _drafts = (itemsData.items || []).filter(it => {
        if (it.type !== 'paper') return false;
        const lib = (it.meta || {}).library || {};
        return !lib.is_library_entry;
      }).map(it => ({ id: it.id, title: it.title || it.id }));
    } catch (e) {
      console.warn('[library-paper] could not load items.json for drafts:', e.message);
    }

    let _groups = [{ id: 'general', name: 'General' }];
    if (window.ANNOTATION_GROUPS) {
      try {
        await window.ANNOTATION_GROUPS.ensureSeed();
      } catch (e) {
        console.warn('[library-paper] annotation-groups seed failed:', e.message);
      }
      window.ANNOTATION_GROUPS.subscribe((g) => {
        _groups = g.slice();
        // Re-render the panel so new groups appear in dropdowns immediately.
        window.ANNOTATION_PANEL.setAnnotations(_annotations);
        _applyFilter();
      });
    }

    window.ANNOTATION_PANEL.init({
      rootEl: panelEl,
      viewer: _viewer,
      getColors: () => _colors,
      getDrafts: () => _drafts,
      getGroups: () => _groups,
      currentUserUid: (user && user.uid) || '',
      defaultVisibility: 'lab',
      onFocus: (annId) => window.ANNOTATION_OVERLAY.focus(annId),
      onUpdate: async (annId, patch) => {
        try {
          await window.ANNOTATION_SYNC.update(paperId, annId, patch);
        } catch (e) {
          alert(`Update failed: ${e.message}`);
        }
      },
      onDelete: async (annId) => {
        try {
          await window.ANNOTATION_SYNC.remove(paperId, annId);
        } catch (e) {
          alert(`Delete failed: ${e.message}`);
        }
      },
      onCreateGroup: async (name) => {
        if (!window.ANNOTATION_GROUPS) throw new Error('annotation-groups module missing');
        return await window.ANNOTATION_GROUPS.create(name);
      },
      onCiteToggle: async (annId, draftId, on) => {
        try {
          // Use Firestore arrayUnion / arrayRemove so concurrent edits
          // from two users don't clobber each other.
          const op = on ? 'add' : 'remove';
          await window.ANNOTATION_SYNC.toggleCiteInDraft(paperId, annId, draftId, op);
        } catch (e) {
          alert(`Could not ${on ? 'tag' : 'untag'} draft: ${e.message}`);
        }
      },
    });
    window.ANNOTATION_PANEL.onFilterChange(_applyFilter);

    _unsubscribeSync = window.ANNOTATION_SYNC.start({
      paperId,
      onChange: (list) => {
        _annotations = list;
        window.ANNOTATION_OVERLAY.setAnnotations(list);
        window.ANNOTATION_PANEL.setAnnotations(list);
        _applyFilter();
      },
      onError: (err) => {
        console.error('[library-paper] annotation sync error:', err);
        const panel = document.getElementById('lp-annotations');
        if (panel) {
          panel.innerHTML = `<div class="lp-annotations-empty">Annotation sync error: ${(err.message || err).toString().replace(/[<>]/g, '')}<br><small>Check Firestore security rules — see plan §B.</small></div>`;
        }
      },
    });

    // Re-render overlays after each pdf.js render (zoom changes redraw text
    // layer which invalidates rect positions).
    const origSetZoom = _viewer.setZoom;
    _viewer.setZoom = async function (z) {
      const r = await origSetZoom.call(_viewer, z);
      window.ANNOTATION_OVERLAY.redraw();
      return r;
    };
  }

  async function _waitForAuth(timeoutMs) {
    if (typeof firebase === 'undefined' || !firebase.auth) {
      throw new Error('Firebase SDK not loaded');
    }
    if (firebase.auth().currentUser) return firebase.auth().currentUser;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Sign-in timed out — sign in via the avatar in the top nav.')), timeoutMs || 30000);
      const unsub = firebase.auth().onAuthStateChanged(u => {
        if (u) {
          clearTimeout(t);
          unsub();
          resolve(u);
        }
      });
    });
  }

  async function init() {
    _wireLayout();
    _wireToolbar();
    const id = _qs('id');
    if (!id) {
      _setStatus('No paper id in URL (expected ?id=...)', 'error');
      return;
    }
    try {
      _setStatus('Loading paper…');
      const data = await api.load('items.json');
      _allItems = data.items || [];
      _item = _allItems.find(it => it.id === id);
      if (!_item) {
        _setStatus(`Paper ${id} not found in items.json`, 'error');
        return;
      }
      // Rebuild tag autocomplete index from the whole items list — the
      // editor uses it for suggestion popups.
      _tagIndex = window.LIBRARY_TAGS
        ? LIBRARY_TAGS.buildIndex(_allItems.filter(it => it.type === 'paper' && it.meta && it.meta.library && it.meta.library.is_library_entry))
        : null;
      _renderMetadata(_item);
      _renderTagEditor(_item);
      _renderShareWidget(_item);
      const lib = _item.meta && _item.meta.library;
      if (!lib || !lib.pdf || !lib.pdf.storage_path) {
        _setStatus('No PDF attached to this paper.', 'error');
        return;
      }
      _setStatus('Authenticating…');
      try {
        await _waitForAuth(15000);
      } catch (e) {
        _setStatus(e.message || 'Sign-in required to view the PDF.', 'error');
        return;
      }
      _setStatus('Fetching signed URL…');
      const signedUrl = await window.LIBRARY_UPLOAD.downloadUrl(lib.pdf.storage_path);
      // pdf.js's range-fetch triggers CORS against Firebase Storage. On the
      // local-dev runtime we proxy through server.py's /api/library/pdf-proxy
      // to dodge it. On the static deploy that endpoint doesn't exist, so we
      // hit Firebase Storage directly with disableRange + disableStream — pdf.js
      // downloads the full PDF in one cross-origin GET (Storage allows simple
      // cross-origin GETs, just not Range preflights).
      const isDeploy = window.RM_RUNTIME && window.RM_RUNTIME.isDeploy;
      const fetchUrl = isDeploy
        ? signedUrl
        : `/api/library/pdf-proxy?url=${encodeURIComponent(signedUrl)}`;
      _setStatus('Rendering…');
      await _mountViewer(fetchUrl, { disableRange: isDeploy, disableStream: isDeploy });
      _setStatus('Loading colors…');
      await _loadColors();
      _setStatus('Loading annotations…');
      await _mountAnnotations();
      _setStatus('');
    } catch (e) {
      console.error(e);
      _setStatus(`Error: ${e.message || e}`, 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('beforeunload', () => {
    try { _unsubscribeSync && _unsubscribeSync(); } catch (_) { /* ignore */ }
    try { window.ANNOTATION_OVERLAY && window.ANNOTATION_OVERLAY.destroy(); } catch (_) { /* ignore */ }
    try { _viewer && _viewer.destroy(); } catch (_) { /* ignore */ }
  });
})();
