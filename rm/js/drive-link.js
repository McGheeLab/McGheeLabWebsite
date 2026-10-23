/* drive-link.js — Google Drive link helper (V3.743).
 *
 * Lab-meeting slides live as links into the lab's Google Drive
 * (mcgheelab@gmail.com), shared "anyone with the link". This module does
 * the three things every consumer needs and nothing else:
 *
 *   DRIVE_LINK.parse(url)            → { fileId, kind, url } | null
 *   DRIVE_LINK.verify(fileId, opts)  → Promise<DriveRef>
 *   DRIVE_LINK.card(ref, opts)       → HTML string (thumbnail + name + chips)
 *
 * DriveRef = { url, fileId, kind, name, mimeType, accessible: true|false|null,
 *              ownerEmail, ownerOk: true|false|null, verifiedAt, error }
 *
 * Verification has two tiers:
 *   1. With a browser API key (meetingConfig.driveApiKey — referrer-restricted,
 *      public by design like Firebase's own key): Drive API v3 files.get with
 *      NO user auth. It succeeds ONLY for files shared to anyone-with-link,
 *      so a 200 is the sharing proof; it also returns name/mimeType and,
 *      sometimes, owners[].emailAddress.
 *   2. Without a key: an <img> probe of drive.google.com/thumbnail?id=…,
 *      which loads only for publicly readable files. Proves sharing; knows
 *      nothing about the owner.
 *
 * Honesty rule: ownerOk is TRI-STATE. Google usually withholds the owner
 * email from anonymous requests, so `null` is the common case and renders
 * as "couldn't confirm it's in the lab Drive", never as a pass and never as
 * a hard block. Only `false` (we saw an email and it wasn't the lab's) is a
 * real mismatch.
 */
(function () {
  'use strict';

  var LAB_DRIVE_EMAIL = 'mcgheelab@gmail.com';
  var ID_RE = '([A-Za-z0-9_-]{20,})';

  /* Every Drive/Docs URL shape students actually paste. Order matters only
   * for the `kind` label; the id capture is the same everywhere. */
  var PATTERNS = [
    { re: new RegExp('docs\\.google\\.com/presentation/d/' + ID_RE), kind: 'presentation' },
    { re: new RegExp('docs\\.google\\.com/document/d/' + ID_RE),     kind: 'document' },
    { re: new RegExp('docs\\.google\\.com/spreadsheets/d/' + ID_RE), kind: 'spreadsheet' },
    { re: new RegExp('drive\\.google\\.com/drive/(?:u/\\d+/)?folders/' + ID_RE), kind: 'folder' },
    { re: new RegExp('drive\\.google\\.com/file/d/' + ID_RE),        kind: 'file' },
    { re: new RegExp('drive\\.google\\.com/(?:open|uc)\\?(?:[^#]*&)?id=' + ID_RE), kind: 'file' },
    { re: new RegExp('drive\\.google\\.com/thumbnail\\?(?:[^#]*&)?id=' + ID_RE), kind: 'file' },
  ];

  var KIND_LABEL = {
    presentation: 'Google Slides', document: 'Google Doc', spreadsheet: 'Google Sheet',
    folder: 'Drive folder', file: 'Drive file',
  };

  var MIME_LABEL = {
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.document': 'Google Doc',
    'application/vnd.google-apps.spreadsheet': 'Google Sheet',
    'application/vnd.google-apps.folder': 'Drive folder',
    'application/pdf': 'PDF',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
    'application/vnd.ms-powerpoint': 'PowerPoint',
    'application/vnd.apple.keynote': 'Keynote',
    'application/zip': 'ZIP',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function parse(url) {
    var s = String(url || '').trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
    for (var i = 0; i < PATTERNS.length; i++) {
      var m = s.match(PATTERNS[i].re);
      if (m) return { fileId: m[1], kind: PATTERNS[i].kind, url: s };
    }
    return null;
  }

  function isDriveHost(url) {
    return /https?:\/\/(drive|docs)\.google\.com\//i.test(String(url || ''));
  }

  /* Stable, public thumbnail URL. The API's thumbnailLink expires in hours;
   * this one works for as long as the file stays shared — which is exactly
   * the condition we require anyway. */
  function thumbUrl(fileId, width) {
    return 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(fileId) + '&sz=w' + (width || 320);
  }

  function viewUrl(ref) {
    if (!ref) return '#';
    if (ref.url && isDriveHost(ref.url)) return ref.url;
    return 'https://drive.google.com/file/d/' + encodeURIComponent(ref.fileId) + '/view';
  }

  /* Tier 2: <img> probe. Resolves true (loaded → public), false (errored),
   * or null (timed out — network, not sharing). */
  function probe(fileId, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var img = new Image();
      var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, timeoutMs || 8000);
      img.onload  = function () { if (!done) { done = true; clearTimeout(t); resolve(true); } };
      img.onerror = function () { if (!done) { done = true; clearTimeout(t); resolve(false); } };
      img.src = thumbUrl(fileId, 64) + '&_p=' + Date.now();
    });
  }

  /* Tier 1: Drive API v3 files.get, key only, no user token. */
  async function apiGet(fileId, apiKey) {
    var fields = 'id,name,mimeType,owners(emailAddress,displayName),thumbnailLink,iconLink,webViewLink,driveId';
    var u = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId)
      + '?fields=' + encodeURIComponent(fields)
      + '&supportsAllDrives=true&key=' + encodeURIComponent(apiKey);
    var res = await fetch(u, { method: 'GET' });
    if (res.status === 200) return { ok: true, data: await res.json() };
    var body = null;
    try { body = await res.json(); } catch (e) { /* html error page */ }
    var msg = (body && body.error && body.error.message) || ('HTTP ' + res.status);
    // 404 to an anonymous caller = "not shared publicly" (Google hides
    // private files' existence). 403 = the KEY is the problem, not the file.
    return { ok: false, status: res.status, message: msg,
             keyProblem: res.status === 403 || res.status === 400 };
  }

  /* opts = { apiKey, labEmail, url } */
  async function verify(fileIdOrUrl, opts) {
    opts = opts || {};
    var parsed = parse(fileIdOrUrl) || (/^[A-Za-z0-9_-]{20,}$/.test(String(fileIdOrUrl || '')) ? { fileId: fileIdOrUrl, kind: 'file', url: opts.url || '' } : null);
    if (!parsed) {
      return { url: String(fileIdOrUrl || ''), fileId: null, kind: null, accessible: false, ownerOk: null,
               error: 'Not a Google Drive / Docs link', verifiedAt: new Date().toISOString() };
    }
    var ref = { url: parsed.url || opts.url || '', fileId: parsed.fileId, kind: parsed.kind,
                name: '', mimeType: '', accessible: null, ownerEmail: '', ownerOk: null,
                error: null, verifiedAt: new Date().toISOString(), method: 'none' };
    var labEmail = String(opts.labEmail || LAB_DRIVE_EMAIL).toLowerCase();

    if (opts.apiKey) {
      try {
        var r = await apiGet(parsed.fileId, opts.apiKey);
        ref.method = 'api';
        if (r.ok) {
          ref.accessible = true;
          ref.name = r.data.name || '';
          ref.mimeType = r.data.mimeType || '';
          if (r.data.webViewLink) ref.url = r.data.webViewLink;
          var owner = (r.data.owners || [])[0];
          if (owner && owner.emailAddress) {
            ref.ownerEmail = owner.emailAddress;
            ref.ownerOk = owner.emailAddress.toLowerCase() === labEmail;
          } else if (r.data.driveId) {
            ref.ownerOk = null;           // shared drive: no owner concept
          }
          return ref;
        }
        if (!r.keyProblem) {
          ref.accessible = false;
          ref.error = 'Google says this file isn’t shared publicly. In Drive: Share → General access → "Anyone with the link".';
          return ref;
        }
        // Key misconfigured / API not enabled → fall through to the probe so
        // the student still gets a sharing answer; surface the key issue.
        ref.keyError = r.message;
      } catch (e) {
        ref.keyError = e && e.message;
      }
    }

    var p = await probe(parsed.fileId);
    ref.method = 'probe';
    if (p === true) { ref.accessible = true; }
    else if (p === false) {
      ref.accessible = false;
      ref.error = parsed.kind === 'folder'
        ? 'Couldn’t open this folder anonymously. Set sharing to "Anyone with the link".'
        : 'Couldn’t open this file anonymously. In Drive: Share → General access → "Anyone with the link".';
    } else { ref.accessible = null; ref.error = 'Couldn’t reach Google to check sharing — try again.'; }
    return ref;
  }

  function typeLabel(ref) {
    if (!ref) return '';
    return MIME_LABEL[ref.mimeType] || KIND_LABEL[ref.kind] || 'Drive file';
  }

  /* Small status chips shown under a link. */
  function chips(ref) {
    if (!ref || !ref.fileId) return '';
    var out = [];
    if (ref.accessible === true) out.push('<span class="dl-chip dl-ok" title="Verified: opens for anyone with the link">' + icon('check-circle') + ' Shared</span>');
    else if (ref.accessible === false) out.push('<span class="dl-chip dl-bad" title="' + esc(ref.error || 'Not publicly shared') + '">' + icon('exclamation-triangle') + ' Not shared</span>');
    else out.push('<span class="dl-chip dl-unk" title="Sharing not checked yet">' + icon('eye') + ' Unchecked</span>');
    if (ref.ownerOk === true) out.push('<span class="dl-chip dl-ok" title="Owned by ' + esc(ref.ownerEmail) + '">' + icon('check-circle') + ' Lab Drive</span>');
    else if (ref.ownerOk === false) out.push('<span class="dl-chip dl-bad" title="Owned by ' + esc(ref.ownerEmail) + ' — move it into the lab Drive">' + icon('exclamation-triangle') + ' Not in lab Drive</span>');
    else if (ref.accessible === true) out.push('<span class="dl-chip dl-unk" title="Google doesn’t tell anonymous callers who owns a file. Make sure it lives in the mcgheelab@gmail.com Drive.">' + icon('eye') + ' Owner unconfirmed</span>');
    return out.join('');
  }

  function icon(name) {
    return (window.ICON && ICON.render) ? ICON.render(name, { size: 'sm' }) : '';
  }

  /* opts = { compact, label } */
  function card(ref, opts) {
    opts = opts || {};
    if (!ref || !ref.fileId) {
      return '<div class="dl-card dl-empty">' + esc(opts.emptyText || 'No link yet') + '</div>';
    }
    var name = ref.name || opts.label || typeLabel(ref);
    var showThumb = ref.accessible !== false && ref.kind !== 'folder';
    return '<a class="dl-card' + (opts.compact ? ' dl-compact' : '') + '" href="' + esc(viewUrl(ref)) + '" target="_blank" rel="noopener">'
      + (showThumb
          ? '<img class="dl-thumb" src="' + esc(thumbUrl(ref.fileId, opts.compact ? 160 : 320)) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
          : '<span class="dl-thumb dl-thumb-blank">' + icon(ref.kind === 'folder' ? 'archive-box' : 'document-text') + '</span>')
      + '<span class="dl-meta">'
      +   '<span class="dl-name">' + esc(name) + '</span>'
      +   '<span class="dl-type">' + esc(typeLabel(ref)) + ' ' + icon('arrow-top-right-on-square') + '</span>'
      +   '<span class="dl-chips">' + chips(ref) + '</span>'
      + '</span>'
      + '</a>';
  }

  var _css = false;
  function ensureCSS() {
    if (_css || document.getElementById('drive-link-css')) { _css = true; return; }
    var st = document.createElement('style');
    st.id = 'drive-link-css';
    st.textContent =
      '.dl-card{display:flex;gap:.65rem;align-items:flex-start;padding:.5rem;border:1px solid var(--border,#e1e4e8);border-radius:var(--radius,8px);background:var(--surface,#fff);color:inherit;text-decoration:none;max-width:420px}' +
      '.dl-card:hover{border-color:var(--primary,#2563eb)}' +
      '.dl-card.dl-empty{color:var(--text-muted,#6b7280);font-size:.85rem;border-style:dashed;display:block}' +
      '.dl-thumb{width:96px;height:72px;object-fit:cover;border-radius:6px;background:var(--bg,#f5f6fa);flex:none}' +
      '.dl-compact .dl-thumb{width:56px;height:42px}' +
      '.dl-thumb-blank{display:flex;align-items:center;justify-content:center;color:var(--text-muted,#6b7280)}' +
      '.dl-meta{display:flex;flex-direction:column;gap:.15rem;min-width:0}' +
      '.dl-name{font-weight:600;font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.dl-type{font-size:.75rem;color:var(--text-muted,#6b7280);display:inline-flex;align-items:center;gap:.25rem}' +
      '.dl-chips{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.15rem}' +
      '.dl-chip{display:inline-flex;align-items:center;gap:.2rem;font-size:.7rem;padding:.1rem .45rem;border-radius:999px;border:1px solid transparent}' +
      '.dl-ok{background:var(--green-bg,#dcfce7);color:var(--green,#166534)}' +
      '.dl-bad{background:var(--red-bg,#fee2e2);color:var(--red,#b91c1c)}' +
      '.dl-unk{background:var(--amber-bg,#fef3c7);color:var(--amber,#b45309)}';
    document.head.appendChild(st);
    _css = true;
  }
  if (document.head) ensureCSS(); else document.addEventListener('DOMContentLoaded', ensureCSS);

  window.DRIVE_LINK = {
    parse: parse, verify: verify, probe: probe, card: card, chips: chips,
    thumbUrl: thumbUrl, viewUrl: viewUrl, typeLabel: typeLabel, isDriveHost: isDriveHost,
    LAB_DRIVE_EMAIL: LAB_DRIVE_EMAIL,
  };
})();
