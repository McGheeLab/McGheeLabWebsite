/* library-recheck.js — V3.326 bulk metadata re-check for the whole library.
 *
 * The per-paper repair tools (V3.309 ✎ editor, V3.310 ↻ Refresh from DOI)
 * fix one paper at a time. This sweeps EVERY library entry in one run:
 *
 *   - identifier papers (DOI → PMID → arXiv): re-lookup via the V3.308
 *     libraryLookup function (metadataCache absorbs repeats) → fill
 *     missing fields (or full fetched-wins with the Overwrite option) →
 *     ONE targeted items/{id}.set per paper, and only when something
 *     actually changed;
 *   - papers missing references/abstract: Semantic Scholar enrichment
 *     (existing LIBRARY_UPLOAD pipeline, 3 s spacing — SS rate-limits);
 *   - identifier-less papers: a CrossRef title match is QUEUED for
 *     per-row human review — fuzzy hits are never bulk-applied.
 *
 * Public API (window.LIBRARY_RECHECK):
 *   open(items, { onItemSaved }) — shows the modal; onItemSaved(updated)
 *     fires after each successful save so the host list stays current.
 */

(function () {
  const SS_DELAY_MS = 3000;      // Semantic Scholar is the rate-limited hop
  const LOOKUP_DELAY_MS = 150;   // courtesy spacing; metadataCache does the rest

  // Fields merged from a lookup result onto meta.library.
  const FIELDS = ['year', 'journal', 'journal_iso', 'issn', 'volume',
    'issue', 'pages', 'doi', 'pmid', 'arxiv_id', 'url'];

  let _cancelled = false;
  let _running = false;

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function _lib(it) { return (it.meta && it.meta.library) || {}; }

  function _identifierOf(it) {
    const lib = _lib(it);
    if (lib.doi) return { doi: lib.doi };
    if (lib.pmid) return { pmid: lib.pmid };
    if (lib.arxiv_id) return { arxiv_id: lib.arxiv_id };
    return null;
  }

  function _isIncomplete(it, extras) {
    const lib = _lib(it);
    if (!(lib.authors && lib.authors.length)) return true;
    if (!lib.year || !lib.journal) return true;
    if (!lib.doi && !lib.pmid && !lib.arxiv_id) return true;
    if (extras && !extras.abstract) return true;
    if (extras && !(extras.references && extras.references.length)) return true;
    return false;
  }

  /* V3.496 — match a stored author to a freshly-fetched one by family
   * (case-insensitive) + first initial of given. Used for fill-only
   * ORCID/affiliation enrichment that never touches names. */
  function _matchFreshAuthor(fresh, a) {
    const fam = String(a.family || '').trim().toLowerCase();
    if (!fam) return null;
    const gi = String(a.given || '').trim().charAt(0).toLowerCase();
    return (fresh || []).find(f => {
      if (String(f.family || '').trim().toLowerCase() !== fam) return false;
      const fgi = String(f.given || '').trim().charAt(0).toLowerCase();
      return !gi || !fgi || gi === fgi;
    }) || null;
  }
  function _enrichAuthorIds(existing, fresh) {
    let filled = false;
    (existing || []).forEach(a => {
      const m = _matchFreshAuthor(fresh, a);
      if (!m) return;
      if (m.orcid && !a.orcid) { a.orcid = m.orcid; filled = true; }
      if (m.affiliation && !a.affiliation) { a.affiliation = m.affiliation; filled = true; }
    });
    return filled;
  }

  /** Merge fetched metadata onto a deep-copied item. Returns
   *  {updated, changed[]} — updated is null when nothing changed. */
  function _merge(it, meta, overwrite) {
    const updated = JSON.parse(JSON.stringify(it));
    delete updated.updatedAt;
    updated.meta = updated.meta || {};
    updated.meta.library = updated.meta.library || {};
    const lib = updated.meta.library;
    const changed = [];

    if (meta.title && meta.title !== updated.title && (overwrite || !updated.title)) {
      updated.title = meta.title;
      changed.push('title');
    }
    if (Array.isArray(meta.authors) && meta.authors.length
        && (overwrite || !(lib.authors && lib.authors.length))
        && JSON.stringify(lib.authors || []) !== JSON.stringify(meta.authors)) {
      lib.authors = meta.authors;
      changed.push('authors');
    }
    // V3.496 — fill-only ORCID/affiliation onto kept author names (skip when
    // we just replaced the whole array — those already carry the ids). Powers
    // Lab Themes research-group keying; a full (non-incomplete) recheck run
    // backfills legacy papers.
    if (Array.isArray(meta.authors) && meta.authors.length
        && Array.isArray(lib.authors) && lib.authors.length
        && changed.indexOf('authors') < 0
        && _enrichAuthorIds(lib.authors, meta.authors)) {
      changed.push('author-ids');
    }
    for (const f of FIELDS) {
      const v = meta[f];
      if (v == null || v === '') continue;
      if (lib[f] === v) continue;
      if (!overwrite && lib[f]) continue;   // fill-blanks mode keeps existing
      lib[f] = v;
      changed.push(f);
    }
    if (!changed.length) return { updated: null, changed };

    const first = (lib.authors && lib.authors[0]) || {};
    updated.meta.lead_author = first.family
      ? [first.given, first.family].filter(Boolean).join(' ')
      : updated.meta.lead_author || '';
    updated.meta.target_journal = lib.journal || updated.meta.target_journal || '';
    if (lib.source === 'manual' && (lib.doi || lib.pmid || lib.arxiv_id)) {
      lib.source = 'manual-edited';
    }
    updated.updated_at = new Date().toISOString().slice(0, 10);
    return { updated, changed };
  }

  async function _saveOne(updated) {
    const payload = Object.assign({}, updated, {
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await firebase.firestore().collection('items').doc(updated.id).set(payload);
  }

  function _counterHtml(c) {
    return `updated <b>${c.updated}</b> · enriched <b>${c.enriched}</b> · unchanged <b>${c.unchanged}</b> · needs review <b>${c.review}</b> · failed <b>${c.failed}</b>`;
  }

  async function _run(items, opts, ui, onItemSaved) {
    const counters = { updated: 0, enriched: 0, unchanged: 0, review: 0, failed: 0 };
    const reviewQueue = [];
    let lastSsAt = 0;

    for (let i = 0; i < items.length; i++) {
      if (_cancelled) break;
      const it = items[i];
      ui.status(`Checking ${i + 1}/${items.length} — ${it.title || it.id}`);
      try {
        // Extras drive the incomplete test + abstract/refs decisions.
        let extras = {};
        try { extras = await LIBRARY_EXTRAS.load(it.id, it); } catch (_) { /* keep {} */ }

        if (opts.onlyIncomplete && !_isIncomplete(it, extras)) {
          counters.unchanged++;
          ui.counters(counters);
          continue;
        }

        const idParams = _identifierOf(it);
        let current = it;

        if (idParams) {
          await _sleep(LOOKUP_DELAY_MS);
          const meta = await LIBRARY_METADATA.lookup(idParams);
          if (meta && !meta.error) {
            const { updated, changed } = _merge(current, meta, opts.overwrite);
            if (updated) {
              await _saveOne(updated);
              current = updated;
              if (onItemSaved) onItemSaved(updated);
              counters.updated++;
              ui.log(`✓ ${updated.title} — ${changed.join(', ')}`);
            } else {
              counters.unchanged++;
            }
            if (meta.abstract && !extras.abstract) {
              try { await LIBRARY_EXTRAS.savePatch(current.id, { abstract: meta.abstract }); }
              catch (_) { /* best-effort */ }
            }
          } else {
            counters.failed++;
            ui.log(`✗ ${current.title || current.id} — ${(meta && meta.error) || 'lookup failed'}`);
          }
        } else {
          // No identifier — queue a title match for HUMAN review.
          const title = (current.title || '').trim();
          if (title.length >= 8) {
            await _sleep(LOOKUP_DELAY_MS);
            const hit = await LIBRARY_METADATA.lookup({ title: title.slice(0, 200) });
            if (hit && !hit.error && hit.title) {
              reviewQueue.push({ item: current, meta: hit });
              counters.review++;
              ui.log(`? ${title} → candidate: ${hit.title}`);
            } else {
              counters.unchanged++;
            }
          } else {
            counters.unchanged++;
          }
        }

        // References / abstract enrichment where missing.
        const needsRefs = !(extras.references && extras.references.length);
        const hasId = !!_identifierOf(current);
        if (opts.enrich && hasId && needsRefs && !_cancelled) {
          const wait = SS_DELAY_MS - (Date.now() - lastSsAt);
          if (wait > 0) await _sleep(wait);
          lastSsAt = Date.now();
          try {
            await LIBRARY_UPLOAD.enrichItemFromSemanticScholar(current.id);
            counters.enriched++;
          } catch (e) {
            ui.log(`✗ SS enrich failed for ${current.title || current.id}: ${e.message || e}`);
          }
        }
      } catch (e) {
        counters.failed++;
        ui.log(`✗ ${it.title || it.id} — ${e.message || e}`);
      }
      ui.counters(counters);
    }

    ui.status(_cancelled ? 'Cancelled.' : 'Sweep done.');
    return { counters, reviewQueue };
  }

  function _renderReview(root, reviewQueue, opts, ui, onItemSaved) {
    const host = root.querySelector('#lrc-review');
    if (!reviewQueue.length) { host.innerHTML = ''; return; }
    host.innerHTML = `
      <div style="font-weight:600;font-size:12px;margin:10px 0 6px;">Needs review — title matches are fuzzy, apply each yourself (${reviewQueue.length})</div>
      ${reviewQueue.map((q, i) => {
        const m = q.meta;
        const authors = (m.authors || []).slice(0, 3).map(a => a.family).filter(Boolean).join(', ')
          + ((m.authors || []).length > 3 ? ' et al.' : '');
        return `
        <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:12px;" data-review-row="${i}">
          <div style="color:#9ca3af;">current: ${_esc(q.item.title || q.item.id)}</div>
          <div style="margin:3px 0;color:#065f46;">match: <b>${_esc(m.title)}</b><br>${_esc([authors, m.year, m.journal].filter(Boolean).join(' · '))}${m.doi ? ` · <code>${_esc(m.doi)}</code>` : ''}</div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm" data-review-apply="${i}">Apply</button>
            <button class="btn btn-sm" data-review-skip="${i}">Skip</button>
          </div>
        </div>`;
      }).join('')}`;

    host.querySelectorAll('[data-review-apply]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const q = reviewQueue[parseInt(btn.getAttribute('data-review-apply'), 10)];
        btn.disabled = true;
        try {
          // A human accepted the match — fetched wins, identifiers adopted.
          const { updated } = _merge(q.item, q.meta, true);
          if (updated) {
            await _saveOne(updated);
            if (onItemSaved) onItemSaved(updated);
            if (q.meta.abstract) {
              try {
                const extras = await LIBRARY_EXTRAS.load(updated.id, updated);
                if (!extras.abstract) await LIBRARY_EXTRAS.savePatch(updated.id, { abstract: q.meta.abstract });
              } catch (_) { /* best-effort */ }
            }
            if (opts.enrich && window.LIBRARY_UPLOAD) {
              LIBRARY_UPLOAD.enrichItemFromSemanticScholar(updated.id)
                .catch(e => console.warn('[library-recheck] post-apply SS enrich failed:', e));
            }
          }
          btn.closest('[data-review-row]').style.opacity = '0.45';
          btn.closest('[data-review-row]').querySelectorAll('button').forEach(b => { b.disabled = true; });
          ui.log(`✓ applied: ${q.meta.title}`);
        } catch (e) {
          btn.disabled = false;
          ui.log(`✗ apply failed: ${e.message || e}`);
        }
      });
    });
    host.querySelectorAll('[data-review-skip]').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('[data-review-row]');
        row.style.opacity = '0.45';
        row.querySelectorAll('button').forEach(b => { b.disabled = true; });
      });
    });
  }

  async function open(items, hooks) {
    if (_running) return;
    if (typeof firebase === 'undefined' || !firebase.auth || !firebase.auth().currentUser) {
      if (window.TOAST) TOAST.error('Sign in to re-check metadata.');
      return;
    }
    const papers = (items || []).filter(it => _lib(it).is_library_entry);
    const withId = papers.filter(it => _identifierOf(it)).length;

    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(17,24,39,0.45);z-index:9998;' +
      'display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:4vh 12px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.22);width:100%;max-width:640px;padding:18px 20px;margin-bottom:6vh;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <h3 style="margin:0;font-size:15px;">⟳ Re-check library metadata</h3>
          <button type="button" class="btn btn-sm" id="lrc-close">✕</button>
        </div>
        <div style="font-size:12px;color:#6b7280;margin-bottom:10px;">
          ${papers.length} paper(s) — ${withId} with an identifier (re-looked-up automatically),
          ${papers.length - withId} without (title matches are queued for your review, never auto-applied).
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;font-size:12px;margin-bottom:12px;">
          <label><input type="radio" name="lrc-scope" value="incomplete" checked> Only incomplete papers (missing authors / year / journal / identifier / abstract / references)</label>
          <label><input type="radio" name="lrc-scope" value="all"> All papers</label>
          <label><input type="checkbox" id="lrc-overwrite"> Overwrite existing fields with fetched values (default fills blanks only)</label>
          <label><input type="checkbox" id="lrc-enrich" checked> Fetch references + abstract via Semantic Scholar where missing (slower — rate-limited)</label>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <button type="button" class="btn btn-primary" id="lrc-start">▶ Start</button>
          <span id="lrc-status" style="font-size:12px;color:#6b7280;"></span>
        </div>
        <div id="lrc-counters" style="font-size:12px;margin-bottom:6px;"></div>
        <div id="lrc-log" style="max-height:180px;overflow:auto;font-size:11px;font-family:ui-monospace,monospace;color:#374151;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:6px 8px;display:none;"></div>
        <div id="lrc-review"></div>
      </div>`;
    document.body.appendChild(overlay);

    const ui = {
      status: t => { overlay.querySelector('#lrc-status').textContent = t; },
      counters: c => { overlay.querySelector('#lrc-counters').innerHTML = _counterHtml(c); },
      log: line => {
        const el = overlay.querySelector('#lrc-log');
        el.style.display = 'block';
        const div = document.createElement('div');
        div.textContent = line;
        el.appendChild(div);
        el.scrollTop = el.scrollHeight;
      },
    };

    function close() {
      _cancelled = true;
      overlay.remove();
    }
    overlay.querySelector('#lrc-close').addEventListener('click', close);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay && !_running) close(); });

    overlay.querySelector('#lrc-start').addEventListener('click', async () => {
      const startBtn = overlay.querySelector('#lrc-start');
      if (_running) { _cancelled = true; startBtn.textContent = 'Stopping…'; return; }
      _running = true;
      _cancelled = false;
      startBtn.textContent = '■ Cancel';
      const opts = {
        onlyIncomplete: overlay.querySelector('input[name=lrc-scope]:checked').value === 'incomplete',
        overwrite: overlay.querySelector('#lrc-overwrite').checked,
        enrich: overlay.querySelector('#lrc-enrich').checked,
      };
      try {
        const { reviewQueue } = await _run(papers, opts, ui, hooks && hooks.onItemSaved);
        _renderReview(overlay, reviewQueue, opts, ui, hooks && hooks.onItemSaved);
      } catch (e) {
        ui.status('Failed: ' + (e.message || e));
      } finally {
        _running = false;
        startBtn.textContent = '▶ Start';
      }
    });
  }

  window.LIBRARY_RECHECK = { open };
})();
