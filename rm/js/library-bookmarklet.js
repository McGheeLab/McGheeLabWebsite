/* library-bookmarklet.js — V3.500 "Grab PDF for RM" bookmarklet generator.
 *
 * For papers with NO open-access copy (paywalled). The bookmarklet runs ON the
 * publisher's page, so it fetches the PDF with the user's UArizona subscription
 * and POSTs the bytes to the uploadPaperPdf Cloud Function. Auth is a per-account
 * token (one reused per user) minted here into uploadTokens/{token} (the doc id
 * IS the secret, sent in the X-Upload-Token header); the function resolves
 * token → uid server-side.
 *
 * Public API (window.LIBRARY_BOOKMARKLET): open()
 */
(function () {
  var FN_URL = 'https://us-central1-mcgheelab-f56cc.cloudfunctions.net/uploadPaperPdf';

  // Single-line bookmarklet body (ASCII only, no apostrophes) with
  // __TOKEN__ / __FN__ slots. The token rides in the X-Upload-Token HEADER
  // (never the query string → not logged). If the in-browser PDF fetch is
  // CORS-blocked by the publisher, it falls back to opening the PDF so the
  // user can save + drag it in manually.
  var BM = "(function(){var T='__TOKEN__',FN='__FN__';function m(n){var e=document.querySelector('meta[name=\"'+n+'\"]');return e?e.content:'';}var doi=m('citation_doi'),title=m('citation_title')||document.title||'',pmid=m('citation_pmid'),ax=m('citation_arxiv_id');var p=m('citation_pdf_url');if(!p){var l=document.querySelector('link[type=\"application/pdf\"]');if(l)p=l.href;}if(!p&&/\\.pdf($|\\?)/i.test(location.href))p=location.href;if(!p){alert('RM grabber: no PDF link found on this page. Open the article PDF, then click again.');return;}var b=document.createElement('div');b.style.cssText='position:fixed;top:12px;right:12px;z-index:2147483647;background:#111827;color:#fff;padding:10px 14px;border-radius:8px;font:13px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.45)';b.textContent='RM: fetching PDF...';document.body.appendChild(b);function done(t,k){b.textContent='RM: '+t;b.style.background=k?'#065f46':'#7f1d1d';setTimeout(function(){b.remove();},6000);}fetch(p,{credentials:'include'}).then(function(r){if(!r.ok)throw new Error('PDF '+r.status);return r.blob();}).then(function(bl){if(bl.size<1000)throw new Error('got a tiny/non-PDF response');var qs='?doi='+encodeURIComponent(doi||'')+'&title='+encodeURIComponent(title||'')+'&pmid='+encodeURIComponent(pmid||'')+'&arxiv_id='+encodeURIComponent(ax||'')+'&url='+encodeURIComponent(location.href);return fetch(FN+qs,{method:'POST',headers:{'Content-Type':'application/pdf','X-Upload-Token':T},body:bl});}).then(function(r){return r.json();}).then(function(d){if(d&&d.ok)done((d.attached?'attached to ':(d.skipped?'already had a PDF: ':'added '))+(d.title||'paper'),true);else done((d&&d.error)||'failed',false);}).catch(function(e){done('could not grab it here ('+e.message+'). Opening the PDF - save it, then drag it onto the RM library.',false);try{window.open(p,'_blank');}catch(_){}});})();";

  function _db() { return firebase.firestore(); }
  function _me() { return (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) || null; }

  function _randToken() {
    var a = new Uint8Array(24);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return btoa(String.fromCharCode.apply(null, a))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');   // 32 url-safe chars
  }

  async function _createToken() {
    var me = _me();
    var tok = _randToken();
    await _db().collection('uploadTokens').doc(tok).set({
      uid: me.uid,
      email: me.email || '',
      created_at: new Date().toISOString(),
      label: (navigator.userAgent || '').slice(0, 80),
    });
    return tok;
  }

  async function _getOrCreateToken() {
    var me = _me();
    if (!me) throw new Error('Sign in first.');
    var snap = await _db().collection('uploadTokens').where('uid', '==', me.uid).limit(1).get();
    if (!snap.empty) return snap.docs[0].id;
    return _createToken();
  }

  async function _rotate() {
    var me = _me();
    var snap = await _db().collection('uploadTokens').where('uid', '==', me.uid).get();
    for (var i = 0; i < snap.docs.length; i++) {
      try { await snap.docs[i].ref.delete(); } catch (e) { /* ignore */ }
    }
    return _createToken();
  }

  function _bookmarkletFor(token) {
    return 'javascript:' + BM.replace('__TOKEN__', token).replace('__FN__', FN_URL);
  }

  async function open() {
    if (!_me()) { if (window.TOAST) TOAST.error('Sign in to generate the PDF grabber.'); return; }
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(17,24,39,.45);z-index:9998;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:4vh 12px;';
    overlay.innerHTML =
      '<div style="background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.22);width:100%;max-width:600px;padding:18px 20px;margin-bottom:6vh;">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;"><h3 style="margin:0;font-size:15px;">' + ICON.svg('bookmark') + ' PDF grabber (paywalled papers)</h3><button type="button" class="btn btn-sm" id="lbm-close">' + ICON.svg('x-mark') + '</button></div>'
      + '<div style="font-size:12px;color:#6b7280;line-height:1.55;margin-bottom:12px;">For papers with no open-access copy, this bookmarklet grabs the PDF <b>in your logged-in browser</b> (using your UArizona access) and sends it to your RM library — attaching to the existing entry when it matches, else adding a new one.<br><br><b>Setup:</b> drag the blue button to your bookmarks bar. <b>Use:</b> open a paper’s page where you can see/download the PDF, then click the bookmark.</div>'
      + '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px;"><a id="lbm-link" style="display:inline-block;padding:8px 14px;background:#1e40af;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;cursor:grab;">' + ICON.svg('bookmark') + ' Grab PDF for RM</a><span style="font-size:11px;color:#9ca3af;">← drag me to the bookmarks bar</span></div>'
      + '<div style="font-size:11px;color:#6b7280;margin-bottom:8px;">Carries a private upload token tied to your account — don’t share it. Lost a device? Rotate it (invalidates every old copy).</div>'
      + '<div style="display:flex;gap:8px;"><button type="button" class="btn btn-sm" id="lbm-rotate">' + ICON.svg('arrow-path') + ' Rotate token</button><span id="lbm-status" style="font-size:12px;color:#6b7280;align-self:center;"></span></div>'
      + '</div>';
    document.body.appendChild(overlay);
    var linkEl = overlay.querySelector('#lbm-link');
    var statusEl = overlay.querySelector('#lbm-status');
    function setLink(tok) { linkEl.href = _bookmarkletFor(tok); }
    function close() { overlay.remove(); }
    overlay.querySelector('#lbm-close').addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    // Clicking it inside the app should NOT run the bookmarklet — it's drag-only.
    linkEl.addEventListener('click', function (e) { e.preventDefault(); });
    overlay.querySelector('#lbm-rotate').addEventListener('click', async function () {
      statusEl.textContent = 'Rotating…';
      try { setLink(await _rotate()); statusEl.textContent = 'New token active — re-drag the button.'; }
      catch (e) { statusEl.textContent = 'Failed: ' + (e.message || e); }
    });
    try { setLink(await _getOrCreateToken()); }
    catch (e) { statusEl.textContent = 'Failed: ' + (e.message || e); }
  }

  window.LIBRARY_BOOKMARKLET = { open: open };
})();
