/* library-fetch-pdfs.js — V3.498 bulk open-access PDF fetcher.
 *
 * The per-row ↻ auto-fetch (library.js `_retryPdf`) grabs one PDF at a time.
 * This sweeps EVERY library entry that is missing a PDF but has an identifier,
 * running the server-side fetchPaperPdf engine (LIBRARY_UPLOAD.serverFetchPdf —
 * no CORS; Unpaywall all-locations + arXiv + Europe PMC + Semantic Scholar +
 * the publisher's citation_pdf_url) on each and attaching the PDF to that entry.
 *
 * Modal + write pattern mirror library-recheck.js: a targeted single-doc
 * items/{id}.set per success (never a whole-collection rewrite), route-cache
 * invalidation so the list refreshes, and an onItemSaved hook so the host list
 * stays current.
 *
 * Public API (window.LIBRARY_FETCH_PDFS):
 *   open(items, { onItemSaved }) — shows the modal.
 */
(function () {
  const DELAY_MS = 1200;          // polite spacing (Unpaywall / Semantic Scholar)
  let _cancelled = false;
  let _running = false;

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function _lib(it) { return (it.meta && it.meta.library) || {}; }

  function _hasIdentifier(it) {
    const l = _lib(it);
    return !!(l.doi || l.pmid || l.arxiv_id || l.url || l.pdf_candidate_url);
  }
  function _needsPdf(it) {
    const l = _lib(it);
    return l.is_library_entry
      && !(l.pdf && l.pdf.storage_path)
      && l.pdf_status !== 'unobtainable';
  }

  // Targeted single-doc write (library-recheck / _saveOne pattern) + cache
  // invalidation (the direct write bypasses api.save).
  async function _saveOne(it) {
    it.updated_at = new Date().toISOString().slice(0, 10);
    const payload = JSON.parse(JSON.stringify(it));
    delete payload.updatedAt;
    payload.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await firebase.firestore().collection('items').doc(it.id).set(payload);
    if (typeof api !== 'undefined' && api.invalidate) {
      api.invalidate('items.json');
      api.invalidate('library/papers.json');
    }
  }

  async function _fetchOne(it) {
    const out = await LIBRARY_UPLOAD.serverFetchPdf(it);
    if (!out || !out.ok || !out.storage_path) {
      // Record the miss (like the per-row ↻ retry) so a paywalled paper's ↻
      // tooltip reflects the attempt. A THROWN error (transport) is handled by
      // the caller and deliberately not stamped as a "no OA copy" verdict.
      const lib = it.meta.library;
      const retry = Object.assign({ attempts: 0 }, lib.pdf_retry || {});
      retry.attempts = (retry.attempts || 0) + 1;
      retry.last_at = new Date().toISOString();
      retry.last_error = (out && out.error) || 'no open-access PDF found';
      lib.pdf_retry = retry;
      try { await _saveOne(it); } catch (_) { /* stamp is best-effort */ }
      return { ok: false, error: retry.last_error };
    }
    const lib = it.meta.library;
    const me = (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) || null;
    lib.pdf = {
      storage_path: out.storage_path,
      hash: out.hash,
      filename_safe: `${it.id}.pdf`,
      size_bytes: out.size_bytes,
      uploaded_at: new Date().toISOString().slice(0, 10),
      uploaded_by: (me && me.email) || '',
      source: out.source ? `oa_${out.source}` : 'oa_auto',
    };
    delete lib.pdf_status;
    delete lib.pdf_candidate_url;
    await _saveOne(it);
    if (LIBRARY_UPLOAD.enrichItemFromSemanticScholar) {
      LIBRARY_UPLOAD.enrichItemFromSemanticScholar(it.id).catch(() => { /* best-effort */ });
    }
    return { ok: true, source: out.source };
  }

  async function _run(targets, ui, onItemSaved) {
    const c = { fetched: 0, missed: 0, failed: 0 };
    for (let i = 0; i < targets.length; i++) {
      if (_cancelled) break;
      const it = targets[i];
      if (!_needsPdf(it)) continue;   // already got a PDF (per-row / prior run) — skip
      ui.status(`Fetching ${i + 1}/${targets.length} — ${it.title || it.id}`);
      try {
        const r = await _fetchOne(it);
        if (r.ok) {
          c.fetched++;
          ui.log(`✓ ${it.title || it.id} — via ${r.source || 'OA'}`);
          if (onItemSaved) { try { onItemSaved(it); } catch (_) { /* host's problem */ } }
        } else {
          c.missed++;
          ui.log(`· ${it.title || it.id} — ${r.error}`);
        }
      } catch (e) {
        c.failed++;
        ui.log(`✗ ${it.title || it.id} — ${e.message || e}`);
      }
      ui.counters(c);
      if (i < targets.length - 1 && !_cancelled) await _sleep(DELAY_MS);
    }
    ui.status(_cancelled ? 'Cancelled.' : 'Sweep done.');
    return c;
  }

  function _counterHtml(c) {
    return `fetched <b>${c.fetched}</b> · no OA copy <b>${c.missed}</b> · failed <b>${c.failed}</b>`;
  }

  function open(items, hooks) {
    if (_running) return;
    if (typeof firebase === 'undefined' || !firebase.auth || !firebase.auth().currentUser) {
      if (window.TOAST) TOAST.error('Sign in to fetch PDFs.');
      return;
    }
    const targets = (items || []).filter(it => _needsPdf(it) && _hasIdentifier(it));
    const noId = (items || []).filter(it => _needsPdf(it) && !_hasIdentifier(it)).length;

    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(17,24,39,0.45);z-index:9998;' +
      'display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:4vh 12px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.22);width:100%;max-width:640px;padding:18px 20px;margin-bottom:6vh;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <h3 style="margin:0;font-size:15px;">⤓ Fetch missing open-access PDFs</h3>
          <button type="button" class="btn btn-sm" id="lfp-close">✕</button>
        </div>
        <div style="font-size:12px;color:#6b7280;margin-bottom:12px;">
          ${targets.length} paper(s) missing a PDF have an identifier and will be tried
          server-side (Unpaywall + arXiv + Europe PMC + Semantic Scholar + the publisher's
          PDF link — no CORS).${noId ? ` ${noId} more have no identifier and are skipped (add a DOI via ✎ first).` : ''}
          Paywalled papers with no open-access copy won't be found here — use the ${ICON.svg('arrow-up')} manual upload for those.
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <button type="button" class="btn btn-primary" id="lfp-start" ${targets.length ? '' : 'disabled'}>${ICON.svg('play')} Start</button>
          <span id="lfp-status" style="font-size:12px;color:#6b7280;"></span>
        </div>
        <div id="lfp-counters" style="font-size:12px;margin-bottom:6px;"></div>
        <div id="lfp-log" style="max-height:200px;overflow:auto;font-size:11px;font-family:ui-monospace,monospace;color:#374151;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:6px 8px;display:none;"></div>
      </div>`;
    document.body.appendChild(overlay);

    const ui = {
      status: t => { overlay.querySelector('#lfp-status').textContent = t; },
      counters: c => { overlay.querySelector('#lfp-counters').innerHTML = _counterHtml(c); },
      log: line => {
        const el = overlay.querySelector('#lfp-log');
        el.style.display = 'block';
        const div = document.createElement('div');
        div.textContent = line;
        el.appendChild(div);
        el.scrollTop = el.scrollHeight;
      },
    };

    function close() { _cancelled = true; _running = false; overlay.remove(); }
    overlay.querySelector('#lfp-close').addEventListener('click', close);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay && !_running) close(); });

    overlay.querySelector('#lfp-start').addEventListener('click', async () => {
      const startBtn = overlay.querySelector('#lfp-start');
      if (_running) { _cancelled = true; startBtn.textContent = 'Stopping…'; return; }
      _running = true;
      _cancelled = false;
      startBtn.textContent = '■ Cancel';
      try {
        // Re-filter at run time so re-clicking Start after a sweep doesn't
        // re-fetch papers that already received a PDF this session.
        const pending = targets.filter(t => _needsPdf(t) && _hasIdentifier(t));
        await _run(pending, ui, hooks && hooks.onItemSaved);
      } catch (e) {
        ui.status('Failed: ' + (e.message || e));
      } finally {
        _running = false;
        ICON.label(startBtn, 'play', ' Start');
      }
    });
  }

  window.LIBRARY_FETCH_PDFS = { open };
})();
