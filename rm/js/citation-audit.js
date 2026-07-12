/* citation-audit.js — V3.310 admin harness: run the reference-driven
 * citation detector (PAPER_CITATIONS.analyzeDocument) across EVERY stored
 * paper that has both a PDF and stored references, and report coverage —
 * style detected, % of refs located ≥1 inline marker, total markers.
 *
 * This is the "use the papers we already have stored to debug and test"
 * loop: the detector gets tuned against the lab's real corpus instead of
 * one paper at a time. Read-only — downloads PDFs, extracts text, writes
 * NOTHING back to Firestore.
 */

(function () {
  const $ = id => document.getElementById(id);
  let _rows = [];
  let _running = false;

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  async function _isAdmin() {
    try {
      if (window.firebridge && firebridge.isAdmin) return await firebridge.isAdmin();
    } catch (_) { /* fall through */ }
    return false;
  }

  async function _loadPapers() {
    const data = await api.load('library/papers.json');
    return ((data && data.papers) || []).filter(it =>
      it.meta && it.meta.library && it.meta.library.is_library_entry);
  }

  function _renderStatus(msg) { $('ca-status').textContent = msg; }

  function _coverageColor(pct) {
    if (pct >= 80) return '#065f46';
    if (pct >= 40) return '#92400e';
    return '#991b1b';
  }

  function _renderTable() {
    const done = _rows.filter(r => r.state === 'done');
    const totRefs = done.reduce((a, r) => a + r.result.refCount, 0);
    const totLocated = done.reduce((a, r) => a + r.result.locatedRefs, 0);
    const totMarkers = done.reduce((a, r) => a + r.result.markerCount, 0);
    $('ca-totals').innerHTML = done.length
      ? `<b>${done.length}</b> paper(s) analyzed · <b>${totLocated}/${totRefs}</b> references located (${totRefs ? Math.round(100 * totLocated / totRefs) : 0}%) · <b>${totMarkers}</b> markers placed`
      : '';
    $('ca-table').innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr style="background:#f9fafb;text-align:left;color:#6b7280;">
          <th style="padding:6px 8px;">Paper</th>
          <th style="padding:6px 8px;">Style</th>
          <th style="padding:6px 8px;">Refs located</th>
          <th style="padding:6px 8px;">Markers</th>
          <th style="padding:6px 8px;">Notes</th>
        </tr></thead>
        <tbody>
          ${_rows.map(r => {
            if (r.state === 'pending') {
              return `<tr><td style="padding:5px 8px;">${_esc(r.title)}</td><td colspan="4" style="padding:5px 8px;color:#9ca3af;">queued…</td></tr>`;
            }
            if (r.state === 'running') {
              return `<tr><td style="padding:5px 8px;">${_esc(r.title)}</td><td colspan="4" style="padding:5px 8px;color:#1e40af;">analyzing…</td></tr>`;
            }
            if (r.state === 'skipped' || r.state === 'error') {
              return `<tr><td style="padding:5px 8px;color:#9ca3af;">${_esc(r.title)}</td><td colspan="4" style="padding:5px 8px;color:#9ca3af;">${_esc(r.note)}</td></tr>`;
            }
            const res = r.result;
            const pct = res.refCount ? Math.round(100 * res.locatedRefs / res.refCount) : 0;
            const missing = res.perRef.filter(p => !p.located).slice(0, 8)
              .map(p => `[${p.n}] ${p.firstAuthor} ${p.year}`).join(', ');
            return `<tr style="border-top:1px solid #f3f4f6;">
              <td style="padding:5px 8px;max-width:320px;overflow-wrap:anywhere;">${_esc(r.title)}</td>
              <td style="padding:5px 8px;"><code>${_esc(res.style)}</code></td>
              <td style="padding:5px 8px;color:${_coverageColor(pct)};font-weight:600;">${res.locatedRefs}/${res.refCount} (${pct}%)</td>
              <td style="padding:5px 8px;">${res.markerCount}</td>
              <td style="padding:5px 8px;color:#9ca3af;font-size:11px;max-width:280px;overflow-wrap:anywhere;">${missing ? 'unlocated: ' + _esc(missing) + (res.perRef.filter(p => !p.located).length > 8 ? '…' : '') : ''}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  async function _analyzeOne(row) {
    row.state = 'running';
    _renderTable();
    const it = row.item;
    const lib = it.meta.library;
    try {
      const extras = await LIBRARY_EXTRAS.load(it.id, it);
      const refs = (extras && extras.references) || [];
      if (!refs.length) { row.state = 'skipped'; row.note = 'no stored references'; return; }
      if (!lib.pdf || !lib.pdf.storage_path) { row.state = 'skipped'; row.note = 'no PDF'; return; }
      const url = await LIBRARY_UPLOAD.downloadUrl(lib.pdf.storage_path);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('PDF fetch HTTP ' + resp.status);
      const blob = await resp.blob();
      const items = await PDF_VIEWER.extractTextItemsFromPdf(blob);
      row.result = PAPER_CITATIONS.analyzeDocument({ items, refs });
      row.state = 'done';
    } catch (e) {
      row.state = 'error';
      row.note = e.message || String(e);
    }
  }

  async function _run() {
    if (_running) return;
    _running = true;
    $('ca-run').disabled = true;
    try {
      _renderStatus('Loading library…');
      const papers = await _loadPapers();
      _rows = papers.map(it => ({
        item: it,
        title: it.title || it.id,
        state: 'pending',
        note: '',
        result: null,
      }));
      _renderTable();
      for (let i = 0; i < _rows.length; i++) {
        _renderStatus(`Analyzing ${i + 1}/${_rows.length}…`);
        await _analyzeOne(_rows[i]);
        _renderTable();
      }
      _renderStatus('Done.');
    } catch (e) {
      _renderStatus('Failed: ' + (e.message || e));
    } finally {
      _running = false;
      $('ca-run').disabled = false;
    }
  }

  async function _boot() {
    // Wait for auth to settle, then gate.
    await new Promise(resolve => {
      if (typeof firebase === 'undefined' || !firebase.auth) return resolve();
      const off = firebase.auth().onAuthStateChanged(() => { off(); resolve(); });
    });
    if (!(await _isAdmin())) {
      $('ca-root').innerHTML = '<div style="padding:24px;color:#991b1b;">Admin only — the audit downloads every PDF in the library.</div>';
      return;
    }
    $('ca-run').addEventListener('click', _run);
    _renderStatus('Ready. Runs the reference-driven detector over every stored paper with a PDF + references. Read-only.');
  }

  document.addEventListener('DOMContentLoaded', _boot);
})();
