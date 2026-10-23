/* library-edit.js — V3.309 metadata editor modal for library papers.
 *
 * Fixes the wishlist dead end: a paper whose ingest lookup failed kept
 * `title=filename`, empty authors, and source:'manual' forever with no way
 * to repair it. This modal edits every light metadata field and can pull
 * the authoritative record from a pasted DOI / PMID / arXiv id via
 * LIBRARY_METADATA.lookup (Cloud-Function-backed on prod since V3.308),
 * presenting a per-field diff the user applies selectively.
 *
 * Write path: ONE targeted `items/{id}.set(payload)` — never a collection
 * rewrite. `updatedAt` is stamped with a serverTimestamp so the api
 * adapter's MAX(updatedAt) cache probe invalidates other clients. The
 * abstract is heavy and lives in items/{id}/details/main — it loads from
 * and saves through LIBRARY_EXTRAS, never the main doc.
 *
 * Invariants: item.id and citation_key never change implicitly
 * (annotations + storage paths key off the id). "Regenerate citation key"
 * is an explicit opt-in checkbox.
 *
 * Public API (window.LIBRARY_EDIT):
 *   open(item, { onSaved }) → shows the modal; onSaved(updatedItem) fires
 *                             after a successful save.
 */

(function () {
  // Light fields editable here. abstract is handled separately (extras
  // subdoc); heavy fields (references, cited_by, tldr) are never editable.
  const FETCH_DIFF_FIELDS = [
    ['title',       'Title'],
    ['authors',     'Authors'],
    ['year',        'Year'],
    ['journal',     'Journal'],
    ['journal_iso', 'Journal (ISO)'],
    ['issn',        'ISSN'],
    ['volume',      'Volume'],
    ['issue',       'Issue'],
    ['pages',       'Pages'],
    ['doi',         'DOI'],
    ['pmid',        'PMID'],
    ['arxiv_id',    'arXiv'],
    ['url',         'URL'],
    ['abstract',    'Abstract'],
  ];

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function _toast(kind, msg) {
    if (window.TOAST && window.TOAST[kind]) window.TOAST[kind](msg);
    else console[kind === 'error' ? 'error' : 'log']('[library-edit]', msg);
  }

  function _authorsToLines(authors) {
    return (authors || [])
      .map(a => [a.family, a.given].filter(Boolean).join(', '))
      .join('\n');
  }

  function _linesToAuthors(text) {
    return String(text || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const i = l.indexOf(',');
        if (i >= 0) return { family: l.slice(0, i).trim(), given: l.slice(i + 1).trim() };
        // Convenience: "Given Family" without a comma — last word is family.
        const j = l.lastIndexOf(' ');
        if (j > 0) return { family: l.slice(j + 1).trim(), given: l.slice(0, j).trim() };
        return { family: l, given: '' };
      });
  }

  function _fieldRow(label, id, value, opts) {
    const o = opts || {};
    const input = o.textarea
      ? `<textarea id="${id}" rows="${o.rows || 3}" style="width:100%;padding:6px 8px;font-size:12px;border:1px solid #d1d5db;border-radius:6px;font-family:inherit;resize:vertical;">${_esc(value)}</textarea>`
      : `<input type="text" id="${id}" value="${_esc(value)}" style="width:100%;padding:6px 8px;font-size:12px;border:1px solid #d1d5db;border-radius:6px;${o.mono ? 'font-family:ui-monospace,monospace;' : ''}">`;
    return `
      <label style="display:block;margin-bottom:10px;">
        <span style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#6b7280;margin-bottom:3px;">${_esc(label)}${o.hint ? ` <span style="text-transform:none;letter-spacing:0;color:#9ca3af;">— ${_esc(o.hint)}</span>` : ''}</span>
        ${input}
      </label>`;
  }

  function _collectForm(root) {
    const v = id => (root.querySelector('#' + id) ? root.querySelector('#' + id).value : '');
    return {
      title: v('le-title').trim(),
      authors: _linesToAuthors(v('le-authors')),
      year: v('le-year').trim(),
      journal: v('le-journal').trim(),
      journal_iso: v('le-journal-iso').trim(),
      issn: v('le-issn').trim(),
      volume: v('le-volume').trim(),
      issue: v('le-issue').trim(),
      pages: v('le-pages').trim(),
      doi: v('le-doi').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''),
      pmid: v('le-pmid').trim(),
      arxiv_id: v('le-arxiv').trim().replace(/^arxiv:\s*/i, ''),
      url: v('le-url').trim(),
      tags: v('le-tags').split('\n').map(t => t.trim()).filter(Boolean),
      abstract: v('le-abstract'),
      regenKey: !!(root.querySelector('#le-regen-key') && root.querySelector('#le-regen-key').checked),
    };
  }

  // Value of a diffable field as currently held by the FORM (so repeated
  // fetches diff against what the user sees, not the original item).
  function _formValueFor(root, key) {
    const map = {
      title: 'le-title', authors: 'le-authors', year: 'le-year',
      journal: 'le-journal', journal_iso: 'le-journal-iso', issn: 'le-issn',
      volume: 'le-volume', issue: 'le-issue', pages: 'le-pages',
      doi: 'le-doi', pmid: 'le-pmid', arxiv_id: 'le-arxiv', url: 'le-url',
      abstract: 'le-abstract',
    };
    const el = root.querySelector('#' + map[key]);
    return el ? el.value : '';
  }

  function _setFormValue(root, key, value) {
    const map = {
      title: 'le-title', authors: 'le-authors', year: 'le-year',
      journal: 'le-journal', journal_iso: 'le-journal-iso', issn: 'le-issn',
      volume: 'le-volume', issue: 'le-issue', pages: 'le-pages',
      doi: 'le-doi', pmid: 'le-pmid', arxiv_id: 'le-arxiv', url: 'le-url',
      abstract: 'le-abstract',
    };
    const el = root.querySelector('#' + map[key]);
    if (el) el.value = value;
  }

  function _renderDiff(root, fetched) {
    const host = root.querySelector('#le-diff');
    if (!host) return;
    const rows = [];
    for (const [key, label] of FETCH_DIFF_FIELDS) {
      let fetchedVal = fetched[key];
      if (key === 'authors') fetchedVal = _authorsToLines(fetchedVal);
      fetchedVal = String(fetchedVal ?? '').trim();
      if (!fetchedVal) continue;                     // nothing to offer
      const currentVal = String(_formValueFor(root, key) || '').trim();
      if (currentVal === fetchedVal) continue;       // already identical
      const preChecked = !currentVal;                // fill blanks by default
      rows.push(`
        <tr data-diff-key="${_esc(key)}" data-fetched="${_esc(fetchedVal)}">
          <td style="padding:4px 6px;vertical-align:top;"><input type="checkbox" ${preChecked ? 'checked' : ''}></td>
          <td style="padding:4px 6px;vertical-align:top;font-weight:600;white-space:nowrap;">${_esc(label)}</td>
          <td style="padding:4px 6px;vertical-align:top;color:#9ca3af;max-width:180px;overflow-wrap:anywhere;">${_esc(currentVal || '(empty)')}</td>
          <td style="padding:4px 6px;vertical-align:top;color:#065f46;max-width:220px;overflow-wrap:anywhere;">${_esc(fetchedVal)}</td>
        </tr>`);
    }
    if (!rows.length) {
      host.innerHTML = `<div style="padding:8px;color:#6b7280;font-size:12px;">Fetched record matches the current fields — nothing to apply.</div>`;
      return;
    }
    host.innerHTML = `
      <div style="border:1px solid #d1d5db;border-radius:8px;overflow:hidden;margin-bottom:8px;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="background:#f9fafb;color:#6b7280;text-align:left;">
              <th style="padding:4px 6px;"></th>
              <th style="padding:4px 6px;">Field</th>
              <th style="padding:4px 6px;">Current</th>
              <th style="padding:4px 6px;">Fetched</th>
            </tr>
          </thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>
      <button type="button" class="btn btn-sm" id="le-apply-diff">Apply selected</button>
      <span style="font-size:11px;color:#9ca3af;margin-left:6px;">Blank fields are pre-checked; conflicts are not. Nothing is saved until you hit Save.</span>`;
    host.querySelector('#le-apply-diff').addEventListener('click', () => {
      host.querySelectorAll('tr[data-diff-key]').forEach(tr => {
        const cb = tr.querySelector('input[type=checkbox]');
        if (cb && cb.checked) _setFormValue(root, tr.dataset.diffKey, tr.dataset.fetched);
      });
      host.innerHTML = `<div style="padding:8px;color:#065f46;font-size:12px;">Applied. Review the fields above, then Save.</div>`;
    });
  }

  /** V3.328 — re-read the paper's OWN stored PDF: first-page DOI/arXiv
   *  sniff + largest-font title guess (the V3.308 client-side extraction),
   *  then look the result up and feed the existing diff table. This is
   *  the repair path for "paper-<hash>" rows whose stored title matches
   *  nothing — the PDF itself is the only usable evidence. */
  async function _rescanPdf(item, root) {
    const lib = (item.meta && item.meta.library) || {};
    if (!lib.pdf || !lib.pdf.storage_path) return;
    if (!window.LIBRARY_UPLOAD || !LIBRARY_UPLOAD.downloadUrl) {
      _toast('error', 'library-upload.js is not loaded on this page.');
      return;
    }
    if (!window.PDF_VIEWER || !PDF_VIEWER.extractTextItemsFromPdf) {
      _toast('error', 'PDF text extraction is not available on this page (pdf-viewer.js missing).');
      return;
    }
    const btn = root.querySelector('#le-rescan');
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Scanning…';
    try {
      const url = await LIBRARY_UPLOAD.downloadUrl(lib.pdf.storage_path);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('PDF fetch HTTP ' + resp.status);
      const blob = await resp.blob();
      const fp = await LIBRARY_METADATA.extractFirstPage(blob);
      let meta = null;
      if (fp.doi_guess) {
        meta = await LIBRARY_METADATA.lookup({ doi: fp.doi_guess });
      } else if (fp.arxiv_guess) {
        meta = await LIBRARY_METADATA.lookup({ arxiv_id: fp.arxiv_guess });
      } else {
        const t = (fp.title_guess || '').trim()
          || ((fp.text || '').split('\n').find(l => l.trim().length > 12) || '').trim();
        if (t) meta = await LIBRARY_METADATA.lookup({ title: t.slice(0, 200) });
      }
      if (meta && !meta.error && meta.title) {
        _renderDiff(root, meta);
      } else if (fp.title_guess || fp.doi_guess || fp.arxiv_guess) {
        // No authoritative database record, but the PDF itself yielded
        // something — offer the raw sniff so the row can at least adopt
        // the paper's real title / identifier.
        _renderDiff(root, {
          title: fp.title_guess || '',
          doi: fp.doi_guess || '',
          arxiv_id: fp.arxiv_guess || '',
        });
        _toast('info', 'No database match — offering what the PDF first page itself says.');
      } else {
        _toast('error', 'Nothing usable on the PDF first page — likely a scan with no text layer. Fill the fields manually.');
      }
    } catch (e) {
      _toast('error', 'Re-scan failed: ' + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  async function _fetchFromIdentifier(root) {
    const doi = _formValueFor(root, 'doi').trim();
    const pmid = _formValueFor(root, 'pmid').trim();
    const arxiv = _formValueFor(root, 'arxiv_id').trim();
    let params = null;
    if (doi) params = { doi };
    else if (pmid) params = { pmid };
    else if (arxiv) params = { arxiv_id: arxiv };
    if (!params) {
      _toast('error', 'Enter a DOI, PMID, or arXiv id first — the fetch keys off those fields.');
      return;
    }
    const btn = root.querySelector('#le-fetch');
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    try {
      const meta = await LIBRARY_METADATA.lookup(params);
      if (meta && meta.error) throw new Error(meta.error);
      _renderDiff(root, meta || {});
    } catch (e) {
      _toast('error', 'Fetch failed: ' + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  async function _save(item, root, extrasAbstract, opts) {
    if (typeof firebase === 'undefined' || !firebase.firestore
        || !firebase.auth || !firebase.auth().currentUser) {
      throw new Error('Sign in to edit metadata.');
    }
    const form = _collectForm(root);
    if (!form.title) throw new Error('Title is required.');

    // Deep-copy, then drop any adapter-injected Firestore timestamp — it
    // JSON-serializes to {seconds,nanoseconds} junk and we restamp below.
    const updated = JSON.parse(JSON.stringify(item));
    delete updated.updatedAt;
    updated.meta = updated.meta || {};
    updated.meta.library = updated.meta.library || {};
    const lib = updated.meta.library;

    updated.title = form.title;
    lib.authors = form.authors;
    lib.year = form.year;
    lib.journal = form.journal;
    lib.journal_iso = form.journal_iso;
    lib.issn = form.issn;
    lib.volume = form.volume;
    lib.issue = form.issue;
    lib.pages = form.pages;
    lib.doi = form.doi;
    lib.pmid = form.pmid;
    lib.arxiv_id = form.arxiv_id;
    lib.url = form.url || (form.doi ? `https://doi.org/${form.doi}` : lib.url || '');
    lib.tags = form.tags;
    if (lib.source === 'manual' && (form.doi || form.pmid || form.arxiv_id)) {
      lib.source = 'manual-edited';
    }
    // Keep the denormalized display fields consistent with the new authors.
    const first = form.authors[0] || {};
    updated.meta.lead_author = first.family
      ? [first.given, first.family].filter(Boolean).join(' ')
      : '';
    updated.meta.target_journal = form.journal || updated.meta.target_journal || '';
    if (form.regenKey) {
      lib.citation_key = LIBRARY_METADATA.citationKey({
        authors: form.authors, year: form.year, title: form.title,
      });
    }
    updated.updated_at = new Date().toISOString().slice(0, 10);

    // ONE targeted doc write. serverTimestamp drives the api adapter's
    // MAX(updatedAt) cache probe so other clients pick the change up.
    const payload = Object.assign({}, updated, {
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await firebase.firestore().collection('items').doc(updated.id).set(payload);

    // Abstract lives in the extras subdoc, not the main doc.
    if (window.LIBRARY_EXTRAS && form.abstract !== extrasAbstract) {
      try {
        await LIBRARY_EXTRAS.savePatch(updated.id, { abstract: form.abstract });
      } catch (e) {
        _toast('error', 'Metadata saved, but the abstract write failed: ' + (e.message || e));
      }
    }

    if (opts && typeof opts.onSaved === 'function') opts.onSaved(updated);
    return updated;
  }

  async function open(item, opts) {
    if (!item || !item.id) return;
    if (!window.LIBRARY_METADATA) {
      _toast('error', 'library-metadata.js is not loaded on this page.');
      return;
    }
    const lib = (item.meta && item.meta.library) || {};

    // The abstract is heavy → extras subdoc; load it before rendering so
    // the textarea starts from the stored value.
    let extrasAbstract = '';
    if (window.LIBRARY_EXTRAS) {
      try {
        const extras = await LIBRARY_EXTRAS.load(item.id, item);
        extrasAbstract = extras.abstract || '';
      } catch (_) { /* stays empty */ }
    }

    const overlay = document.createElement('div');
    overlay.id = 'le-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(17,24,39,0.45);z-index:9998;' +
      'display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:4vh 12px;';
    overlay.innerHTML = `
      <div id="le-card" style="background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.22);width:100%;max-width:680px;padding:18px 20px;margin-bottom:6vh;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
          <h3 style="margin:0;font-size:15px;">✎ Edit metadata</h3>
          <button type="button" class="btn btn-sm" id="le-close" title="Close without saving">✕</button>
        </div>
        <div style="font-size:11px;color:#9ca3af;margin-bottom:12px;">
          <code>${_esc(item.id)}</code> — the id and citation key never change on save (annotations and PDF paths key off them).
        </div>
        ${_fieldRow('Title', 'le-title', item.title || '')}
        ${_fieldRow('Authors', 'le-authors', _authorsToLines(lib.authors), { textarea: true, rows: 4, hint: 'one per line, "Family, Given"' })}
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 10px;">
          ${_fieldRow('Year', 'le-year', lib.year || '')}
          ${_fieldRow('Volume', 'le-volume', lib.volume || '')}
          ${_fieldRow('Issue', 'le-issue', lib.issue || '')}
        </div>
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:0 10px;">
          ${_fieldRow('Journal', 'le-journal', lib.journal || '')}
          ${_fieldRow('Pages', 'le-pages', lib.pages || '')}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 10px;">
          ${_fieldRow('Journal (ISO abbrev.)', 'le-journal-iso', lib.journal_iso || '')}
          ${_fieldRow('ISSN', 'le-issn', lib.issn || '', { mono: true })}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 10px;">
          ${_fieldRow('DOI', 'le-doi', lib.doi || '', { mono: true })}
          ${_fieldRow('PMID', 'le-pmid', lib.pmid || '', { mono: true })}
          ${_fieldRow('arXiv id', 'le-arxiv', lib.arxiv_id || '', { mono: true })}
        </div>
        ${_fieldRow('URL', 'le-url', lib.url || '', { mono: true })}
        ${_fieldRow('Tags', 'le-tags', (lib.tags || []).join('\n'), { textarea: true, rows: 2, hint: 'one per line, colon-delimited (research:papers:2026)' })}
        ${_fieldRow('Abstract', 'le-abstract', extrasAbstract, { textarea: true, rows: 5, hint: 'stored in the details subdoc' })}
        <div style="display:flex;align-items:center;gap:8px;margin:2px 0 12px;">
          <button type="button" class="btn btn-sm" id="le-fetch" title="Look up the DOI / PMID / arXiv id above and diff the result against these fields">⇣ Fetch from identifier</button>
          ${(lib.pdf && lib.pdf.storage_path) ? '<button type="button" class="btn btn-sm" id="le-rescan" title="Pull the stored PDF and re-read its first page — DOI/arXiv sniff + title guess — then diff the result (V3.328)">' + ICON.svg('document-text') + ' Re-scan PDF</button>' : ''}
          <label style="font-size:12px;color:#374151;display:flex;align-items:center;gap:5px;margin-left:auto;">
            <input type="checkbox" id="le-regen-key">
            Regenerate citation key <code style="color:#9ca3af;">${_esc(lib.citation_key || '')}</code>
          </label>
        </div>
        <div id="le-diff" style="margin-bottom:12px;"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px;border-top:1px solid #e5e7eb;padding-top:12px;">
          <button type="button" class="btn" id="le-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="le-save">Save</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    const root = overlay;

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
    root.querySelector('#le-close').addEventListener('click', close);
    root.querySelector('#le-cancel').addEventListener('click', close);
    root.querySelector('#le-fetch').addEventListener('click', () => _fetchFromIdentifier(root));
    const rescanBtn = root.querySelector('#le-rescan');
    if (rescanBtn) rescanBtn.addEventListener('click', () => _rescanPdf(item, root));
    root.querySelector('#le-save').addEventListener('click', async () => {
      const btn = root.querySelector('#le-save');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const updated = await _save(item, root, extrasAbstract, opts);
        _toast('success', `Updated "${updated.title}".`);
        close();
      } catch (e) {
        _toast('error', 'Save failed: ' + (e.message || e));
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    });
  }

  window.LIBRARY_EDIT = { open };
})();
