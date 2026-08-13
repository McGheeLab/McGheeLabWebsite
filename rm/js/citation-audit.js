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
  let _baseline = null;   // V3.331 — loaded prior-run JSON, keyed by paper id

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  async function _isAdmin() {
    try {
      if (typeof firebridge !== 'undefined' && firebridge.isAdmin) return await firebridge.isAdmin();
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

  // V3.331 — failure buckets: WHY a paper under-performs, not just that it does.
  function _buckets(res) {
    const out = [];
    const pct = res.refCount ? (100 * res.locatedRefs / res.refCount) : 0;
    if (res.style === 'none' && res.refCount) out.push('no-style-detected');
    else if (pct < 50) out.push('low-coverage');
    if (res.alignedCount > 0) out.push(`numbering-drift-fixed(${res.alignedCount})`);
    if ((res.fragmentationSuspects || 0) > 3 && pct < 80) out.push('fragmentation-suspected');
    return out;
  }

  function _renderTable() {
    const done = _rows.filter(r => r.state === 'done');
    const totRefs = done.reduce((a, r) => a + r.result.refCount, 0);
    const totLocated = done.reduce((a, r) => a + r.result.locatedRefs, 0);
    const totMarkers = done.reduce((a, r) => a + r.result.markerCount, 0);
    // Per-style corpus totals.
    const byStyle = {};
    for (const r of done) {
      const s = r.result.style;
      byStyle[s] = byStyle[s] || { n: 0, refs: 0, located: 0 };
      byStyle[s].n++;
      byStyle[s].refs += r.result.refCount;
      byStyle[s].located += r.result.locatedRefs;
    }
    const styleLine = Object.entries(byStyle)
      .map(([s, v]) => `${s}: ${v.n} paper(s), ${v.located}/${v.refs} (${v.refs ? Math.round(100 * v.located / v.refs) : 0}%)`)
      .join(' · ');
    let deltaLine = '';
    if (_baseline && done.length) {
      const dLoc = done.reduce((a, r) => {
        const b = _baseline[r.item.id];
        return a + (b ? (r.result.locatedRefs - b.locatedRefs) : 0);
      }, 0);
      deltaLine = ` · Δ located vs baseline: <b style="color:${dLoc >= 0 ? '#065f46' : '#991b1b'};">${dLoc >= 0 ? '+' : ''}${dLoc}</b>`;
    }
    $('ca-totals').innerHTML = done.length
      ? `<b>${done.length}</b> paper(s) analyzed · <b>${totLocated}/${totRefs}</b> references located (${totRefs ? Math.round(100 * totLocated / totRefs) : 0}%) · <b>${totMarkers}</b> markers placed${deltaLine}<br><span style="color:#6b7280;font-size:11px;">${styleLine}</span>`
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
            const buckets = _buckets(res).map(b =>
              `<span style="background:#fef3c7;border:1px solid #fde68a;color:#92400e;border-radius:9px;padding:0 6px;font-size:10px;white-space:nowrap;">${_esc(b)}</span>`
            ).join(' ');
            const base = _baseline && _baseline[r.item.id];
            const delta = base ? (res.locatedRefs - base.locatedRefs) : null;
            const deltaHtml = delta === null ? ''
              : ` <span style="font-size:10px;color:${delta >= 0 ? '#065f46' : '#991b1b'};">(${delta >= 0 ? '+' : ''}${delta})</span>`;
            const ctx = (res.missDetails && res.missDetails.length)
              ? `<details style="margin-top:3px;"><summary style="cursor:pointer;font-size:10px;color:#1e40af;">miss contexts (${res.missDetails.length})</summary>
                  <div style="font-family:ui-monospace,monospace;font-size:10px;color:#374151;white-space:pre-wrap;max-height:160px;overflow:auto;">${
                    res.missDetails.map(d => `[${d.n}] ${_esc(d.firstAuthor)} ${_esc(d.year)}\n${d.contexts.map(_esc).join('\n')}`).join('\n\n')
                  }</div></details>`
              : '';
            return `<tr style="border-top:1px solid #f3f4f6;">
              <td style="padding:5px 8px;max-width:320px;overflow-wrap:anywhere;">${_esc(r.title)}</td>
              <td style="padding:5px 8px;"><code>${_esc(res.style)}</code></td>
              <td style="padding:5px 8px;color:${_coverageColor(pct)};font-weight:600;">${res.locatedRefs}/${res.refCount} (${pct}%)${deltaHtml}</td>
              <td style="padding:5px 8px;">${res.markerCount}</td>
              <td style="padding:5px 8px;color:#9ca3af;font-size:11px;max-width:300px;overflow-wrap:anywhere;">${buckets}${missing ? `<div>unlocated: ${_esc(missing)}${res.perRef.filter(p => !p.located).length > 8 ? '…' : ''}</div>` : ''}${ctx}</td>
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
      // V3.335 — extract Link annotations too; publisher PDFs' internal
      // links are the authoritative citation markers.
      const ext = await PDF_VIEWER.extractTextItemsFromPdf(blob, { withAnnotations: true });
      row.result = PAPER_CITATIONS.analyzeDocument({
        items: ext.items, refs, annotations: ext.links, debug: true,
      });
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
    // V3.331 — export this run / load a prior run as the comparison baseline.
    $('ca-export').addEventListener('click', () => {
      const done = _rows.filter(r => r.state === 'done');
      if (!done.length) { _renderStatus('Nothing to export — run the audit first.'); return; }
      const payload = {};
      for (const r of done) {
        payload[r.item.id] = {
          title: r.title,
          style: r.result.style,
          refCount: r.result.refCount,
          locatedRefs: r.result.locatedRefs,
          markerCount: r.result.markerCount,
          buckets: _buckets(r.result),
        };
      }
      const blob = new Blob(
        [JSON.stringify({ exported_at: new Date().toISOString(), papers: payload }, null, 2)],
        { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `citation-audit-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $('ca-baseline').addEventListener('change', async () => {
      const file = $('ca-baseline').files && $('ca-baseline').files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        _baseline = data.papers || data;
        _renderStatus(`Baseline loaded (${Object.keys(_baseline).length} papers) — Δ shows against it.`);
        _renderTable();
      } catch (e) {
        _renderStatus('Baseline load failed: ' + (e.message || e));
      }
    });
    _renderStatus('Ready. Runs the reference-driven detector over every stored paper with a PDF + references. Read-only.');
  }

  document.addEventListener('DOMContentLoaded', _boot);
})();
