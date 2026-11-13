/* protocol-html.js — V3.987: protocols that are an HTML file.
 *
 * A student who builds an interactive protocol as a single web page (its
 * own calculators, drawings and Simple/Advanced switch) uploads that file
 * as a protocol instead of re-typing it into blocks. RM shows it, and it
 * posts to the lab website like any other protocol (protocol-publish.js).
 *
 * Shared by RM (list upload, ?view=html) and the public site
 * (#/protocols/{id}); it needs only a Firestore handle, never firebridge.
 *
 * ── Where the file lives ────────────────────────────────────────────
 * In Firestore, split into pieces (a document holds at most 1 MiB):
 *   protocols/{id}                 kind:'html', html_file {rev, chunks,
 *                                  size, name, uploaded_at, uploaded_by,
 *                                  uploaded_by_name}, html_revisions[]
 *   protocols/{id}/html/r{rev}-{n} { rev, n, data }      lab only
 *   publicProtocols/{id}/content/html-{n} { n, data }    when posted
 * Replacing the file writes a new revision and keeps the earlier ones, so
 * an earlier upload can still be downloaded.
 *
 * ── How it is shown: a sandboxed frame ──────────────────────────────
 * The file's scripts must run (that is the point of an interactive
 * protocol), but a file a student uploaded must never run as
 * mcgheelab.com: there it could read the visitor's sign-in. So it is drawn
 * with srcdoc in an <iframe sandbox> WITHOUT allow-same-origin: an opaque
 * origin with no access to the page around it, its storage or its cookies.
 * No allow-forms (nothing is submitted anywhere), no allow-top-navigation
 * (it cannot move the page it sits in). allow-modals for print and
 * alert(), allow-popups(-to-escape-sandbox) so its links open normally in
 * a new tab, allow-downloads for files it offers.
 *
 * A short helper is injected at the top of the file's <head>:
 *   - <base href="about:srcdoc">: a srcdoc document otherwise resolves
 *     links against the page AROUND it, so the file's own "#section"
 *     links would load that page into the frame instead of scrolling;
 *   - localStorage / sessionStorage that work (in memory, for the visit) —
 *     an opaque origin has none, and a page that uses them unguarded
 *     would stop with an error;
 *   - print on request from the page around it (the Print button), and
 *     Ctrl/Cmd+P inside the frame prints the protocol, not the RM page.
 *
 * Globals: window.ProtocolHtml.
 */
(function () {
  'use strict';

  var CHUNK = 300000;                // characters per piece: ≤ ~900 KB in UTF-8
  var MAX_BYTES = 7.5 * 1024 * 1024; // a post writes the whole file in one batch (Firestore: 10 MiB)
  var SANDBOX = 'allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads';
  var PRINT_MSG = 'mcgheelab-protocol-print';

  function byteSize(s) {
    try { return new Blob([s]).size; } catch (e) { return String(s || '').length; }
  }

  function split(html) {
    var out = [];
    var s = String(html || '');
    for (var i = 0; i < s.length; i += CHUNK) out.push(s.slice(i, i + CHUNK));
    return out.length ? out : [''];
  }

  function fmtSize(bytes) {
    if (!(bytes > 0)) return '0 KB';
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* Title and description the file gives itself, to fill the upload form. */
  function describe(html) {
    var out = { title: '', description: '', size: byteSize(html) };
    try {
      var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      out.title = (doc.title || '').trim();
      var meta = doc.querySelector('meta[name="description"]');
      if (meta) out.description = (meta.getAttribute('content') || '').trim();
      if (!out.title) {
        var h1 = doc.querySelector('h1');
        if (h1) out.title = h1.textContent.replace(/\s+/g, ' ').trim();
      }
    } catch (e) { /* the form just starts empty */ }
    return out;
  }

  /* Things that will not work once the file is on the website, said in
   * words a student can act on. Warnings, never refusals. */
  function warnings(html) {
    var s = String(html || '');
    var w = [];
    if (!/<html[\s>]|<body[\s>]|<!doctype html/i.test(s)) {
      w.push('This does not look like a web page (no <html> or <body>).');
    }
    if (/(?:src|href)\s*=\s*["'](?!https?:|data:|blob:|#|mailto:|javascript:)[^"'\s>]+\.(?:js|css|png|jpe?g|gif|svg|webp|json|csv|mp4|webm|woff2?)["']/i.test(s) ||
        /import\s[^;]*from\s+["']\.\.?\//i.test(s)) {
      w.push('It links to files beside it (pictures, scripts or styles in a folder). Only this one file is uploaded, so those will be missing — save the page as a single file with everything inside it.');
    }
    if (/<(?:script|link|img|iframe)[^>]*(?:src|href)\s*=\s*["']https?:/i.test(s) ||
        /@import\s+url\(\s*["']?https?:/i.test(s)) {
      w.push('It loads something from another website (a script, font or picture). It will work while that site is up, and not offline.');
    }
    if (/<form[\s>]/i.test(s)) {
      w.push('It has a form. Forms are not sent anywhere from the lab site.');
    }
    var size = byteSize(s);
    if (size > MAX_BYTES) {
      w.push('It is ' + fmtSize(size) + '; the limit is ' + fmtSize(MAX_BYTES) + '. Shrink the pictures inside it.');
    }
    return w;
  }

  var HELPER =
    '<base href="about:srcdoc">' +
    '<script>/* mcgheelab.com protocol frame helper (V3.987) */(function(){' +
      'function mem(){var s={};return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null},' +
        'setItem:function(k,v){s[String(k)]=String(v)},removeItem:function(k){delete s[String(k)]},' +
        'clear:function(){s={}},key:function(i){return Object.keys(s)[i]||null},get length(){return Object.keys(s).length}}}' +
      '["localStorage","sessionStorage"].forEach(function(n){try{window[n].length}catch(e){' +
        'try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});' +
      'window.addEventListener("message",function(e){if(e.source===window.parent&&e.data&&e.data.type==="' + PRINT_MSG + '"){window.print()}});' +
      'window.addEventListener("keydown",function(e){if((e.metaKey||e.ctrlKey)&&!e.altKey&&String(e.key).toLowerCase()==="p"){e.preventDefault();window.print()}},true);' +
    '})();<\/script>';

  /* The file with the helper first in its <head>. */
  function srcdoc(html) {
    var s = String(html || '');
    var m = /<head(?:\s[^>]*)?>/i.exec(s);
    if (m) return s.slice(0, m.index + m[0].length) + HELPER + s.slice(m.index + m[0].length);
    m = /<html(?:\s[^>]*)?>/i.exec(s);
    if (m) return s.slice(0, m.index + m[0].length) + '<head>' + HELPER + '</head>' + s.slice(m.index + m[0].length);
    return HELPER + s;
  }

  /* Draw the file in `container`. Returns the iframe. */
  function mountFrame(container, html, opts) {
    opts = opts || {};
    var frame = document.createElement('iframe');
    frame.className = opts.className || 'protocol-html-frame';
    frame.setAttribute('sandbox', SANDBOX);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', 'fullscreen');
    frame.title = opts.title || 'Protocol';
    frame.srcdoc = srcdoc(html);
    container.innerHTML = '';
    container.appendChild(frame);
    return frame;
  }

  function print(frame) {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ type: PRINT_MSG }, '*');
  }

  function fileName(title, fallback) {
    var base = String(title || fallback || 'protocol').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (base || 'protocol').slice(0, 120) + '.html';
  }

  function download(html, name) {
    var url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = name || 'protocol.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ── Firestore ───────────────────────────────────────────────────── */

  function chunkId(rev, n) { return 'r' + rev + '-' + n; }

  /* Write a file as revision `rev` of protocols/{id}. The protocol doc
   * must already exist (the rules check its owner). Returns the
   * html_file record to store on the doc. */
  async function writeRevision(db, protocolId, rev, html, info) {
    info = info || {};
    var parts = split(html);
    var col = db.collection('protocols').doc(protocolId).collection('html');
    var batch = db.batch();
    parts.forEach(function (data, n) {
      batch.set(col.doc(chunkId(rev, n)), { rev: rev, n: n, data: data });
    });
    await batch.commit();
    return {
      rev: rev,
      chunks: parts.length,
      size: byteSize(html),
      name: info.name || '',
      uploaded_at: new Date().toISOString(),
      uploaded_by: info.uid || '',
      uploaded_by_name: info.userName || '',
    };
  }

  async function readRevision(db, protocolId, file) {
    if (!file || !(file.chunks > 0)) throw new Error('This protocol has no file.');
    var col = db.collection('protocols').doc(protocolId).collection('html');
    var snaps = await Promise.all(Array.from({ length: file.chunks }, function (_, n) {
      return col.doc(chunkId(file.rev, n)).get();
    }));
    return snaps.map(function (s, n) {
      if (!s.exists) throw new Error('Part ' + (n + 1) + ' of the file is missing.');
      return (s.data() || {}).data || '';
    }).join('');
  }

  /* A new protocol made from a file: the doc first (the chunks' rule reads
   * its owner), then the file. `fields` are protocolEmptyDoc's options. */
  async function createProtocol(db, fields, html, info) {
    var doc = window.ProtocolSchemas.protocolEmptyDoc(fields);
    doc.kind = 'html';
    doc.tags = Array.isArray(fields.tags) ? fields.tags : [];
    doc.html_file = null;
    doc.html_revisions = [];
    var ref = db.collection('protocols').doc(fields.id);
    await ref.set(doc);
    var file;
    try {
      file = await writeRevision(db, fields.id, 1, html, info);
    } catch (err) {
      // never leave a protocol with no file behind
      try { await ref.delete(); } catch (e) { /* the error below says what happened */ }
      throw err;
    }
    await ref.update({ html_file: file, updated_at: new Date().toISOString() });
    doc.html_file = file;
    return doc;
  }

  /* Replace the file: a new revision; the one it replaces moves to
   * html_revisions (newest first) and stays downloadable. */
  async function replaceFile(db, protocolId, doc, html, info) {
    var prev = doc.html_file || null;
    var rev = Math.max(prev ? prev.rev : 0, 0, (doc.html_revisions || []).reduce(function (m, r) {
      return Math.max(m, r && r.rev || 0);
    }, 0)) + 1;
    var file = await writeRevision(db, protocolId, rev, html, info);
    var revisions = (prev ? [prev] : []).concat(doc.html_revisions || []);
    var update = { html_file: file, html_revisions: revisions, updated_at: new Date().toISOString() };
    await db.collection('protocols').doc(protocolId).update(update);
    return update;
  }

  window.ProtocolHtml = {
    CHUNK: CHUNK,
    MAX_BYTES: MAX_BYTES,
    SANDBOX: SANDBOX,
    byteSize: byteSize,
    fmtSize: fmtSize,
    split: split,
    describe: describe,
    warnings: warnings,
    srcdoc: srcdoc,
    mountFrame: mountFrame,
    print: print,
    fileName: fileName,
    download: download,
    writeRevision: writeRevision,
    readRevision: readRevision,
    createProtocol: createProtocol,
    replaceFile: replaceFile,
  };
})();
