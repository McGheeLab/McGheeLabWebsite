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
  let _viewer = null;          // the ACTIVE tab's pdf.js viewer
  let _item = null;            // the ACTIVE tab's library item
  let _allItems = [];          // full items list, kept in memory for save + tag index
  let _tagIndex = null;        // rebuilt from _allItems when needed
  let _annotations = [];
  let _colors = [];
  let _colorsLoaded = false;
  let _unsubscribeSync = null;
  let _unsubGroups = null;     // V3.294 — annotation-groups subscription, freed on detach
  let _fitMode = true;  // when true, layout changes re-fit to viewer width

  // ---- V3.294 multi-tab state -------------------------------------------
  const MAX_TABS = 10;                 // user-requested cap on simultaneous papers
  const LP_TABS_KEY = 'rm_lp_open_papers';
  let _tabs = [];                      // [{id, title}] in strip order
  let _activeId = null;                // id of the active tab (mirrors ?id=)
  let _viewers = new Map();            // id → {viewer, pane}  (lazy; visited tabs only)
  let _mru = [];                       // ids, most-recently-active first (eviction order)
  let _booted = false;
  let _tagEditorDocClick = null;       // named handler so re-render replaces, not stacks
  let _copyBound = false;              // copy listener bound once in bootOnce
  let _drafts = [];                    // active paper's linked-draft shortlist
  let _allDrafts = [];                 // global paper+grant draft pool

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
    _updateMobileTitle(item.title);  // V3.235 — phone toolbar title

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

    // V3.309 — metadata editor entry point. Saves are a targeted
    // items/{id} write; on success re-render this block in place.
    if (window.LIBRARY_EDIT || window.LIBRARY_REFRESH) {
      const editRow = document.createElement('div');
      editRow.style.cssText = 'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;';
      editRow.innerHTML =
        (window.LIBRARY_EDIT ? '<button class="btn btn-sm" id="lp-edit-meta" title="Edit metadata / fetch from DOI">✎ Edit metadata</button>' : '') +
        (window.LIBRARY_REFRESH ? '<button class="btn btn-sm" id="lp-refresh-doi" title="Re-pull metadata, try an OA PDF, and re-enrich references (V3.310)">↻ Refresh from DOI</button>' : '');
      metaEl.appendChild(editRow);
      const editBtn = editRow.querySelector('#lp-edit-meta');
      if (editBtn) editBtn.addEventListener('click', () => {
        LIBRARY_EDIT.open(item, {
          onSaved(updated) {
            if (_item && _item.id === updated.id) _item = updated;
            _renderMetadata(updated);
          },
        });
      });
      const refreshBtn = editRow.querySelector('#lp-refresh-doi');
      if (refreshBtn) refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '↻ Refreshing…';
        try {
          await LIBRARY_REFRESH.fullRefresh(item, {
            interactive: true,
            onUpdated(updated) {
              if (_item && _item.id === updated.id) _item = updated;
              _renderMetadata(updated);
            },
          });
        } catch (e) {
          if (window.TOAST) TOAST.error('Refresh failed: ' + (e.message || e));
        } finally {
          refreshBtn.disabled = false;
          refreshBtn.textContent = '↻ Refresh from DOI';
        }
      });
    }

    // Abstract removed in V3.111 in favor of the Cited-by panel that
    // takes its slot in the side rail (paper-cited-by.js, mounted at
    // #lp-cited-by). The abstract field still lives on the item — it
    // just doesn't render here anymore.

    const tagEl = document.getElementById('lp-tags');
    if (tagEl) {
      const labels = (lib.labels || []).map(l => `<span class="lp-chip">${_esc(l)}</span>`).join('');
      const folders = (lib.folders || []).map(f => `<span class="lp-chip lp-chip-folder">${_esc(f)}</span>`).join('');
      // Note: lp-tags only carries the legacy folder/label chips. The new
      // multi-tag editor lives in #lp-tag-editor (rendered separately).
      tagEl.innerHTML = labels + folders;
    }
  }

  // V3.311 — the no-PDF dead end becomes the missing-PDF queue's reader
  // entry point: retry the OA fetch, upload the file to THIS entry, or
  // mark it unobtainable. A successful attach reloads the page (the
  // viewer boot assumes a PDF from the start).
  function _renderNoPdfActions(host, item) {
    if (!host) return;
    const lib = (item.meta && item.meta.library) || {};
    const unob = lib.pdf_status === 'unobtainable';
    const pane = document.createElement('div');
    pane.className = 'lp-viewer lp-viewer-pane is-active';
    pane.id = 'lp-viewer';
    pane.dataset.paperId = item.id;
    pane.innerHTML = `
      <div style="max-width:460px;margin:60px auto;text-align:center;color:#6b7280;font-size:13px;">
        <div style="font-size:34px;margin-bottom:8px;">📄</div>
        <div style="font-weight:600;color:#374151;margin-bottom:4px;">No PDF attached</div>
        <div style="margin-bottom:12px;">${unob
          ? 'This paper is marked unobtainable — no accessible PDF exists.'
          : 'The metadata is here, but the PDF never landed. Try the open-access fetch, or upload the file manually.'}</div>
        ${lib.pdf_candidate_url ? `<div style="font-size:11px;margin-bottom:10px;">Known OA copy (auto-fetch was CORS-blocked): <a href="${lib.pdf_candidate_url}" target="_blank" rel="noopener">open in a new tab</a>, download it, then ⬆ upload here.</div>` : ''}
        ${lib.pdf_retry && lib.pdf_retry.last_error ? `<div style="font-size:11px;color:#92400e;margin-bottom:10px;">Last retry: ${_esc(lib.pdf_retry.last_error)}</div>` : ''}
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
          ${lib.doi && !unob ? '<button class="btn btn-sm" id="lp-nopdf-retry">↻ Try Unpaywall</button>' : ''}
          <button class="btn btn-sm" id="lp-nopdf-upload">⬆ Upload PDF</button>
          <button class="btn btn-sm" id="lp-nopdf-unob">${unob ? '↩ Clear unobtainable' : '🚫 Mark unobtainable'}</button>
        </div>
      </div>`;
    host.appendChild(pane);

    async function saveOne() {
      item.updated_at = new Date().toISOString().slice(0, 10);
      const payload = JSON.parse(JSON.stringify(item));
      delete payload.updatedAt;
      payload.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      await firebase.firestore().collection('items').doc(item.id).set(payload);
    }

    async function attach(blob) {
      _setStatus('Uploading PDF…');
      const pdfInfo = await window.LIBRARY_UPLOAD.uploadPdf(item.id, blob);
      lib.pdf = {
        storage_path: pdfInfo.storage_path,
        hash: pdfInfo.hash,
        filename_safe: `${item.id}.pdf`,
        size_bytes: pdfInfo.size_bytes,
        uploaded_at: pdfInfo.uploaded_at,
        uploaded_by: pdfInfo.uploaded_by,
      };
      delete lib.pdf_status;
      await saveOne();
      if (window.LIBRARY_UPLOAD.parseAndCacheRefs) {
        try { await LIBRARY_UPLOAD.parseAndCacheRefs(item.id, blob); } catch (_) { /* background nicety */ }
      }
      location.reload();
    }

    const retryBtn = pane.querySelector('#lp-nopdf-retry');
    if (retryBtn) retryBtn.addEventListener('click', async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = '↻ Checking…';
      const retry = Object.assign({ attempts: 0 }, lib.pdf_retry || {});
      retry.attempts = (retry.attempts || 0) + 1;
      retry.last_at = new Date().toISOString();
      retry.last_error = '';
      try {
        const oa = await LIBRARY_UPLOAD.unpaywallLookup(lib.doi);
        if (oa && oa.bestPdfUrl) {
          const blob = await LIBRARY_UPLOAD.fetchPdfBlob(oa.bestPdfUrl);
          if (blob) { lib.pdf_retry = retry; await attach(blob); return; }
          retry.last_error = 'OA PDF found but CORS-blocked — open it manually, then ⬆ upload.';
          lib.pdf_candidate_url = oa.bestPdfUrl;
          lib.pdf_candidate_source = oa.source || '';
        } else {
          retry.last_error = 'No open-access copy found on Unpaywall.';
        }
      } catch (e) {
        retry.last_error = e.message || String(e);
      }
      lib.pdf_retry = retry;
      try { await saveOne(); } catch (_) { /* stamp is best-effort */ }
      pane.remove();
      _renderNoPdfActions(host, item);
    });

    pane.querySelector('#lp-nopdf-upload').addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'application/pdf';
      inp.addEventListener('change', async () => {
        const file = inp.files && inp.files[0];
        if (!file) return;
        try { await attach(file); }
        catch (e) { _setStatus('Upload failed: ' + (e.message || e), 'error'); }
      });
      inp.click();
    });

    pane.querySelector('#lp-nopdf-unob').addEventListener('click', async () => {
      if (lib.pdf_status === 'unobtainable') delete lib.pdf_status;
      else lib.pdf_status = 'unobtainable';
      try { await saveOne(); } catch (e) { _setStatus('Save failed: ' + (e.message || e), 'error'); return; }
      pane.remove();
      _renderNoPdfActions(host, item);
    });
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
    // V3.294 — _renderTagEditor runs once per paper attach; replace the
    // prior document listener instead of stacking a new one each switch.
    if (_tagEditorDocClick) document.removeEventListener('click', _tagEditorDocClick);
    _tagEditorDocClick = (e) => {
      const h = document.getElementById('lp-tag-editor');
      if (h && !h.contains(e.target)) _hideSuggest();
    };
    document.addEventListener('click', _tagEditorDocClick);
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

  // Render the "Assign reading" widget. Sits below the share widget and lets
  // the current user send this paper to a teammate as an assigned/suggested
  // task (paper_ref attached). Hidden until firebridge says we're a lab member.
  function _renderAssignWidget(item) {
    const sideInner = document.querySelector('.lp-side-inner');
    if (!sideInner) return;
    let host = document.getElementById('lp-assign-widget');
    if (!host) {
      host = document.createElement('div');
      host.id = 'lp-assign-widget';
      host.style.margin = '10px 0';
      const after = document.getElementById('lp-share-widget')
                 || document.getElementById('lp-tag-editor')
                 || document.getElementById('lp-tags');
      if (after) after.insertAdjacentElement('afterend', host);
      else sideInner.appendChild(host);
    }
    const isMember = window.firebridge && firebridge.isLabMember && firebridge.isLabMember();
    if (!isMember || !window.TASK_ASSIGN) {
      host.style.display = 'none';
      return;
    }
    host.style.display = '';
    const isAdmin = firebridge.isAdmin && firebridge.isAdmin();
    const verb = isAdmin ? 'Assign reading' : 'Suggest reading';
    host.innerHTML = `
      <div class="lp-section-title" style="font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#6b7280;margin-bottom:4px;">Send to teammate</div>
      <button id="lp-assign-btn" class="btn btn-sm" style="font-size:12px;width:100%;background:#ede9fe;color:#5b21b6;border:1px solid #c4b5fd;">
        ${_esc(verb)} →
      </button>
      <div style="font-size:10px;color:#9ca3af;margin-top:4px;">
        Drops this paper into a teammate's queue. Their lab-visibility comments will surface back on their PMR.
      </div>
    `;
    document.getElementById('lp-assign-btn').addEventListener('click', () => {
      const lib = (item.meta && item.meta.library) || {};
      const authorLine = (lib.authors || [])
        .map(a => [a.given, a.family].filter(Boolean).join(' '))
        .join('; ');
      window.TASK_ASSIGN.open({
        paperRef: {
          paperId:      item.id,
          paperTitle:   item.title || (lib.title) || item.id,
          paperAuthors: authorLine,
        },
      });
    });
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

  /** Brief yellow flash on a page rect — used by paper-search to land
   *  on a hit. Same overlay layer as the citations flash so it survives
   *  annotation-overlay redraws (those clear `.pv-overlay`, not
   *  `.pv-cite-overlay`). */
  function _flashRectOnPage(page, x, y, w, h) {
    if (!_viewer || !_viewer.getPageNode) return;
    const node = _viewer.getPageNode(page);
    if (!node || !node.wrap) return;
    let ov = node.wrap.querySelector('.pv-cite-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'pv-cite-overlay';
      ov.style.position = 'absolute';
      ov.style.left = '0';
      ov.style.top = '0';
      ov.style.right = '0';
      ov.style.bottom = '0';
      ov.style.pointerEvents = 'none';
      ov.style.zIndex = '6';
      node.wrap.appendChild(ov);
    }
    const el = document.createElement('div');
    el.className = 'pv-cite-flash';
    el.style.position = 'absolute';
    el.style.left = `${x - 2}px`;
    el.style.top = `${y - 2}px`;
    el.style.width = `${w + 4}px`;
    el.style.height = `${h + 4}px`;
    el.style.background = 'rgba(250, 204, 21, 0.45)';
    el.style.border = '2px solid rgba(250, 204, 21, 0.85)';
    el.style.borderRadius = '3px';
    el.style.boxShadow = '0 0 8px rgba(250, 204, 21, 0.6)';
    el.style.pointerEvents = 'none';
    ov.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }

  function _onPageChange(p) {
    const pageInput = document.getElementById('lp-page-input');
    const total = document.getElementById('lp-page-total');
    if (pageInput) pageInput.value = String(p);
    if (total && _viewer) total.textContent = `/ ${_viewer.numPages}`;
    if (window.PAPER_CITATIONS) {
      try { window.PAPER_CITATIONS.refreshForPage(p); } catch (_) { /* not initialized yet */ }
    }
  }

  function _onZoomChange(z) {
    const lbl = document.getElementById('lp-zoom-label');
    if (lbl) lbl.textContent = `${Math.round(z * 100)}%`;
  }

  async function _mountViewer(pdfUrl, viewerOpts = {}) {
    // V3.294 — mount into the supplied pane (the active tab's
    // .lp-viewer-pane). Returns the created viewer; the caller assigns it
    // to the per-tab record and to _viewer.
    const container = viewerOpts.container || document.getElementById('lp-viewer');
    if (!container) throw new Error('Viewer container missing');
    const viewer = await window.PDF_VIEWER.create(container, pdfUrl, {
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
        // Only the active viewer drives the shared overlay/citation panels.
        if (_viewer !== viewer) return;
        if (window.ANNOTATION_OVERLAY) {
          try { window.ANNOTATION_OVERLAY.redrawPage(pageNum); } catch (_) { /* not initialized yet */ }
        }
        if (window.PAPER_CITATIONS && pageNum === _viewer.currentPage) {
          try { window.PAPER_CITATIONS.refreshForPage(pageNum); } catch (_) { /* not initialized yet */ }
        }
      },
    });
    return viewer;
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
      const panelFn = window.ANNOTATION_PANEL.getFilterFn();
      const overlayFn = (window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.getFilterFn)
        ? window.PAPER_OVERLAYS.getFilterFn()
        : (() => true);
      // V3.189 — layer the annotation-type filter on top.
      const typeFn = (window.PAPER_OVERLAY_TYPES && window.PAPER_OVERLAY_TYPES.getFilterFn)
        ? window.PAPER_OVERLAY_TYPES.getFilterFn()
        : (() => true);
      const composed = (ann) => panelFn(ann) && overlayFn(ann) && typeFn(ann);
      window.ANNOTATION_OVERLAY.setFilter(composed);
      // Mirror the same composed filter onto the panel by stamping a
      // hidden field (panel re-runs its own filter on render). Easier:
      // ask the panel to refresh its render via setAnnotations.
      window.ANNOTATION_PANEL.setAnnotations(_annotations.filter(a => overlayFn(a) && typeFn(a)));
    }

    window.ANNOTATION_OVERLAY.init({
      viewer: _viewer,
      container: viewerEl,
      getColors: () => _colors,
      onCreate: async ({ anchors, colorId }) => {
        const color = _colors.find(c => c.id === colorId);
        const autoFlags = (color && color.auto_flags) || [];
        const visibility = window.ANNOTATION_PANEL.getDefaultVisibility() || 'lab';
        // Stamp the active overlay set onto new highlights so they belong
        // to whatever review-task overlays the user currently has on. If
        // no overlays are active (or PAPER_OVERLAYS isn't loaded), the
        // highlight is "general" and renders unconditionally.
        const bucketIds = (window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.getActiveBucketIds)
          ? window.PAPER_OVERLAYS.getActiveBucketIds()
          : [];
        try {
          await window.ANNOTATION_SYNC.create(paperId, {
            color_id: colorId,
            visibility,
            target: { pages: anchors },
            bucket_ids: bucketIds,
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

    // (Cmd+C / Ctrl+C copy of the geometric selection is wired once in
    // bootOnce — it reads GEOM_SELECTION live, so it's paper-agnostic and
    // must NOT be re-added here on every tab switch.)

    // V3.103 — per-paper draft shortlist. The annotation panel's
    // "Tag as evidence" picker lists the drafts (paper drafts +
    // grant proposals) the user has explicitly linked to this paper
    // via `meta.library.linked_drafts`. _allDrafts is the global
    // pool used by the inline "+ Add draft" affordance to extend
    // the per-paper list.
    //
    // Paper drafts live in projects/papers.json (NOT items.json — the
    // paper-builder owns that file). Grant drafts live in items.json
    // with type:'grant' and status in proposals.
    // V3.294 — module-level (declared at top) so the PAPER_OVERLAYS.onChange
    // handler registered in attachActive() can refresh the shortlist.
    _drafts = [];
    _allDrafts = [];
    const GRANT_DRAFT_STATUSES = new Set(['drafting', 'submitted', 'under_review', 'revising', 'rejected']);
    try {
      const [itemsData, papersData] = await Promise.all([
        api.load('items.json'),
        api.load('projects/papers.json').catch(() => ({ papers: [] })),
      ]);
      const items = (itemsData.items || []);
      const papers = (papersData && papersData.papers) || [];
      const paperDrafts = papers.map(p => ({
        id: p.id,
        title: p.title || p.id,
        kind: 'paper',
      }));
      const grantDrafts = items
        .filter(it => it.type === 'grant' && GRANT_DRAFT_STATUSES.has(it.status))
        .map(it => ({ id: it.id, title: it.title || it.id, kind: 'grant' }));
      _allDrafts = paperDrafts.concat(grantDrafts);
      // Per-paper shortlist: only drafts the user has linked.
      const linkedIds = new Set(((_item.meta && _item.meta.library && _item.meta.library.linked_drafts) || []));
      _drafts = _allDrafts.filter(d => linkedIds.has(d.id));
    } catch (e) {
      console.warn('[library-paper] could not load drafts:', e.message);
    }

    let _groups = [{ id: 'general', name: 'General' }];
    if (window.ANNOTATION_GROUPS) {
      try {
        await window.ANNOTATION_GROUPS.ensureSeed();
      } catch (e) {
        console.warn('[library-paper] annotation-groups seed failed:', e.message);
      }
      // V3.294 — capture the unsubscribe so a tab switch frees it (the
      // groups onSnapshot is refcounted in annotation-groups.js).
      try { _unsubGroups && _unsubGroups(); } catch (_) { /* ignore */ }
      _unsubGroups = window.ANNOTATION_GROUPS.subscribe((g) => {
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
      getBuckets: () => (window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.getLinkedBuckets)
        ? window.PAPER_OVERLAYS.getLinkedBuckets() : [],
      getBucketColor: (id) => (window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.getColorForBucket)
        ? window.PAPER_OVERLAYS.getColorForBucket(id) : '#a78bfa',
      onBucketToggle: async (annId, bucketId, on) => {
        const ann = _annotations.find(a => a.id === annId);
        if (!ann) return;
        const cur = Array.isArray(ann.bucket_ids) ? ann.bucket_ids.slice() : [];
        const next = on ? Array.from(new Set(cur.concat([bucketId])))
                        : cur.filter(x => x !== bucketId);
        try {
          await window.ANNOTATION_SYNC.update(paperId, annId, { bucket_ids: next });
        } catch (e) {
          alert(`Could not update overlays: ${e.message}`);
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
    // layer which invalidates rect positions). V3.294 — guard so re-attaching
    // to an already-warm viewer (switching back to a tab) doesn't double-wrap
    // setZoom. The wrap reads window.ANNOTATION_OVERLAY live, so it stays
    // correct across attach/detach of the (singleton) overlay.
    if (!_viewer.__overlayZoomWrapped) {
      const origSetZoom = _viewer.setZoom;
      _viewer.setZoom = async function (z) {
        const r = await origSetZoom.call(_viewer, z);
        if (window.ANNOTATION_OVERLAY) window.ANNOTATION_OVERLAY.redraw();
        return r;
      };
      _viewer.__overlayZoomWrapped = true;
    }
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

  /* V3.235 — Wire the phone-only side drawers. Marks #lp-split as a
   * .rm-mobile-drawer-host (already in HTML); .lp-side + .lp-annotations
   * already carry .rm-mobile-drawer-left / .rm-mobile-drawer-right. The
   * two .lp-mobile-bar toggle buttons drive them. Inert above 640px. */
  function _wireMobileDrawers() {
    if (!window.MOBILE_DRAWERS) return;
    const host = document.getElementById('lp-split');
    if (!host) return;
    window.MOBILE_DRAWERS.init(host, {
      leftToggle:  document.getElementById('lp-mobile-left-toggle'),
      rightToggle: document.getElementById('lp-mobile-right-toggle'),
    });
  }

  /* V3.235 — Keep the .lp-mobile-bar title in sync with the paper title
   * so the phone user sees what they're reading without opening the
   * left drawer. Called from _renderMetadata. */
  function _updateMobileTitle(title) {
    const el = document.getElementById('lp-mobile-title');
    if (el) el.textContent = title || 'Paper';
  }

  // ======================================================================
  // V3.294 — Multi-tab manager
  //
  // The page keeps up to MAX_TABS papers open at once. Each *visited* tab
  // owns a live PDF_VIEWER instance in its own .lp-viewer-pane inside
  // #lp-viewer-host; only the active pane is shown, so switching is instant
  // and preserves per-tab scroll + zoom. The active pane also carries
  // id="lp-viewer" so existing #lp-viewer lookups resolve to it.
  //
  // The annotation/overlay/citation/search stack is a set of singletons, so
  // on each switch we DETACH it from the outgoing paper (unsub + destroy)
  // and ATTACH it to the incoming one. The per-module destroy() hardening
  // (V3.294) makes that re-init leak-free.
  // ======================================================================

  function _loadTabsState() {
    try {
      const raw = localStorage.getItem(LP_TABS_KEY);
      if (!raw) return { tabs: [], activeId: null };
      const obj = JSON.parse(raw);
      return {
        tabs: Array.isArray(obj.tabs) ? obj.tabs.filter(t => t && t.id) : [],
        activeId: obj.activeId || null,
      };
    } catch (_) { return { tabs: [], activeId: null }; }
  }
  function _saveTabsState() {
    try {
      localStorage.setItem(LP_TABS_KEY, JSON.stringify({ tabs: _tabs, activeId: _activeId }));
    } catch (_) { /* quota — ignore */ }
  }

  function _titleFor(id) {
    const it = _allItems.find(x => x.id === id);
    if (it && it.title) return it.title;
    const t = _tabs.find(t => t.id === id);
    return (t && t.title) || id;
  }

  function _touchMru(id) {
    _mru = [id].concat(_mru.filter(x => x !== id));
  }

  // Destroy a tab's viewer + remove its pane + drop it from the model.
  // Low-level — does NOT re-activate a neighbour (see closeTab).
  function _removeTab(id) {
    const rec = _viewers.get(id);
    if (rec) {
      try { rec.viewer && rec.viewer.destroy(); } catch (_) { /* ignore */ }
      try { rec.pane && rec.pane.remove(); } catch (_) { /* ignore */ }
      _viewers.delete(id);
    }
    _tabs = _tabs.filter(t => t.id !== id);
    _mru = _mru.filter(x => x !== id);
  }

  // Keep the open-paper count ≤ MAX_TABS. When at the cap, close the
  // least-recently-active tab (never the active one or the one we're about
  // to open). This is the "open an 11th paper" path.
  function _evictIfNeeded(keepId) {
    while (_tabs.length >= MAX_TABS) {
      const protectedIds = new Set([keepId, _activeId]);
      let victim = null;
      for (let i = _mru.length - 1; i >= 0; i--) {
        if (!protectedIds.has(_mru[i]) && _tabs.some(t => t.id === _mru[i])) { victim = _mru[i]; break; }
      }
      if (!victim) {
        const t = _tabs.find(t => !protectedIds.has(t.id));
        victim = t ? t.id : null;
      }
      if (!victim) break;
      _removeTab(victim);
    }
  }

  function _ensureTab(id, title) {
    let tab = _tabs.find(t => t.id === id);
    if (tab) { if (title) tab.title = title; return tab; }
    _evictIfNeeded(id);
    tab = { id, title: title || id };
    _tabs.push(tab);
    return tab;
  }

  function _renderTabs() {
    const strip = document.getElementById('lp-tabs');
    if (!strip) return;
    if (!_tabs.length) { strip.innerHTML = ''; return; }
    const chips = _tabs.map(t => {
      const active = t.id === _activeId;
      const title = _titleFor(t.id);
      return `<div class="lp-tab${active ? ' is-active' : ''}" role="tab" aria-selected="${active}" data-tab-id="${_esc(t.id)}" title="${_esc(title)}">`
        + `<span class="lp-tab-title">${_esc(title)}</span>`
        + `<button class="lp-tab-close" data-tab-close="${_esc(t.id)}" title="Close tab" aria-label="Close ${_esc(title)}">×</button>`
        + `</div>`;
    }).join('');
    strip.innerHTML = chips
      + `<button class="lp-tab-new" id="lp-tab-new" title="Open another paper from the library" aria-label="Open another paper">＋</button>`;
    const activeEl = strip.querySelector('.lp-tab.is-active');
    if (activeEl) { try { activeEl.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch (_) { /* old browsers */ } }
  }

  function _wireTabStrip() {
    const strip = document.getElementById('lp-tabs');
    if (!strip) return;
    strip.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-tab-close]');
      if (closeBtn) { e.stopPropagation(); closeTab(closeBtn.getAttribute('data-tab-close')); return; }
      if (e.target.closest('#lp-tab-new')) { window.location.href = '/rm/pages/library.html'; return; }
      const tab = e.target.closest('[data-tab-id]');
      if (tab) {
        const id = tab.getAttribute('data-tab-id');
        if (id && id !== _activeId) activateTab(id);
      }
    });
  }

  function _wireCopyOnce() {
    if (_copyBound) return;
    // Cmd+C / Ctrl+C → write the geometric-selection's text to the clipboard.
    // Native browser selection is disabled on the text layer. Reads
    // GEOM_SELECTION live, so it's paper-agnostic and bound exactly once.
    document.addEventListener('copy', (ev) => {
      if (!window.GEOM_SELECTION) return;
      const text = window.GEOM_SELECTION.selectedText();
      if (!text) return;
      ev.preventDefault();
      ev.clipboardData.setData('text/plain', text);
    });
    _copyBound = true;
  }

  function _updateUrl(id) {
    try {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set('id', id);
      else url.searchParams.delete('id');
      // One-shot deep-link params: drop after the initial paper consumes
      // them (paper-overlays reads ?draft during attach; the auto-import
      // flow captures them before this runs). Keeps a refresh from
      // re-triggering an import. annotation-panel's own filter params
      // (author/color/stance/mine) are left untouched.
      url.searchParams.delete('import');
      url.searchParams.delete('draft');
      url.searchParams.delete('grant');
      history.replaceState(null, '', url.toString());
    } catch (_) { /* ignore */ }
  }

  function _showEmptyState() {
    const host = document.getElementById('lp-viewer-host');
    if (!host) return;
    host.querySelectorAll('.lp-viewer-pane.is-active').forEach(p => p.classList.remove('is-active'));
    let el = document.getElementById('lp-empty');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lp-empty';
      el.className = 'lp-empty';
      el.innerHTML = `<div>No paper open.</div><div><a href="/rm/pages/library.html">← Go to the library</a> to open a paper.</div>`;
      host.appendChild(el);
    }
    el.style.display = 'flex';
    _updateMobileTitle('Paper');
  }
  function _hideEmptyState() {
    const el = document.getElementById('lp-empty');
    if (el) el.style.display = 'none';
  }

  // Create-or-show the pane + viewer for `id`. Hides every other pane and
  // moves id="lp-viewer" onto the active one. Sets _viewer + _item. Cold
  // tabs mint a signed URL and render; warm tabs are an instant show.
  async function _ensurePaneActive(id) {
    const host = document.getElementById('lp-viewer-host');
    if (!host) throw new Error('Viewer host missing');
    host.querySelectorAll('.lp-viewer-pane').forEach(p => {
      p.classList.remove('is-active');
      if (p.id === 'lp-viewer') p.removeAttribute('id');
    });
    _hideEmptyState();

    const rec = _viewers.get(id);
    if (rec && rec.pane) {
      rec.pane.classList.add('is-active');
      rec.pane.id = 'lp-viewer';
      _viewer = rec.viewer;
      _item = _allItems.find(x => x.id === id) || _item;
      if (_viewer) { _onPageChange(_viewer.currentPage || 1); _onZoomChange(_viewer.zoom); }
      return;
    }

    // Cold tab — validate item + PDF, then render.
    const item = _allItems.find(x => x.id === id);
    if (!item) { _item = null; _viewer = null; _setStatus(`Paper ${id} not found in items.json`, 'error'); return; }
    _item = item;
    const lib = item.meta && item.meta.library;
    if (!lib || !lib.pdf || !lib.pdf.storage_path) {
      _viewer = null;
      _setStatus('No PDF attached to this paper.', 'error');
      _renderNoPdfActions(host, item);   // V3.311 — actionable dead end
      return;
    }
    const pane = document.createElement('div');
    pane.className = 'lp-viewer lp-viewer-pane is-active';
    pane.dataset.paperId = id;
    pane.id = 'lp-viewer';
    host.appendChild(pane);

    _setStatus('Authenticating…');
    await _waitForAuth(15000);
    _setStatus('Fetching signed URL…');
    const signedUrl = await window.LIBRARY_UPLOAD.downloadUrl(lib.pdf.storage_path);
    // pdf.js range-fetch trips CORS on Firebase Storage. Local dev proxies
    // through server.py; the static deploy hits Storage directly with
    // disableRange+disableStream (one full GET).
    const isDeploy = window.RM_RUNTIME && window.RM_RUNTIME.isDeploy;
    const fetchUrl = isDeploy ? signedUrl : `/api/library/pdf-proxy?url=${encodeURIComponent(signedUrl)}`;
    _setStatus('Rendering…');
    const viewer = await _mountViewer(fetchUrl, { container: pane, disableRange: isDeploy, disableStream: isDeploy });
    _viewers.set(id, { viewer, pane });   // keep warm regardless
    if (_activeId === id) {
      // Still the active tab — promote.
      _viewer = viewer;
      _onPageChange(1);
      _onZoomChange(viewer.zoom);
      _setStatus('');
    } else {
      // A newer switch took over while this PDF was fetching/rendering.
      // Leave it warm but hidden so the winning tab stays visible.
      pane.classList.remove('is-active');
      if (pane.id === 'lp-viewer') pane.removeAttribute('id');
    }
  }

  // Tear down the singleton stack from whatever paper is currently active.
  // The viewer itself is NOT destroyed (it stays warm in its hidden pane).
  function _detachActive() {
    try { _unsubscribeSync && _unsubscribeSync(); } catch (_) { /* ignore */ }
    _unsubscribeSync = null;
    try { _unsubGroups && _unsubGroups(); } catch (_) { /* ignore */ }
    _unsubGroups = null;
    try { window.ANNOTATION_OVERLAY && window.ANNOTATION_OVERLAY.destroy(); } catch (_) { /* ignore */ }
    try { window.GEOM_SELECTION && window.GEOM_SELECTION.destroy(); } catch (_) { /* ignore */ }
    try { window.PAPER_CITATIONS && window.PAPER_CITATIONS.destroy(); } catch (_) { /* ignore */ }
    try { window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.destroy(); } catch (_) { /* ignore */ }
    try { window.PAPER_OVERLAY_TYPES && window.PAPER_OVERLAY_TYPES.destroy(); } catch (_) { /* ignore */ }
    try { window.PAPER_SEARCH && window.PAPER_SEARCH.destroy(); } catch (_) { /* ignore */ }
    try { window.PAPER_OVERLAY_IMPORT && window.PAPER_OVERLAY_IMPORT.destroy(); } catch (_) { /* ignore */ }
    _annotations = [];
  }

  // Render the side panels + (re)initialize the singleton stack against the
  // active viewer + paper. This is the per-paper mount that used to live
  // inline in init(); it now runs on every tab switch.
  async function _attachActive(id) {
    const item = _allItems.find(x => x.id === id);
    if (!item) return;
    _item = item;
    _tagIndex = window.LIBRARY_TAGS
      ? LIBRARY_TAGS.buildIndex(_allItems.filter(it => it.type === 'paper' && it.meta && it.meta.library && it.meta.library.is_library_entry))
      : null;
    _renderMetadata(_item);
    _renderTagEditor(_item);
    _renderShareWidget(_item);
    _renderAssignWidget(_item);

    if (!_viewer) {
      // No-PDF paper: side panels render, but there's nothing to annotate.
      return;
    }

    if (window.PAPER_CITED_BY) {
      try {
        window.PAPER_CITED_BY.init({
          paperItem: _item,
          mountEl: document.getElementById('lp-cited-by'),
          getAllItems: () => _allItems,
          onLibraryChanged: async () => {
            try {
              const d = await api.load('items.json');
              _allItems = (d && d.items) || _allItems;
              if (window.PAPER_CITED_BY && window.PAPER_CITED_BY.refreshLibraryStatus) {
                window.PAPER_CITED_BY.refreshLibraryStatus();
              }
              if (window.PAPER_CITATIONS && window.PAPER_CITATIONS.refreshLibraryStatus) {
                window.PAPER_CITATIONS.refreshLibraryStatus();
              }
            } catch (_) { /* ignore */ }
          },
        });
      } catch (e) { console.warn('[library-paper] paper-cited-by init failed:', e); }
    }
    if (window.PAPER_CITATIONS) {
      try {
        window.PAPER_CITATIONS.init({
          viewer: _viewer,
          paperItem: _item,
          sideEl: document.getElementById('lp-citations'),
          getAllItems: () => _allItems,
          onLibraryChanged: async () => {
            try {
              const d = await api.load('items.json');
              _allItems = (d && d.items) || _allItems;
              if (window.PAPER_CITATIONS && window.PAPER_CITATIONS.refreshLibraryStatus) {
                window.PAPER_CITATIONS.refreshLibraryStatus();
              }
              if (window.PAPER_CITED_BY && window.PAPER_CITED_BY.refreshLibraryStatus) {
                window.PAPER_CITED_BY.refreshLibraryStatus();
              }
            } catch (_) { /* ignore */ }
          },
          // V3.93/V3.206 — persist freshly parsed refs into the extras
          // subdoc so subsequent opens skip the parse.
          onCacheRefs: async (refs) => {
            if (!_item || !_item.id) return;
            const targetId = _item.id;
            if (window.LIBRARY_EXTRAS && window.LIBRARY_EXTRAS.savePatch) {
              try {
                await window.LIBRARY_EXTRAS.savePatch(targetId, {
                  references: refs,
                  references_parsed_at: new Date().toISOString().slice(0, 10),
                  references_parser_version: 'v3.93',
                  references_source: 'pdf_regex',
                });
                console.info(`[library-paper] cached ${refs.length} refs in extras subdoc for ${targetId}`);
                return;
              } catch (e) {
                console.warn('[library-paper] LIBRARY_EXTRAS.savePatch failed, falling back:', e.message || e);
              }
            }
            try {
              const d = await api.load('items.json');
              const items = (d && d.items) || [];
              const idx = items.findIndex(it => it.id === targetId);
              if (idx < 0) return;
              items[idx].meta = items[idx].meta || {};
              items[idx].meta.library = items[idx].meta.library || {};
              items[idx].meta.library.references = refs;
              items[idx].meta.library.references_parsed_at = new Date().toISOString().slice(0, 10);
              items[idx].meta.library.references_parser_version = 'v3.93';
              await api.save('items.json', { items });
              _allItems = items;
              if (_activeId === targetId) _item = items[idx];
              console.info(`[library-paper] cached ${refs.length} refs on item ${targetId} (fallback)`);
            } catch (e) {
              console.warn('[library-paper] failed to cache refs:', e);
            }
          },
        });
      } catch (e) { console.warn('[library-paper] paper-citations init failed:', e); }
    }
    if (window.PAPER_OVERLAYS) {
      try {
        await window.PAPER_OVERLAYS.init({
          paperItem: _item,
          mountEl: document.getElementById('lp-overlays-anchor'),
        });
      } catch (e) { console.warn('[library-paper] paper-overlays init failed:', e); }
    }
    if (window.PAPER_OVERLAY_TYPES) {
      try {
        window.PAPER_OVERLAY_TYPES.init({
          paperId: _item.id,
          mountEl: document.getElementById('lp-types-anchor'),
          getAnnotations: () => _annotations,
        });
      } catch (e) { console.warn('[library-paper] paper-overlay-types init failed:', e); }
    }
    _setStatus('Loading annotations…');
    await _mountAnnotations();
    if (window.PAPER_OVERLAY_TYPES && window.PAPER_OVERLAY_TYPES.refresh) {
      try { window.PAPER_OVERLAY_TYPES.refresh(); } catch (_) { /* ignore */ }
    }
    if (window.PAPER_OVERLAY_IMPORT) {
      try {
        window.PAPER_OVERLAY_IMPORT.init({
          viewer: _viewer,
          viewerEl: document.getElementById('lp-viewer'),
          paperItem: _item,
          paperId: _item.id,
          allItems: _allItems,
          getCurrentAnnotations: () => _annotations,
          onImported: ({ written, skipped }) => {
            _setStatus(`Imported ${written} highlight(s)${skipped ? ` (skipped ${skipped})` : ''}.`);
            setTimeout(() => _setStatus(''), 3500);
          },
        });
      } catch (e) { console.warn('[library-paper] paper-overlay-import init failed:', e); }
    }
    if (window.PAPER_SEARCH) {
      try {
        window.PAPER_SEARCH.init({
          viewer: _viewer,
          getAnnotations: () => _annotations,
          mountEl: document.getElementById('lp-search-anchor'),
          onJump: (r) => {
            _viewer.gotoPage(r.page);
            setTimeout(() => _flashRectOnPage(r.page, r.x, r.y, r.w, r.h), 80);
          },
        });
      } catch (e) { console.warn('[library-paper] paper-search init failed:', e); }
    }
    if (window.PAPER_OVERLAYS) {
      // Re-run the composed filter whenever the user toggles overlays, and
      // refresh the per-paper draft shortlist for the annotation panel.
      window.PAPER_OVERLAYS.onChange(async () => {
        try {
          const fresh = await api.load('items.json');
          const updated = (fresh.items || []).find(i => i.id === _activeId);
          if (updated) {
            _item = updated;
            const linkedIds = new Set(((updated.meta && updated.meta.library && updated.meta.library.linked_drafts) || []));
            _drafts = _allDrafts.filter(d => linkedIds.has(d.id));
            if (window.ANNOTATION_PANEL && window.ANNOTATION_PANEL.setAnnotations) {
              window.ANNOTATION_PANEL.setAnnotations(_annotations);
            }
          }
        } catch (e) { /* ignore */ }
        if (window.ANNOTATION_PANEL && window.ANNOTATION_PANEL.getFilterFn) {
          const panelFn = window.ANNOTATION_PANEL.getFilterFn();
          const overlayFn = window.PAPER_OVERLAYS.getFilterFn();
          const typeFn = (window.PAPER_OVERLAY_TYPES && window.PAPER_OVERLAY_TYPES.getFilterFn)
            ? window.PAPER_OVERLAY_TYPES.getFilterFn() : (() => true);
          window.ANNOTATION_OVERLAY.setFilter((ann) => panelFn(ann) && overlayFn(ann) && typeFn(ann));
          window.ANNOTATION_PANEL.setAnnotations(_annotations.filter(a => overlayFn(a) && typeFn(a)));
        }
      });
    }
    if (window.PAPER_OVERLAY_TYPES && window.PAPER_OVERLAY_TYPES.onChange) {
      window.PAPER_OVERLAY_TYPES.onChange(() => {
        if (window.ANNOTATION_PANEL && window.ANNOTATION_PANEL.getFilterFn) {
          const panelFn = window.ANNOTATION_PANEL.getFilterFn();
          const overlayFn = (window.PAPER_OVERLAYS && window.PAPER_OVERLAYS.getFilterFn)
            ? window.PAPER_OVERLAYS.getFilterFn() : (() => true);
          const typeFn = window.PAPER_OVERLAY_TYPES.getFilterFn();
          window.ANNOTATION_OVERLAY.setFilter((ann) => panelFn(ann) && overlayFn(ann) && typeFn(ann));
          window.ANNOTATION_PANEL.setAnnotations(_annotations.filter(a => overlayFn(a) && typeFn(a)));
        }
      });
    }
    _setStatus('');
  }

  async function activateTab(id) {
    if (!id) return;
    _detachActive();
    _activeId = id;            // synchronous "latest intent" — also the race guard
    _touchMru(id);
    _ensureTab(id, _titleFor(id));
    _renderTabs();
    try {
      await _ensurePaneActive(id);
      if (_activeId !== id) return;   // a newer switch superseded us mid-fetch
      await _attachActive(id);
      if (_activeId !== id) return;
      _updateUrl(id);
      _renderTabs();
    } catch (e) {
      console.error('[library-paper] activateTab failed:', e);
      if (_activeId === id) _setStatus(`Error: ${e.message || e}`, 'error');
    }
    if (_activeId === id) _saveTabsState();
  }

  function closeTab(id) {
    const wasActive = (id === _activeId);
    _removeTab(id);
    if (wasActive) {
      const next = _mru.find(x => _tabs.some(t => t.id === x)) || (_tabs[0] && _tabs[0].id) || null;
      if (next) { activateTab(next); return; }
      _detachActive();
      _activeId = null; _item = null; _viewer = null;
      _showEmptyState();
      _updateUrl(null);
    }
    _renderTabs();
    _saveTabsState();
  }

  // V3.188 — one-shot `?import=<overlayId>&draft=<grantId>` auto-import for
  // the initially-opened paper. Captured before _updateUrl strips the params.
  async function _maybeAutoImport(overlayId, draftId) {
    if (!overlayId || !draftId) return;
    if (!window.PAPER_OVERLAY_IMPORT || !window.firebridge) return;
    try {
      const snap = await firebridge.db()
        .collection('grantDrafts').doc(draftId)
        .collection('overlays').doc(overlayId).get();
      if (!snap.exists) { _setStatus(`Overlay ${overlayId} not found on grant ${draftId}.`); return; }
      const meta = snap.data();
      const url = meta.downloadUrl;
      if (!url) return;
      const text = await (await fetch(url)).text();
      const file = new File([text], meta.fileName || (overlayId + '.paper-overlay.md'), { type: 'text/markdown' });
      window.PAPER_OVERLAY_IMPORT.handleDrop(file);
    } catch (e) {
      console.warn('[library-paper] auto-import from grant overlay failed:', e);
    }
  }

  async function bootOnce() {
    if (_booted) return;
    _booted = true;
    _wireLayout();
    _wireToolbar();
    _wireMobileDrawers();
    _wireTabStrip();
    _wireCopyOnce();

    try {
      _setStatus('Loading library…');
      const data = await api.load('items.json');
      _allItems = (data && data.items) || [];
    } catch (e) {
      _setStatus(`Error loading library: ${e.message || e}`, 'error');
      return;
    }

    // Reconcile the persisted open-papers list against what still exists.
    const persisted = _loadTabsState();
    _tabs = persisted.tabs.filter(t => _allItems.some(it => it.id === t.id));

    const urlId = _qs('id');
    if (urlId && !_allItems.some(it => it.id === urlId)) {
      _setStatus(`Paper ${urlId} not found in items.json`, 'error');
    }
    let initial = null;
    if (urlId && _allItems.some(it => it.id === urlId)) initial = urlId;
    else if (persisted.activeId && _tabs.some(t => t.id === persisted.activeId)) initial = persisted.activeId;
    else if (_tabs.length) initial = _tabs[0].id;

    if (initial) {
      _ensureTab(initial, _titleFor(initial));
      _mru = [initial].concat(_tabs.map(t => t.id).filter(x => x !== initial));
    }

    if (!_colorsLoaded) { await _loadColors(); _colorsLoaded = true; }

    // Capture the one-shot deep-link params BEFORE activateTab's _updateUrl
    // strips them.
    const dlImport = _qs('import');
    const dlDraft = _qs('draft') || _qs('grant');

    if (!initial) {
      _renderTabs();
      _showEmptyState();
      _saveTabsState();
      return;
    }

    await activateTab(initial);
    await _maybeAutoImport(dlImport, dlDraft);
  }

  document.addEventListener('DOMContentLoaded', bootOnce);
  window.addEventListener('beforeunload', () => {
    _detachActive();
    _viewers.forEach(rec => { try { rec.viewer && rec.viewer.destroy(); } catch (_) { /* ignore */ } });
    _viewers.clear();
  });
})();
