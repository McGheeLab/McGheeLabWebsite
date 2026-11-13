/* protocol-publish.js — V3.986: post a protocol on the lab website.
 *
 * RM is where protocols come in and get described — written or imported
 * here, tagged and summarised in the editor's sidebar, and credited to
 * the people who made them in the dialog below. The public site is where
 * they are shown (mcgheelab.com → Research → Protocols); nothing public
 * is served from RM.
 *
 * "Post to website" copies a SNAPSHOT of a protocol to the public
 * collection that site reads:
 *
 *   publicProtocols/{id}                  the card — title, summary, tags,
 *                                         contributors, dates, version
 *   publicProtocols/{id}/content/current  { tree } — the document itself
 *
 * (firestore.rules V3.986: public read; the protocol's owner or an admin
 * writes.) The card and the tree are separate docs so the Protocols list
 * and the Team page read the cards without downloading every protocol.
 *
 * It is a copy, like research-publish.js's publicFoci: a visitor reads
 * what was posted, and later edits stay in the lab until the owner
 * presses "Update the public copy". Since V3.986 the working doc
 * protocols/{id} is lab-only whatever its status.
 *
 * What the copy leaves behind:
 *   - Lab inventory links. A visitor cannot read the lab's inventory, so
 *     a materials row's item_ref becomes the item's label (name, vendor,
 *     catalog number, CAS) and an [!inv:id] chip in prose becomes the
 *     item's name. Stock levels never leave the lab.
 *   - Internal bookkeeping: block / section review status, storage paths,
 *     owner uid, forks, linked buckets.
 *
 * Contributors ("who helped make it") are lab members picked in the
 * dialog. They are saved on the working doc (protocols/{id}.contributors)
 * so the next post remembers them, and on the card as contributors[] +
 * contributor_uids[] — the Team page gives each of them a protocols icon.
 *
 * `status: 'published'` on the working doc now means exactly "on the lab
 * website": posting sets it, removing clears it, and the editor's status
 * menu goes through this dialog for both.
 *
 * V3.987 — a protocol can be an HTML file (protocol-html.js). Its copy is
 * the file itself, split into content/html-{n} pieces next to
 * content/current {kind:'html', html_chunks}; the card says kind 'html'
 * and how many pieces there are, so taking it down removes them all.
 *
 * Globals: window.PROTOCOL_PUBLISH. Needs firebridge; uses
 * window.PROTOCOL_INVENTORY when it is loaded (the editor loads it) and
 * window.ProtocolHtml for HTML protocols.
 */
(function () {
  'use strict';

  var COLLECTION = 'publicProtocols';
  var CONTENT_DOC = 'current';
  var SITE = 'https://mcgheelab.com';
  var INV_RE = /\[!inv:([a-zA-Z0-9][a-zA-Z0-9_-]*)\]/g;
  var UNKNOWN = '?';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* A posted protocol's page on the public site: the address to cite or
   * share, and the link to open it from here. On the dev server the link
   * stays on that server; anywhere else (the live site, the phone app,
   * whose RM is bundled without the public site) it is the real one. */
  function shareUrl(id) { return SITE + '/#/protocols/' + encodeURIComponent(id); }
  function viewerPath(id) {
    var local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    return local ? '/#/protocols/' + encodeURIComponent(id) : shareUrl(id);
  }

  /* ── The public copy ───────────────────────────────────────────── */

  function findItem(id) {
    var INV = window.PROTOCOL_INVENTORY;
    return (id && INV && INV.findById) ? INV.findById(id) : null;
  }

  function newReport() { return { resolved: 0, unresolved: [], steps: 0 }; }

  /* [!inv:id] → the item's name. An id the inventory no longer has
   * reads "?", as it does in the lab's own document view. */
  function resolveText(s, report) {
    if (typeof s !== 'string' || s.indexOf('[!inv:') < 0) return s;
    return s.replace(INV_RE, function (m, id) {
      var entry = findItem(id);
      if (!entry || !entry.name) { report.unresolved.push(id); return UNKNOWN; }
      report.resolved++;
      return entry.name;
    });
  }

  /* Copy any JSON value, resolving inventory chips in every string
   * (table cells, kv terms, timeline labels, calculator descriptions). */
  function deepCopy(v, report) {
    if (typeof v === 'string') return resolveText(v, report);
    if (Array.isArray(v)) return v.map(function (x) { return deepCopy(x, report); });
    if (v && typeof v === 'object') {
      var out = {};
      Object.keys(v).forEach(function (k) {
        if (v[k] !== undefined) out[k] = deepCopy(v[k], report);
      });
      return out;
    }
    return v;
  }

  /* A materials row: the linked item's full label replaces the link. */
  function publicRow(r, report) {
    var out = deepCopy(r || {}, report);
    var ref = out.item_ref;
    delete out.item_ref;
    if (ref) {
      var entry = findItem(ref);
      if (entry) {
        out.free_text = window.PROTOCOL_INVENTORY.formatLabel(entry);
        report.resolved++;
      } else if (!String(out.free_text || '').trim()) {
        out.free_text = UNKNOWN;
        report.unresolved.push(ref);
      }
    }
    return out;
  }

  function publicBlock(b, report) {
    var attrs = deepCopy(b.attrs || {}, report);
    if (b.kind === 'materials') {
      attrs.rows = (((b.attrs || {}).rows) || []).map(function (r) { return publicRow(r, report); });
    }
    if (b.kind === 'figure') {
      delete attrs.storage_path;
      delete attrs.hash;
      delete attrs.mime;
    }
    if (b.kind === 'step') report.steps++;
    return { id: b.id || '', kind: b.kind || 'step', body: resolveText(b.body || '', report), attrs: attrs };
  }

  function publicTree(tree, report) {
    return {
      meta: { title: (tree && tree.meta && tree.meta.title) || '' },
      sections: ((tree && tree.sections) || []).map(function (sec, i) {
        return {
          id: sec.id || '',
          label: sec.label || '',
          order: (typeof sec.order === 'number') ? sec.order : i,
          children: (sec.children || []).filter(Boolean).map(function (b) { return publicBlock(b, report); }),
        };
      }),
    };
  }

  /* [{uid, name}] — one row per person, nobody without a name (a public
   * page never falls back to an email address or a uid). */
  function normalizePeople(list) {
    var seen = {};
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (p) {
      var uid = p && String(p.uid || '').trim();
      var name = p && String(p.name || '').trim();
      if (!uid || !name || seen[uid]) return;
      seen[uid] = 1;
      out.push({ uid: uid, name: name });
    });
    return out;
  }

  function bylineOf(people) {
    return people.map(function (p) { return p.name; }).join(', ');
  }

  /* Build the public docs from the working doc. Pure apart from the
   * inventory lookup; `prev` is the card already posted, if any, so the
   * first-posted date survives an update. `html` (V3.987): the file of an
   * HTML protocol — then `tree` is ignored and `chunks` holds its pieces. */
  function buildPublic(protocolId, doc, tree, contributors, prev, html) {
    doc = doc || {};
    var isHtml = typeof html === 'string';
    var report = newReport();
    var pubTree = isHtml ? null : publicTree(tree, report);
    var people = normalizePeople(contributors);
    var now = new Date().toISOString();
    var chunks = isHtml ? window.ProtocolHtml.split(html) : [];
    var card = {
      id: protocolId,
      kind: isHtml ? 'html' : 'blocks',
      title: doc.title || (pubTree && pubTree.meta.title) || '(untitled protocol)',
      summary: doc.summary || '',
      category: doc.category || '',
      tags: Array.isArray(doc.tags) ? doc.tags.filter(Boolean).map(String) : [],
      contributors: people,
      contributor_uids: people.map(function (p) { return p.uid; }),
      byline: bylineOf(people),
      version: isHtml ? ((doc.html_file && doc.html_file.rev) || 1)
        : ((typeof doc.current_version === 'number') ? doc.current_version : 0),
      step_count: isHtml ? 0 : report.steps,
      created_at: doc.created_at || '',
      published_at: (prev && prev.published_at) || now,
      updated_at: now,
      schema_version: 1,
    };
    if (isHtml) {
      card.html_chunks = chunks.length;
      card.html_size = window.ProtocolHtml.byteSize(html);
    }
    return {
      card: card,
      content: isHtml
        ? { kind: 'html', html_chunks: chunks.length, updated_at: now, schema_version: 1 }
        : { kind: 'blocks', tree: pubTree, updated_at: now, schema_version: 1 },
      chunks: chunks,
      report: report,
    };
  }

  /* How many html-{n} pieces a posted copy has (0 for blocks). */
  function postedChunks(card) {
    return (card && card.html_chunks > 0) ? card.html_chunks : 0;
  }

  /* What posting would do to the inventory links, without writing. */
  function inspect(tree) {
    var report = newReport();
    publicTree(tree, report);
    return report;
  }

  async function ensureInventory() {
    var INV = window.PROTOCOL_INVENTORY;
    if (INV && INV.ensureList) { try { await INV.ensureList(); } catch (e) { /* links read "?" */ } }
  }

  /* ── Firestore ─────────────────────────────────────────────────── */

  function db() { return firebridge.db(); }
  function cardRef(id) { return db().collection(COLLECTION).doc(id); }

  async function getPublic(protocolId) {
    var snap = await cardRef(protocolId).get();
    return snap.exists ? snap.data() : null;
  }

  /* Post, or update the public copy. `src` is the protocol's tree, or
   * {html: '…'} for an HTML protocol. Returns { card, report, update }
   * where `update` is what was written to the working doc. One batch, so
   * a visitor never sees half a file. */
  async function publish(protocolId, doc, src, contributors) {
    var html = (src && typeof src.html === 'string') ? src.html : null;
    if (html === null) await ensureInventory();
    if (html !== null && window.ProtocolHtml.byteSize(html) > window.ProtocolHtml.MAX_BYTES) {
      throw new Error('The file is larger than ' + window.ProtocolHtml.fmtSize(window.ProtocolHtml.MAX_BYTES) + '.');
    }
    var prev = null;
    try { prev = await getPublic(protocolId); } catch (e) { /* first post */ }
    var built = buildPublic(protocolId, doc, html === null ? src : null, contributors, prev, html === null ? undefined : html);
    var ref = cardRef(protocolId);
    var content = ref.collection('content');
    var batch = db().batch();
    batch.set(ref, built.card);
    batch.set(content.doc(CONTENT_DOC), built.content);
    built.chunks.forEach(function (data, n) { batch.set(content.doc('html-' + n), { n: n, data: data }); });
    // a shorter file than last time: drop the pieces it no longer has
    for (var k = built.chunks.length; k < postedChunks(prev); k++) batch.delete(content.doc('html-' + k));
    try { await batch.commit(); }
    catch (err) { err.step = 'writing the public copy'; throw err; }
    var update = {
      status: 'published',
      published_at: built.card.published_at,
      public_updated_at: built.card.updated_at,
      // V3.989 — same instant as the copy, so the list sees the change and
      // the protocol does not read as "edited since it was posted"
      updated_at: built.card.updated_at,
      contributors: built.card.contributors,
    };
    try { await db().collection('protocols').doc(protocolId).update(update); }
    catch (err) { err.step = 'marking the protocol as posted (the public copy is up)'; throw err; }
    return { card: built.card, report: built.report, update: update };
  }

  /* Take the public copy down. Used on its own by the list page before
   * it deletes a protocol — the rules check ownership on the working
   * doc, so this has to run while that doc still exists. */
  async function removePublicCopy(protocolId) {
    var ref = cardRef(protocolId);
    var prev = null;
    try { prev = await getPublic(protocolId); } catch (e) { /* removed below anyway */ }
    var batch = db().batch();
    for (var k = 0; k < postedChunks(prev); k++) batch.delete(ref.collection('content').doc('html-' + k));
    batch.delete(ref.collection('content').doc(CONTENT_DOC));
    batch.delete(ref);
    await batch.commit();
  }

  async function unpublish(protocolId, nextStatus) {
    await removePublicCopy(protocolId);
    var update = {
      status: (nextStatus && nextStatus !== 'published') ? nextStatus : 'draft',
      published_at: null,
      public_updated_at: null,
      updated_at: new Date().toISOString(),   // V3.989 — the list sees the change
    };
    await db().collection('protocols').doc(protocolId).update(update);
    return update;
  }

  /* ── The dialog (protocol editor) ──────────────────────────────── */

  var CATEGORY_LABELS = {
    pi: 'PI', postdoc: 'Postdoc', grad: 'Graduate', masters: 'Masters',
    undergrad: 'Undergraduate', highschool: 'High school', alumni: 'Alumni',
  };

  function day(iso) { return iso ? String(iso).slice(0, 10) : ''; }

  function isEditedSince(doc) {
    return !!(doc && doc.status === 'published' && doc.public_updated_at &&
      doc.updated_at && doc.updated_at > doc.public_updated_at);
  }

  function denied(err) {
    return !!err && (err.code === 'permission-denied' ||
      /insufficient permissions/i.test(String(err.message || '')));
  }
  /* V3.989 — says which step failed and the database's own reason, so a
   * failure can be reported in a sentence instead of reproduced. */
  function errorText(err, doing) {
    var detail = ' [' + ((err && err.step) ? err.step + ': ' : '') +
      ((err && err.code) || 'error') + (err && err.message ? ' — ' + err.message : '') + ']';
    if (denied(err)) {
      return 'The website would not accept this. Only the protocol’s owner or the PI can ' + doing +
        '. If that is you, the website’s rules for protocols may not be live yet — ask Alex.' + detail;
    }
    return 'That did not work.' + detail;
  }

  /* opts: {
   *   protocolId, button, statusSelect,
   *   getDoc()      → the working doc the editor holds (kept up to date)
   *   canEdit()     → owner or admin, not a historical view
   *   getTree()     → Promise<plain tree>, pending edits flushed first
   *   getHtml()     → Promise<string> — the file, for an HTML protocol
   *   loadRoster()  → Promise<[lab member]>
   *   onChanged(update) → merge what was written into the editor's doc
   * }
   * Returns { refresh(), open(), interceptStatus(next) }. */
  function attachEditor(opts) {
    var id = opts.protocolId;
    var btn = opts.button;
    var modal = null;
    var els = {};
    var view = { pub: null, roster: [], busy: false };

    function doc() { return opts.getDoc() || {}; }

    /* The topbar button says where the protocol stands. */
    function refresh() {
      if (!btn) return;
      var d = doc();
      var posted = d.status === 'published';
      var can = !!opts.canEdit();
      btn.hidden = !can && !posted;
      btn.disabled = false;
      btn.classList.toggle('prp-live', posted);
      var stale = isEditedSince(d);
      btn.classList.toggle('prp-stale', can && stale);
      if (!posted) {
        ICON.label(btn, 'globe-alt', ' Post to website');
        btn.title = 'Post this protocol on the lab website, for anyone to read';
      } else if (can && stale) {
        ICON.label(btn, 'globe-alt', ' Update website');
        btn.title = 'Edited since it was posted — the website still shows the older copy';
      } else {
        ICON.label(btn, 'globe-alt', ' On website');
        btn.title = can ? 'This protocol is on the lab website' : 'Open this protocol on the lab website';
      }
    }

    function build() {
      if (modal) return;
      modal = document.createElement('div');
      modal.className = 'pb-modal prp-modal';
      modal.hidden = true;
      modal.innerHTML =
        '<div class="pb-modal-card">' +
          '<div class="pb-modal-header">' +
            '<h2 id="prp-title">Post on the lab website</h2>' +
            '<button class="pb-icon-btn" id="prp-close" aria-label="Close">×</button>' +
          '</div>' +
          '<div class="pb-modal-body">' +
            '<div class="prp-state" id="prp-state"></div>' +
            '<p class="prp-hint">Anyone can read a posted protocol at mcgheelab.com, under ' +
              'Research → Protocols, without signing in. The website shows a copy taken when ' +
              'you post: what you change afterwards stays in the lab until you update the copy.</p>' +
            '<div class="form-group">' +
              '<label>Who helped make it</label>' +
              '<div class="prp-people" id="prp-people"></div>' +
              '<small class="form-hint">They are named on the public protocol, and each of them ' +
                'gets a protocols icon on the Team page.</small>' +
            '</div>' +
            '<div class="form-group">' +
              '<label>How it will be listed</label>' +
              '<div class="prp-card" id="prp-card"></div>' +
              '<small class="form-hint" id="prp-card-hint"></small>' +
            '</div>' +
            '<div class="prp-notes" id="prp-notes"></div>' +
            '<div class="pb-modal-error" id="prp-error" hidden></div>' +
          '</div>' +
          '<div class="pb-modal-actions">' +
            '<button class="btn prp-remove" id="prp-remove" hidden>Remove from website</button>' +
            '<button class="btn" id="prp-cancel">Close</button>' +
            '<button class="btn btn-primary" id="prp-go">Post to website</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);
      ['title', 'close', 'state', 'people', 'card', 'card-hint', 'notes', 'error', 'remove', 'cancel', 'go'].forEach(function (k) {
        els[k] = modal.querySelector('#prp-' + k);
      });
      els.close.addEventListener('click', close);
      els.cancel.addEventListener('click', close);
      modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && modal && !modal.hidden && !view.busy) close();
      });
      els.go.addEventListener('click', doPublish);
      els.remove.addEventListener('click', function () { doRemove('draft'); });
    }

    function close() { if (modal && !view.busy) modal.hidden = true; }

    function showError(text) {
      els.error.textContent = text || '';
      els.error.hidden = !text;
    }

    function setBusy(on, label) {
      view.busy = on;
      els.go.disabled = on;
      els.remove.disabled = on;
      if (on && label) els.go.textContent = label;
    }

    /* People already on the protocol stay ticked; a protocol nobody has
     * been picked for starts with its author. */
    function renderPeople() {
      var d = doc();
      var saved = normalizePeople(d.contributors);
      var ticked = {};
      if (saved.length) saved.forEach(function (p) { ticked[p.uid] = 1; });
      else if (d.author_uid) ticked[d.author_uid] = 1;

      var rows = view.roster.map(function (u) {
        return { uid: u.uid, name: u.name, sub: CATEGORY_LABELS[u.category] || '' };
      });
      // someone picked earlier who has since left the roster keeps their place
      var listed = {};
      rows.forEach(function (r) { listed[r.uid] = 1; });
      saved.forEach(function (p) {
        if (!listed[p.uid]) rows.push({ uid: p.uid, name: p.name, sub: 'no longer on the roster' });
      });
      // the author first, then everyone by name
      rows.sort(function (a, b) {
        var aa = a.uid === d.author_uid ? 0 : 1;
        var bb = b.uid === d.author_uid ? 0 : 1;
        return aa - bb || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });

      if (!rows.length) {
        els.people.innerHTML = '<div class="prp-people-empty">The lab roster did not load. ' +
          'You can still post; add the people later with “Update the public copy”.</div>';
        return;
      }
      var can = !!opts.canEdit();
      els.people.innerHTML = rows.map(function (r) {
        return '<label class="prp-person">' +
          '<input type="checkbox" value="' + esc(r.uid) + '" data-name="' + esc(r.name) + '"' +
            (ticked[r.uid] ? ' checked' : '') + (can ? '' : ' disabled') + '>' +
          '<span class="prp-person-name">' + esc(r.name) + '</span>' +
          (r.uid === d.author_uid ? '<span class="prp-person-sub">author</span>'
            : (r.sub ? '<span class="prp-person-sub">' + esc(r.sub) + '</span>' : '')) +
        '</label>';
      }).join('');
    }

    function pickedPeople() {
      var out = [];
      els.people.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
        out.push({ uid: cb.value, name: cb.dataset.name || '' });
      });
      return out;
    }

    function renderState() {
      var d = doc();
      var pub = view.pub;
      var can = !!opts.canEdit();
      showError('');
      if (pub) {
        var edited = isEditedSince(d);
        els.title.textContent = 'On the lab website';
        els.state.className = 'prp-state ' + (edited ? 'prp-state-stale' : 'prp-state-live');
        els.state.innerHTML =
          '<strong>' + (edited ? 'The website shows an older copy.' : 'This protocol is on the lab website.') + '</strong> ' +
          'Posted ' + esc(day(pub.published_at)) +
          (day(pub.updated_at) !== day(pub.published_at) ? ', copy updated ' + esc(day(pub.updated_at)) : '') +
          (edited ? '. You have edited it since.' : '.') +
          // the address to cite or share; the link opens the public page
          '<a class="prp-link" href="' + esc(viewerPath(id)) + '" target="_blank" rel="noopener" ' +
            'title="Open the public page">' + esc(shareUrl(id)) + ' ' +
            ICON.svg('arrow-top-right-on-square') + '</a>';
        els.go.textContent = 'Update the public copy';
        els.remove.hidden = !can;
      } else {
        els.title.textContent = 'Post on the lab website';
        els.state.className = 'prp-state';
        els.state.innerHTML = '';
        els.go.textContent = 'Post to website';
        els.remove.hidden = true;
      }
      els.go.hidden = !can;
    }

    /* The card a visitor will see in the list — the metadata RM holds
     * for this protocol. Visitors search the summary and filter by tag,
     * so a protocol without them is hard to find; say so here. */
    function renderCard() {
      var d = doc();
      els['card-hint'].textContent = 'The title, summary and tags come from this protocol. Change them ' +
        (d.kind === 'html' ? 'under Details' : 'in the editor (the summary and tags are in the left sidebar)') +
        ', then post or update.';
      var tags = (Array.isArray(d.tags) ? d.tags : []).filter(Boolean);
      els.card.innerHTML =
        '<div class="prp-card-title">' + esc(d.title || '(untitled protocol)') + '</div>' +
        (String(d.summary || '').trim()
          ? '<div class="prp-card-summary">' + esc(d.summary) + '</div>'
          : '<div class="prp-card-missing">No summary yet. Visitors see it under the title and search it.</div>') +
        (tags.length
          ? '<div class="prp-card-tags">' + tags.map(function (t) {
              return '<span class="prp-card-tag">' + esc(t) + '</span>';
            }).join('') + '</div>'
          : '<div class="prp-card-missing">No tags yet. Visitors filter the list by tag.</div>');
    }

    async function renderNotes() {
      els.notes.innerHTML = '';
      if (!opts.canEdit()) return;
      if (doc().kind === 'html') {
        try {
          var html = await opts.getHtml();
          renderCard();
          var H = window.ProtocolHtml;
          var notes = ['<div>The file is posted as it is (' + esc(H.fmtSize(H.byteSize(html))) +
            '). It runs in a closed frame on the website: its calculators work, and it cannot reach ' +
            'anything else on the site.</div>'];
          H.warnings(html).forEach(function (w) {
            notes.push('<div class="prp-warn">' + ICON.svg('exclamation-triangle') + ' ' + esc(w) + '</div>');
          });
          els.notes.innerHTML = notes.join('');
        } catch (e) { /* posting reports its own errors */ }
        return;
      }
      try {
        await ensureInventory();
        var report = inspect(await opts.getTree());
        renderCard();   // getTree flushed any pending sidebar edits
        var bits = [];
        if (report.resolved) {
          bits.push('<div>' + report.resolved + ' link' + (report.resolved === 1 ? '' : 's') +
            ' to the lab inventory will read as the item’s name, vendor and catalog number. ' +
            'Stock levels are not shown.</div>');
        }
        if (report.unresolved.length) {
          bits.push('<div class="prp-warn">' + ICON.svg('exclamation-triangle') + ' ' +
            report.unresolved.length + ' inventory link' + (report.unresolved.length === 1 ? '' : 's') +
            ' could not be matched to an item and will read “?”. Fix them in the protocol first, ' +
            'or post and update later.</div>');
        }
        if (!report.steps) {
          bits.push('<div class="prp-warn">' + ICON.svg('exclamation-triangle') +
            ' This protocol has no steps yet.</div>');
        }
        els.notes.innerHTML = bits.join('');
      } catch (e) { /* the notes are a courtesy; posting reports its own errors */ }
    }

    async function open() {
      build();
      modal.hidden = false;
      view.pub = null;
      els.people.innerHTML = '<div class="prp-people-empty">Loading the lab roster…</div>';
      els.card.innerHTML = '';
      els.notes.innerHTML = '';
      els.state.className = 'prp-state';
      els.state.textContent = 'Checking the website…';
      els.go.hidden = true;
      els.remove.hidden = true;
      showError('');

      var loaded = await Promise.all([
        getPublic(id).catch(function () { return null; }),
        opts.loadRoster().catch(function () { return []; }),
      ]);
      view.pub = loaded[0];
      // V3.989 — a lab member's record is keyed by its document id; it has
      // no `uid` field (neither sign-up path writes one). Reading only u.uid
      // dropped everyone and the dialog said the roster did not load.
      view.roster = (loaded[1] || [])
        .map(function (u) { return u ? Object.assign({}, u, { uid: u.uid || u.id }) : u; })
        .filter(function (u) { return u && u.uid && String(u.name || '').trim(); });
      renderState();
      renderPeople();
      renderCard();
      renderNotes();
    }

    async function doPublish() {
      if (view.busy || !opts.canEdit()) return;
      showError('');
      var wasPosted = !!view.pub;
      setBusy(true, wasPosted ? 'Updating…' : 'Posting…');
      try {
        var src = doc().kind === 'html' ? { html: await opts.getHtml() } : await opts.getTree();
        var res = await publish(id, doc(), src, pickedPeople());
        opts.onChanged(res.update);
        if (opts.statusSelect) opts.statusSelect.value = 'published';
        view.pub = res.card;
        setBusy(false);
        renderState();
        renderPeople();
        refresh();
        if (typeof toast === 'function') toast(wasPosted ? 'Public copy updated' : 'Posted on the lab website');
      } catch (err) {
        console.error('[protocol-publish] post failed:', err);
        setBusy(false);
        renderState();
        showError(errorText(err, 'post it'));
      }
    }

    async function doRemove(nextStatus) {
      if (view.busy || !opts.canEdit()) return false;
      if (!window.confirm('Remove “' + (doc().title || id) + '” from the lab website?\n\n' +
          'The public page and its link stop working. The protocol itself stays in the lab, ' +
          'and you can post it again.')) return false;
      if (modal) showError('');
      if (modal) setBusy(true);
      try {
        var update = await unpublish(id, nextStatus);
        opts.onChanged(update);
        if (opts.statusSelect) opts.statusSelect.value = update.status;
        view.pub = null;
        if (modal) { setBusy(false); renderState(); }
        refresh();
        if (typeof toast === 'function') toast('Removed from the lab website');
        return true;
      } catch (err) {
        console.error('[protocol-publish] remove failed:', err);
        if (modal) { setBusy(false); renderState(); }
        var text = errorText(err, 'remove it');
        if (modal && !modal.hidden) showError(text); else window.alert(text);
        return false;
      }
    }

    /* The status menu. 'published' is the website, so choosing it opens
     * this dialog and leaving it takes the protocol down; either way the
     * menu snaps back until the write has happened. Returns true when it
     * handled the change (the editor then skips its plain save). */
    function interceptStatus(next) {
      var prev = doc().status || 'draft';
      if (next === 'published' && prev !== 'published') {
        opts.statusSelect.value = prev;
        open();
        return true;
      }
      if (prev === 'published' && next !== 'published') {
        opts.statusSelect.value = prev;
        doRemove(next);
        return true;
      }
      return false;
    }

    if (btn) {
      btn.addEventListener('click', function () {
        if (!opts.canEdit()) { window.open(viewerPath(id), '_blank', 'noopener'); return; }
        open();
      });
    }
    refresh();

    return { refresh: refresh, open: open, interceptStatus: interceptStatus };
  }

  window.PROTOCOL_PUBLISH = {
    COLLECTION: COLLECTION,
    viewerPath: viewerPath,
    shareUrl: shareUrl,
    buildPublic: buildPublic,
    inspect: inspect,
    isEditedSince: isEditedSince,
    getPublic: getPublic,
    publish: publish,
    unpublish: unpublish,
    removePublicCopy: removePublicCopy,
    attachEditor: attachEditor,
  };
})();
